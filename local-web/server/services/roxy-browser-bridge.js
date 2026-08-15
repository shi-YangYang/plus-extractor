"use strict";

const { execFileSync, spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { AppError } = require("../lib/errors");

const DEFAULT_INSPECTOR_HOST = "127.0.0.1";
const DEFAULT_INSPECTOR_PORT = 9238;
const DEFAULT_ROXY_START_TIMEOUT_MS = 45_000;
const DEFAULT_ROXY_START_POLL_MS = 500;
const ROXY_RENDERER_ORIGIN = "https://app.roxybrowser.com/";
const DIR_ID_PATTERN = /^[a-f0-9]{32}$/i;
const ROXY_PROXY_CATEGORIES = Object.freeze({
  http: "HTTP",
  https: "HTTPS",
  socks4: "SOCKS4",
  socks5: "SOCKS5"
});
const DEFAULT_ROXY_PROXY_CHECK_CHANNEL = "http://api.ip2location.io/";
const ROXY_CONTROL_GATEWAY_FALLBACKS = Object.freeze([
  "gate.roxybrowser.net",
  "sg.gate.roxybrowser.net",
  "us.gate.roxybrowser.net"
]);

function normalizeRoxyProxy(proxy = {}) {
  const scheme = String(proxy.scheme || "").trim().toLowerCase();
  const proxyCategory = ROXY_PROXY_CATEGORIES[scheme];
  const host = String(proxy.host || "").trim();
  const port = Number(proxy.port);
  if (!proxyCategory || !host || /\s/.test(host)
      || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AppError(400, "ROXY_PROXY_INVALID", "The selected JP registration proxy cannot be converted to a RoxyBrowser profile proxy.");
  }
  return Object.freeze({
    host,
    port: String(port),
    proxyUserName: String(proxy.username || ""),
    proxyPassword: String(proxy.password || ""),
    ipType: host.includes(":") ? "IPV6" : "IPV4",
    protocol: proxyCategory,
    proxyCategory,
    refreshUrl: ""
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function executableFromRegistryValue(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) return "";
  const quoted = value.match(/^"([^"]+)"/);
  const filePath = quoted ? quoted[1] : value.replace(/\s+\/(?:allusers|S).*$/i, "").trim();
  if (!filePath) return "";
  const fileName = path.basename(filePath).toLowerCase();
  return fileName === "roxybrowser.exe"
    ? filePath
    : path.join(path.dirname(filePath), "RoxyBrowser.exe");
}

function registryRoxyBrowserCandidates(queryRegistry = execFileSync) {
  if (process.platform !== "win32") return [];
  const roots = [
    "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall"
  ];
  const candidates = [];
  for (const root of roots) {
    let output;
    try {
      output = queryRegistry("reg.exe", ["query", root, "/s", "/f", "RoxyBrowser"], {
        encoding: "buffer",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"]
      });
    } catch {
      continue;
    }
    const decodedOutputs = Buffer.isBuffer(output)
      ? [output.toString("utf8"), new TextDecoder("gbk").decode(output)]
      : [String(output || "")];
    for (const decoded of decodedOutputs) {
      for (const line of decoded.split(/\r?\n/)) {
        const match = line.match(/^\s+(?:UninstallString|DisplayIcon)\s+REG_\w+\s+(.+)$/i);
        const candidate = executableFromRegistryValue(match && match[1]);
        if (candidate) candidates.push(candidate);
      }
    }
  }
  return candidates;
}

function resolveRoxyBrowserExecutable(options = {}) {
  const environment = options.environment || process.env;
  const exists = options.exists || existsSync;
  const candidates = [
    options.executablePath,
    environment.ROXY_BROWSER_EXECUTABLE,
    environment.LOCALAPPDATA && path.join(environment.LOCALAPPDATA, "Programs", "RoxyBrowser", "RoxyBrowser.exe"),
    environment.PROGRAMFILES && path.join(environment.PROGRAMFILES, "RoxyBrowser", "RoxyBrowser.exe"),
    environment["PROGRAMFILES(X86)"] && path.join(environment["PROGRAMFILES(X86)"], "RoxyBrowser", "RoxyBrowser.exe"),
    ...registryRoxyBrowserCandidates(options.queryRegistry)
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = path.resolve(String(candidate));
    if (exists(resolved)) return resolved;
  }
  return "";
}

function launchRoxyBrowser(executablePath, spawnProcess = spawn) {
  const child = spawnProcess(executablePath, [], {
    cwd: path.dirname(executablePath),
    detached: true,
    stdio: "ignore",
    windowsHide: false
  });
  if (child && typeof child.unref === "function") child.unref();
  return Number(child && child.pid) || 0;
}

function profileProxyConfigurationExpression(assignments) {
  return `(async()=>{const urls=[...new Set(performance.getEntriesByType('resource').map(entry=>entry.name).filter(name=>name.startsWith(location.origin+'/assets/')))];let api=null;for(const url of urls.filter(name=>name.includes('/assets/utils-')&&name.includes('.js'))){try{const module=await import(url);if(module.h&&module.h.window&&typeof module.h.window.userMdfWindowInfoSingleV2Create==='function'){api=module.h;break}}catch{}}if(!api)return{ok:false,code:'ROXY_PROFILE_API_MODULE_MISSING',configured:0};const assignments=${JSON.stringify(assignments)};let configured=0;const previousNode=globalThis.$lastSelectedNetworkNode;const gateways=[null,...${JSON.stringify(ROXY_CONTROL_GATEWAY_FALLBACKS)}];let lastNetworkCode='UNKNOWN';try{for(const gateway of gateways){configured=0;globalThis.$lastSelectedNetworkNode=gateway?{...(previousNode&&typeof previousNode==='object'?previousNode:{}),gate:gateway}:previousNode;try{for(const assignment of assignments){const response=await api.window.userMdfWindowInfoSingleV2Create(assignment);if(Number(response&&response.code)!==0)return{ok:false,code:'UPSTREAM_'+String(response&&response.code),configured};configured+=1}return{ok:true,configured,gatewayFallback:Boolean(gateway),controlGateway:String(gateway||'')}}catch(error){const code=String(error&&error.code||'');const message=String(error&&error.message||'');const networkFailure=code==='ERR_NETWORK'||code==='ECONNRESET'||code==='ETIMEDOUT'||/Network Error|Failed to fetch|ERR_CONNECTION/i.test(message);if(!networkFailure)return{ok:false,code:'REQUEST_'+(code||'FAILED'),configured};lastNetworkCode=code||'NETWORK_ERROR'}}return{ok:false,code:'ROXY_GATEWAY_'+lastNetworkCode,configured}}finally{globalThis.$lastSelectedNetworkNode=previousNode}})()`;
}

function profileLaunchExpression(payload, controlGateway = "") {
  const gateway = ROXY_CONTROL_GATEWAY_FALLBACKS.includes(String(controlGateway || ""))
    ? String(controlGateway)
    : "";
  return `(async()=>{const gateway=${JSON.stringify(gateway)};let previous;try{if(gateway){const config=await window.electronAPI.send('app:getSoftConfig');previous=config&&config.lastSelectedNetworkNode;await window.electronAPI.send('app:saveSoftConfig',{lastSelectedNetworkNode:{...(previous&&typeof previous==='object'?previous:{}),gate:gateway}})}await ${payload};return true}finally{if(gateway)await window.electronAPI.send('app:saveSoftConfig',{lastSelectedNetworkNode:previous})}})()`;
}

function requestJson({ host, port, pathname, timeoutMs = 2_000 }) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host, port, path: pathname }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error("timeout")));
    request.once("error", reject);
  });
}

class InspectorSession {
  constructor(webSocketUrl, WebSocketImpl = globalThis.WebSocket) {
    this.webSocketUrl = webSocketUrl;
    this.WebSocketImpl = WebSocketImpl;
    this.socket = null;
    this.sequence = 0;
    this.pending = new Map();
  }

  async open() {
    if (typeof this.WebSocketImpl !== "function") {
      throw new AppError(503, "ROXY_INSPECTOR_WEBSOCKET_MISSING", "The local Node runtime does not expose WebSocket support.");
    }
    this.socket = new this.WebSocketImpl(this.webSocketUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("inspector websocket timeout")), 3_000);
      this.socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.socket.addEventListener("error", (event) => {
        clearTimeout(timer);
        reject(event && event.error || new Error("inspector websocket error"));
      }, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data || ""));
      } catch {
        return;
      }
      if (!message.id || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      pending.resolve(message);
    });
    await this.call("Runtime.enable");
  }

  call(method, params = {}, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`inspector ${method} timeout`));
      }, Math.max(1_000, Number(timeoutMs) || 10_000));
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        }
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, timeoutMs = 10_000) {
    const response = await this.call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    }, timeoutMs);
    const exception = response && response.result && response.result.exceptionDetails;
    if (exception) {
      throw new Error(exception.exception && exception.exception.description || exception.text || "inspector evaluation failed");
    }
    return response && response.result && response.result.result
      ? response.result.result.value
      : undefined;
  }

  close() {
    if (this.socket) this.socket.close();
    this.socket = null;
  }
}

class RoxyBrowserBridge {
  constructor(options = {}) {
    this.inspectorHost = options.inspectorHost || DEFAULT_INSPECTOR_HOST;
    this.inspectorPort = Number(options.inspectorPort) || DEFAULT_INSPECTOR_PORT;
    this.rendererOrigin = options.rendererOrigin || ROXY_RENDERER_ORIGIN;
    this.userDataDirectory = path.resolve(options.userDataDirectory
      || path.join(process.env.APPDATA || "", "RoxyBrowser"));
    this.profileCacheDirectory = path.join(this.userDataDirectory, "browser-cache");
    this.WebSocketImpl = options.WebSocketImpl || globalThis.WebSocket;
    this.requestJson = options.requestJson || requestJson;
    this.sleep = options.sleep || sleep;
    this.executablePath = String(options.executablePath || process.env.ROXY_BROWSER_EXECUTABLE || "").trim();
    this.resolveExecutable = options.resolveExecutable || (() => resolveRoxyBrowserExecutable({
      executablePath: this.executablePath
    }));
    this.launchExecutable = options.launchExecutable || launchRoxyBrowser;
    this.recoveryPromise = null;
    this.controlGateway = "";
  }

  async ensureReady(options = {}) {
    if (this.recoveryPromise) return this.recoveryPromise;
    this.recoveryPromise = this.recoverLocalControl(options);
    try {
      return await this.recoveryPromise;
    } finally {
      this.recoveryPromise = null;
    }
  }

  async recoverLocalControl(options = {}) {
    try {
      await this.withRenderer("true", 5_000);
      return Object.freeze({ ready: true, started: false });
    } catch (initialError) {
      let executablePath = "";
      try {
        executablePath = String(await this.resolveExecutable() || "");
      } catch (error) {
        throw new AppError(503, "ROXY_EXECUTABLE_DISCOVERY_FAILED", "RoxyBrowser installation discovery failed.", error);
      }
      if (!executablePath) {
        throw new AppError(503, "ROXY_EXECUTABLE_NOT_FOUND", "RoxyBrowser is closed and its installed executable was not found.", initialError);
      }
      try {
        await this.launchExecutable(executablePath);
      } catch (error) {
        throw new AppError(503, "ROXY_BROWSER_START_FAILED", "RoxyBrowser was found but its main process did not start.", error);
      }

      const timeoutMs = Math.max(1_000, Number(options.timeoutMs) || DEFAULT_ROXY_START_TIMEOUT_MS);
      const pollMs = Math.max(50, Number(options.pollMs) || DEFAULT_ROXY_START_POLL_MS);
      const attempts = Math.max(1, Math.ceil(timeoutMs / pollMs));
      let lastError = initialError;
      let dashboardRecoveryComplete = false;
      let networkAdjusted = false;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          await this.withRenderer("true", 5_000);
          const profiles = await this.profiles();
          if (!profiles.length) {
            throw new AppError(503, "ROXY_PROFILE_CATALOG_LOADING", "RoxyBrowser local control is ready, but the profile catalog is still loading.");
          }
          return Object.freeze({ ready: true, started: true, networkAdjusted });
        } catch (error) {
          lastError = error;
          if (!dashboardRecoveryComplete) {
            const dashboard = await this.recoverDashboardNetwork().catch(() => null);
            if (dashboard && dashboard.errorPage) {
              dashboardRecoveryComplete = true;
              networkAdjusted = dashboard.networkAdjusted === true;
            }
          }
          if (attempt + 1 < attempts) await this.sleep(pollMs);
        }
      }
      throw new AppError(503, "ROXY_BRIDGE_RECOVERY_TIMEOUT", "RoxyBrowser started, but local control did not become ready before the registration timeout.", lastError);
    }
  }

  async withInspector(expression, timeoutMs = 10_000) {
    let session;
    try {
      const targets = await this.requestJson({
        host: this.inspectorHost,
        port: this.inspectorPort,
        pathname: "/json/list"
      });
      const target = Array.isArray(targets)
        ? targets.find((candidate) => candidate && candidate.webSocketDebuggerUrl)
        : null;
      if (!target) {
        throw new AppError(503, "ROXY_INSPECTOR_TARGET_MISSING", "RoxyBrowser is open, but its local inspector target is not available.");
      }
      session = new InspectorSession(target.webSocketDebuggerUrl, this.WebSocketImpl);
      await session.open();
      return await session.evaluate(String(expression), timeoutMs);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(503, "ROXY_BRIDGE_UNAVAILABLE", "RoxyBrowser local control is not ready.", error);
    } finally {
      if (session) session.close();
    }
  }

  async withRenderer(pageExpression, timeoutMs = 10_000) {
    const expression = `(async()=>{const electron=process.getBuiltinModule('module').createRequire(process.execPath)('electron');const wc=electron.webContents.getAllWebContents().find(item=>item.getURL().startsWith(${JSON.stringify(this.rendererOrigin)}));if(!wc)throw new Error('ROXY_RENDERER_MISSING');return await wc.executeJavaScript(${JSON.stringify(String(pageExpression))},true)})()`;
    return this.withInspector(expression, timeoutMs);
  }

  async recoverDashboardNetwork() {
    const pageExpression = `(async()=>{const config=await globalThis.electronAPI.send('app:getSoftConfig');const networkAdjusted=String(config&&config.appNetwork||'')!=='system';if(networkAdjusted)await globalThis.electronAPI.send('app:saveSoftConfig',{appNetwork:'system'});await globalThis.electronAPI.send('app:testWebDomain');return{errorPage:true,networkAdjusted}})()`;
    const expression = `(async()=>{const electron=process.getBuiltinModule('module').createRequire(process.execPath)('electron');const wc=electron.webContents.getAllWebContents().find(item=>item.getURL().includes('/500.html'));if(!wc)return{errorPage:false,networkAdjusted:false};return await wc.executeJavaScript(${JSON.stringify(pageExpression)},true)})()`;
    const result = await this.withInspector(expression, 45_000);
    return Object.freeze({
      errorPage: Boolean(result && result.errorPage),
      networkAdjusted: Boolean(result && result.networkAdjusted)
    });
  }

  profileDiscoveryExpression() {
    return `(()=>{const app=document.querySelector('#app')&&document.querySelector('#app').__vue_app__;const root=app&&app._container&&app._container._vnode&&app._container._vnode.component;if(!root)return[];const rows=[];const seenComponents=new WeakSet();const seenRows=new Set();function add(component){if(!component||seenComponents.has(component))return;seenComponents.add(component);const name=component.type&&(component.type.name||component.type.__name)||'';const row=component.props&&component.props.rowData;if(name==='BodyRow'&&row&&typeof row.dirId==='string'&&!seenRows.has(row.dirId)){seenRows.add(row.dirId);rows.push({id:Number(row.id)||0,dirId:row.dirId,openStatus:Number(row.openStatus)||0,windowSortNum:Number(row.windowSortNum)||0,proxyCategory:String(row.proxyCategory||''),checkChannel:String(row.checkChannel||'')})}walk(component.subTree)}function walk(vnode){if(!vnode||typeof vnode!=='object')return;if(vnode.component)add(vnode.component);if(Array.isArray(vnode.children))for(const child of vnode.children)walk(child);if(vnode.suspense){walk(vnode.suspense.activeBranch);walk(vnode.suspense.pendingBranch)}}add(root);return rows.sort((a,b)=>a.windowSortNum-b.windowSortNum)})()`;
  }

  profileListDiscoveryExpression() {
    const discovery = this.profileDiscoveryExpression();
    return `(async()=>{const discover=()=>${discovery};if(location.pathname!='/browser/list'){const app=document.querySelector('#app')&&document.querySelector('#app').__vue_app__;const router=app&&app.config&&app.config.globalProperties&&app.config.globalProperties.$router;if(!router)return[];await router.push('/')}for(let attempt=0;attempt<30;attempt+=1){const rows=discover();if(rows.length)return rows;await new Promise(resolve=>setTimeout(resolve,200))}return discover()})()`;
  }

  async profiles() {
    const profiles = await this.withRenderer(this.profileListDiscoveryExpression());
    return Object.freeze((Array.isArray(profiles) ? profiles : [])
      .filter((profile) => DIR_ID_PATTERN.test(String(profile && profile.dirId || "")))
      .map((profile) => Object.freeze({
        id: Number(profile.id) || 0,
        dirId: String(profile.dirId),
        openStatus: Number(profile.openStatus) || 0,
        windowSortNum: Number(profile.windowSortNum) || 0,
        proxyCategory: String(profile.proxyCategory || ""),
        checkChannel: String(profile.checkChannel || "")
      })));
  }

  async configureProfileProxies(assignments = []) {
    const normalized = (Array.isArray(assignments) ? assignments : []).map((assignment) => {
      const id = Number(assignment && assignment.id);
      const dirId = String(assignment && assignment.dirId || "").trim();
      if (!Number.isSafeInteger(id) || id < 1 || !DIR_ID_PATTERN.test(dirId)) {
        throw new AppError(400, "ROXY_PROFILE_PROXY_TARGET_INVALID", "RoxyBrowser proxy assignment is missing a valid closed profile target.");
      }
      const proxy = normalizeRoxyProxy(assignment.proxy);
      const currentCategory = String(assignment.currentProxyCategory || "").trim().toLowerCase();
      return Object.freeze({
        id,
        dirId,
        moduleId: 0,
        proxyMethod: "custom",
        requestType: currentCategory && currentCategory !== "noproxy" ? "edit_proxy" : "add_proxy",
        checkChannel: String(assignment.checkChannel || "").trim() || DEFAULT_ROXY_PROXY_CHECK_CHANNEL,
        ...proxy
      });
    });
    if (!normalized.length) return Object.freeze({ configured: 0, source: "database_jp_pool" });

    const result = await this.withRenderer(profileProxyConfigurationExpression(normalized), 20_000);
    if (!result || result.ok !== true || Number(result.configured) !== normalized.length) {
      throw new AppError(
        502,
        "ROXY_PROFILE_PROXY_ASSIGNMENT_FAILED",
        `RoxyBrowser accepted ${Number(result && result.configured) || 0}/${normalized.length} JP registration proxy assignments (${String(result && result.code || "UNKNOWN")}).`
      );
    }
    this.controlGateway = ROXY_CONTROL_GATEWAY_FALLBACKS.includes(String(result.controlGateway || ""))
      ? String(result.controlGateway)
      : "";
    return Object.freeze({
      configured: normalized.length,
      source: "database_jp_pool"
    });
  }

  async openedProfiles() {
    const value = await this.withRenderer(`(async()=>{const items=await window.electronAPI.send('browser:getOpenedBrowser');return Array.isArray(items)?items.map(item=>({dirId:item&&item.dirId||''})):[]})()`);
    return Object.freeze((Array.isArray(value) ? value : [])
      .map((entry) => String(entry && entry.dirId || ""))
      .filter((dirId) => DIR_ID_PATTERN.test(dirId)));
  }

  async status() {
    try {
      const snapshot = await this.withRenderer(`(async()=>{const profiles=await ${this.profileListDiscoveryExpression()};const opened=await window.electronAPI.send('browser:getOpenedBrowser');const openedItems=Array.isArray(opened)?opened:[];const openedIds=new Set(openedItems.map(item=>String(item&&item.dirId||'')));const configuredItems=Array.isArray(profiles)?profiles.filter(profile=>{const category=String(profile&&profile.proxyCategory||'').trim().toLowerCase();return category&&category!=='noproxy'}):[];const availableConfiguredProfiles=configuredItems.filter(profile=>!openedIds.has(String(profile&&profile.dirId||''))).length;return {availableProfiles:Array.isArray(profiles)?profiles.length:0,configuredProxyProfiles:configuredItems.length,availableConfiguredProfiles,openedProfiles:openedItems.length}})()`);
      return Object.freeze({
        ready: true,
        version: "4.0.2",
        availableProfiles: Number(snapshot && snapshot.availableProfiles) || 0,
        configuredProxyProfiles: Number(snapshot && snapshot.configuredProxyProfiles) || 0,
        availableConfiguredProfiles: Number(snapshot && snapshot.availableConfiguredProfiles) || 0,
        openedProfiles: Number(snapshot && snapshot.openedProfiles) || 0,
        accountsPerWindow: 2,
        maxWindows: 15,
        profileProxyConfiguration: "existing_roxy_profile"
      });
    } catch (error) {
      return Object.freeze({
        ready: false,
        version: "",
        availableProfiles: 0,
        configuredProxyProfiles: 0,
        availableConfiguredProfiles: 0,
        openedProfiles: 0,
        accountsPerWindow: 2,
        maxWindows: 15,
        profileProxyConfiguration: "existing_roxy_profile",
        error: String(error && error.code || "ROXY_BRIDGE_UNAVAILABLE")
      });
    }
  }

  validateDirIds(dirIds) {
    const normalized = [...new Set((Array.isArray(dirIds) ? dirIds : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean))];
    if (!normalized.length || normalized.some((dirId) => !DIR_ID_PATTERN.test(dirId))) {
      throw new AppError(400, "ROXY_PROFILE_IDS_INVALID", "RoxyBrowser profile identifiers are missing or invalid.");
    }
    return normalized;
  }

  async launchProfiles(dirIds) {
    const ids = this.validateDirIds(dirIds);
    const payload = ids.length === 1
      ? `window.electronAPI.send('browser:batchLaunch',${JSON.stringify(ids)})`
      : `window.electronAPI.send('browser:chunkBrowsersByScreen',${JSON.stringify({
        dirIds: ids,
        gap: 8,
        cols: Math.min(5, ids.length),
        rows: Math.ceil(ids.length / Math.min(5, ids.length)),
        stackOffset: { x: 24, y: 24 }
      })})`;
    await this.withRenderer(profileLaunchExpression(payload, this.controlGateway));
    await Promise.all(ids.map((dirId) => this.waitForDevTools(dirId)));
    return Object.freeze({ launched: ids.length });
  }

  async closeProfiles(dirIds) {
    const ids = this.validateDirIds(dirIds);
    await this.withRenderer(`(async()=>{await window.electronAPI.send('browser:batchClose',${JSON.stringify(ids)});return true})()`);
    return Object.freeze({ closed: ids.length });
  }

  async clearProfiles(dirIds, clearType = "all") {
    const ids = this.validateDirIds(dirIds);
    const normalizedType = clearType === "partial" ? "partial" : "all";
    await this.withRenderer(`(async()=>{await window.electronAPI.send('browser:clearCache',${JSON.stringify({
      clearType: normalizedType,
      dirIds: ids
    })});return true})()`);
    return Object.freeze({ cleared: ids.length, clearType: normalizedType });
  }

  devToolsActivePortPath(dirId) {
    if (!DIR_ID_PATTERN.test(String(dirId || ""))) {
      throw new AppError(400, "ROXY_PROFILE_ID_INVALID", "RoxyBrowser profile identifier is invalid.");
    }
    return path.join(this.profileCacheDirectory, dirId, "DevToolsActivePort");
  }

  async devToolsEndpoint(dirId) {
    const contents = await fs.readFile(this.devToolsActivePortPath(dirId), "utf8");
    const [rawPort] = contents.trim().split(/\r?\n/);
    const port = Number(rawPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new AppError(502, "ROXY_DEVTOOLS_PORT_INVALID", "RoxyBrowser returned an invalid local DevTools endpoint.");
    }
    return `http://127.0.0.1:${port}`;
  }

  async waitForDevTools(dirId, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
      try {
        const endpoint = await this.devToolsEndpoint(dirId);
        await this.requestJson({
          host: "127.0.0.1",
          port: Number(new URL(endpoint).port),
          pathname: "/json/version",
          timeoutMs: 1_000
        });
        return endpoint;
      } catch (error) {
        lastError = error;
        await this.sleep(250);
      }
    }
    throw new AppError(504, "ROXY_PROFILE_LAUNCH_TIMEOUT", "RoxyBrowser profile did not expose its local DevTools endpoint in time.", lastError);
  }
}

module.exports = {
  DEFAULT_ROXY_START_POLL_MS,
  DEFAULT_ROXY_START_TIMEOUT_MS,
  DEFAULT_ROXY_PROXY_CHECK_CHANNEL,
  DEFAULT_INSPECTOR_PORT,
  DIR_ID_PATTERN,
  InspectorSession,
  ROXY_CONTROL_GATEWAY_FALLBACKS,
  RoxyBrowserBridge,
  executableFromRegistryValue,
  launchRoxyBrowser,
  normalizeRoxyProxy,
  profileLaunchExpression,
  profileProxyConfigurationExpression,
  requestJson,
  resolveRoxyBrowserExecutable
};
