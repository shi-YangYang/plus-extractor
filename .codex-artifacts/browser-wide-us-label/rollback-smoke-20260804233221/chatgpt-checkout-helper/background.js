if (typeof importScripts === "function") {
  importScripts("core.js");
}

(function initializeProxyController(root) {
  "use strict";

  const core = root.ChatGPTCheckoutCore;
  const extensionApi = root.chrome;
  const ACTIVE_PROXY_KEY = "checkoutHelperActiveProxy";
  const LAST_PROXY_ERROR_KEY = "checkoutHelperLastProxyError";
  const AUTH_ATTEMPT_LIMIT = 2;
  const PROXY_TEST_TIMEOUT_MS = 12_000;
  const EXIT_TRACE_URLS = Object.freeze({
    baseline: "https://1.1.1.1/cdn-cgi/trace",
    proxy: "https://1.0.0.1/cdn-cgi/trace"
  });
  const RELAY_CONTROL_BASE = "http://127.0.0.1:17898";
  const RELAY_REQUEST_TIMEOUT_MS = 2_000;
  const STRIPE_INIT_TIMEOUT_MS = 15_000;
  const SENTINEL_SDK_URL = "https://chatgpt.com/backend-api/sentinel/sdk.js";
  const SENTINEL_FLOW = "chatgpt_checkout";
  const SENTINEL_TIMEOUT_MS = 25_000;
  const STRIPE_API_VERSION = "2025-03-31.basil; checkout_server_update_beta=v1; checkout_manual_approval_preview=v1";
  const DEFAULT_STRIPE_PUBLISHABLE_KEY = "pk_live_51HOrSwC6h1nxGoI3lTAgRjYVrz4dU3fVOabyCcKR3pbEJguCVAlqCxdxCUvoRh1XWwRacViovU3kLKvpkjh7IqkW00iXQsjo3n";
  const authAttempts = new Map();

  if (!core || !extensionApi || !extensionApi.runtime) {
    return;
  }

  function assertTrustedSender(sender) {
    if (!sender || !sender.url) return;
    const url = new URL(sender.url);
    const hostname = url.hostname.toLowerCase();
    if (hostname !== "chatgpt.com" && !hostname.endsWith(".chatgpt.com")) {
      throw new Error("消息来源不受信任");
    }
  }

  async function getActiveProxy() {
    const stored = await extensionApi.storage.session.get(ACTIVE_PROXY_KEY);
    return stored && stored[ACTIVE_PROXY_KEY] ? stored[ACTIVE_PROXY_KEY] : null;
  }

  async function recordProxyError(error, details = {}) {
    const activeProxy = await getActiveProxy();
    if (!activeProxy) return;
    await extensionApi.storage.session.set({
      [LAST_PROXY_ERROR_KEY]: {
        phase: activeProxy.phase,
        error: core.sanitizeDiagnosticText(error, 120),
        url: core.sanitizeDiagnosticText(details.url || "", 160),
        timestamp: new Date().toISOString()
      }
    });
  }

  async function getLastProxyError() {
    const stored = await extensionApi.storage.session.get(LAST_PROXY_ERROR_KEY);
    return stored && stored[LAST_PROXY_ERROR_KEY] ? stored[LAST_PROXY_ERROR_KEY] : null;
  }

  function formatProxyConnectionError(code) {
    const value = core.sanitizeDiagnosticText(code || "网络请求失败", 120);
    if (/ERR_(CONNECTION_)?TIMED_OUT|TimeoutError/i.test(value)) {
      return `代理网关连接超时（${value}）`;
    }
    if (/ERR_PROXY_CONNECTION_FAILED|ERR_CONNECTION_REFUSED/i.test(value)) {
      return `代理网关拒绝连接或端口未开放（${value}）`;
    }
    if (/ERR_TUNNEL_CONNECTION_FAILED/i.test(value)) {
      return `代理 HTTPS CONNECT 隧道建立失败（${value}）`;
    }
    if (/ERR_PROXY_AUTH|ERR_INVALID_AUTH_CREDENTIALS|407/i.test(value)) {
      return `代理认证失败，请核对用户名、密码及地区参数（${value}）`;
    }
    return `代理连通性检查失败（${value}）`;
  }

  async function relayRequest(path, options = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), RELAY_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${RELAY_CONTROL_BASE}${path}`, {
        ...options,
        cache: "no-store",
        credentials: "omit",
        signal: controller.signal
      });
      const payload = core.parseResponseText(await response.text());
      if (!response.ok || !payload || payload.ok !== true) {
        throw new Error(payload && payload.error ? payload.error : `RELAY_HTTP_${response.status}`);
      }
      return payload;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function configureLocalRelay(proxy, phase) {
    try {
      const status = await relayRequest("/status");
      if (!status.ready) return null;
      const configured = await relayRequest("/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phase, proxy: proxy.raw })
      });
      if (!configured.configured || !configured.proxyHost || !configured.proxyPort) {
        throw new Error("LOCAL_RELAY_CONFIGURATION_FAILED");
      }
      return configured;
    } catch (error) {
      if (error && error.name === "AbortError") return null;
      if (/Failed to fetch|ECONNREFUSED|ERR_CONNECTION_REFUSED/i.test(error && error.message)) return null;
      throw error;
    }
  }

  async function clearLocalRelay() {
    try {
      await relayRequest("/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      });
    } catch {
      // Relay may already be stopped.
    }
  }

  async function recordLocalDiagnostic(event, details = {}) {
    const source = details && typeof details === "object" ? details : {};
    const sanitized = {};
    for (const key of ["shape", "requestShape", "identifiers", "route", "sessionKind", "promotion", "message"]) {
      if (typeof source[key] === "string" && source[key].trim()) {
        const limit = key === "promotion" ? 2400 : (key === "message" ? 200 : 320);
        sanitized[key] = core.sanitizeDiagnosticText(source[key], limit);
      }
    }
    if (typeof source.httpStatus === "number" && Number.isInteger(source.httpStatus)) {
      sanitized.httpStatus = source.httpStatus;
    }
    try {
      return await relayRequest("/diagnostic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event, details: sanitized })
      });
    } catch {
      return { ok: true, recorded: false };
    }
  }

  async function setActiveProxy(proxyText, phase) {
    const proxy = core.parseProxyLine(proxyText);
    if (!["create", "apply"].includes(phase)) {
      throw new TypeError("未知代理阶段");
    }

    const relay = await configureLocalRelay(proxy, phase);
    const browserProxy = relay
      ? { scheme: "http", host: relay.proxyHost, port: Number(relay.proxyPort) }
      : proxy;
    const activeProxy = {
      phase,
      scheme: proxy.scheme,
      host: proxy.host,
      port: proxy.port,
      username: proxy.username,
      password: proxy.password,
      transport: relay ? "relay" : "direct",
      relayHost: relay ? relay.proxyHost : null,
      relayPort: relay ? Number(relay.proxyPort) : null,
      activatedAt: new Date().toISOString()
    };

    await extensionApi.storage.session.remove(LAST_PROXY_ERROR_KEY);
    await extensionApi.storage.session.set({ [ACTIVE_PROXY_KEY]: activeProxy });
    try {
      await extensionApi.proxy.settings.set({
        value: {
          mode: "fixed_servers",
          rules: {
            singleProxy: {
              scheme: browserProxy.scheme,
              host: browserProxy.host,
              port: browserProxy.port
            },
            bypassList: ["localhost", "127.0.0.1", "[::1]"]
          }
        },
        scope: "regular"
      });

      const effective = await extensionApi.proxy.settings.get({ incognito: false });
      const level = effective && effective.levelOfControl;
      if (["controlled_by_other_extensions", "not_controllable"].includes(level)) {
        throw new Error(`代理设置未取得控制权（${level}）`);
      }
      if (!effective || !effective.value || effective.value.mode !== "fixed_servers") {
        throw new Error("浏览器未启用插件代理设置");
      }
    } catch (error) {
      if (relay) await clearLocalRelay();
      await extensionApi.storage.session.remove(ACTIVE_PROXY_KEY);
      throw error;
    }

    return {
      ok: true,
      active: true,
      phase,
      endpoint: core.formatProxyEndpoint(proxy),
      transport: activeProxy.transport,
      relay: relay ? `${relay.proxyHost}:${relay.proxyPort}` : null,
      activatedAt: activeProxy.activatedAt
    };
  }

  async function clearActiveProxy() {
    await clearLocalRelay();
    await extensionApi.proxy.settings.clear({ scope: "regular" });
    await extensionApi.storage.session.remove([ACTIVE_PROXY_KEY, LAST_PROXY_ERROR_KEY]);
    authAttempts.clear();
    return { ok: true, active: false };
  }

  function parseExitTrace(text) {
    const fields = {};
    for (const line of String(text || "").trim().split(/\r?\n/)) {
      const separator = line.indexOf("=");
      if (separator <= 0) continue;
      fields[line.slice(0, separator)] = line.slice(separator + 1);
    }
    return {
      exitIp: fields.ip || null,
      country: fields.loc || null,
      colo: fields.colo || null
    };
  }

  async function traceExit(probe = "proxy") {
    const url = EXIT_TRACE_URLS[probe];
    if (!url) throw new TypeError("未知出口检测类型");

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PROXY_TEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${url}?_=${Date.now()}`, {
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        signal: controller.signal
      });
      return {
        ok: true,
        probe,
        ...parseExitTrace(await response.text()),
        httpStatus: response.status
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function testActiveProxy() {
    const activeProxy = await getActiveProxy();
    if (!activeProxy) {
      throw new Error("当前没有活动代理");
    }

    await extensionApi.storage.session.remove(LAST_PROXY_ERROR_KEY);
    try {
      const trace = await traceExit("proxy");
      return {
        ...trace,
        reachable: true,
        active: true,
        phase: activeProxy.phase,
        endpoint: core.formatProxyEndpoint(activeProxy),
        transport: activeProxy.transport || "direct",
        relay: activeProxy.relayHost ? `${activeProxy.relayHost}:${activeProxy.relayPort}` : null
      };
    } catch (error) {
      await new Promise((resolve) => setTimeout(resolve, 40));
      const latestError = await getLastProxyError();
      const code = latestError && latestError.error
        ? latestError.error
        : (error && error.name === "AbortError" ? "TimeoutError" : error && error.message);
      throw new Error(formatProxyConnectionError(code));
    }
  }

  async function getProxyStatus() {
    const [activeProxy, effective] = await Promise.all([
      getActiveProxy(),
      extensionApi.proxy.settings.get({ incognito: false })
    ]);
    return {
      ok: true,
      active: Boolean(activeProxy),
      phase: activeProxy ? activeProxy.phase : null,
      endpoint: activeProxy ? core.formatProxyEndpoint(activeProxy) : null,
      transport: activeProxy ? activeProxy.transport || "direct" : null,
      relay: activeProxy && activeProxy.relayHost ? `${activeProxy.relayHost}:${activeProxy.relayPort}` : null,
      activatedAt: activeProxy ? activeProxy.activatedAt : null,
      levelOfControl: effective && effective.levelOfControl ? effective.levelOfControl : null
    };
  }

  function buildStripeInitBody(publishableKey, locale) {
    const jsId = root.crypto && typeof root.crypto.randomUUID === "function"
      ? root.crypto.randomUUID()
      : `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
    const body = new URLSearchParams();
    body.set("browser_locale", "en-US");
    body.set("browser_timezone", "Asia/Shanghai");
    body.set("elements_session_client[client_betas][0]", "custom_checkout_server_updates_1");
    body.set("elements_session_client[client_betas][1]", "custom_checkout_manual_approval_1");
    body.set("elements_session_client[elements_init_source]", "custom_checkout");
    body.set("elements_session_client[referrer_host]", "chatgpt.com");
    body.set("elements_session_client[stripe_js_id]", jsId);
    body.set("elements_session_client[locale]", /^[a-z]{2}(?:-[A-Z]{2})?$/.test(locale || "") ? locale : "en");
    body.set("elements_session_client[is_aggregation_expected]", "false");
    body.set("elements_options_client[saved_payment_method][enable_save]", "auto");
    body.set("elements_options_client[saved_payment_method][enable_redisplay]", "auto");
    body.set("key", publishableKey);
    body.set("_stripe_version", STRIPE_API_VERSION);
    return body.toString();
  }

  async function initializeStripeCheckout(message) {
    const sessionId = typeof message.sessionId === "string" ? message.sessionId.trim() : "";
    if (!/^cs_(?:live|test)_[A-Za-z0-9]+$/.test(sessionId)) {
      throw new TypeError("Checkout Session ID 格式不正确");
    }
    const suppliedKey = typeof message.publishableKey === "string" ? message.publishableKey.trim() : "";
    const publishableKey = /^pk_(?:live|test)_[A-Za-z0-9]+$/.test(suppliedKey)
      ? suppliedKey
      : DEFAULT_STRIPE_PUBLISHABLE_KEY;
    const url = `https://api.stripe.com/v1/payment_pages/${encodeURIComponent(sessionId)}/init`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), STRIPE_INIT_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${publishableKey}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: buildStripeInitBody(publishableKey, message.locale),
        signal: controller.signal
      });
      const text = await response.text();
      const payload = core.parseResponseText(text);
      if (!response.ok) {
        throw new Error(`Stripe init HTTP ${response.status}：${core.sanitizeDiagnosticText(payload, 180)}`);
      }
      const hostedUrl = core.resolveHostedCheckoutUrl({
        url: payload.stripe_hosted_url || payload.hosted_url || payload.url
      });
      return { ok: true, hostedUrl, httpStatus: response.status, source: "stripe-init" };
    } catch (error) {
      if (error && error.name === "AbortError") {
        throw new Error("Stripe init 请求超时");
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function acquireSentinelCheckoutHeaders(sender) {
    const tabId = sender && sender.tab && Number.isInteger(sender.tab.id)
      ? sender.tab.id
      : null;
    if (tabId === null || !extensionApi.scripting || !extensionApi.scripting.executeScript) {
      throw new Error("当前 ChatGPT 标签页不可用于生成结账校验头");
    }

    const execution = await extensionApi.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: async (flow, sdkUrl, timeoutMs) => {
        const deadline = Date.now() + timeoutMs;

        async function withinDeadline(value, label) {
          const remaining = Math.max(250, deadline - Date.now());
          let timer = null;
          try {
            return await Promise.race([
              Promise.resolve(value),
              new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} 超时`)), remaining);
              })
            ]);
          } finally {
            if (timer !== null) clearTimeout(timer);
          }
        }

        async function waitForSdk() {
          if (window.SentinelSDK && typeof window.SentinelSDK.token === "function") {
            return window.SentinelSDK;
          }

          let script = document.querySelector(`script[src="${sdkUrl}"]`);
          if (!script) {
            script = document.createElement("script");
            script.type = "text/javascript";
            script.src = sdkUrl;
            script.async = true;
            script.defer = true;
            (document.head || document.documentElement).appendChild(script);
          }

          while (Date.now() < deadline) {
            if (window.SentinelSDK && typeof window.SentinelSDK.token === "function") {
              return window.SentinelSDK;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          throw new Error("Sentinel SDK 加载超时");
        }

        const sdk = await waitForSdk();
        // The official checkout client loads the SDK and calls token(flow) directly.
        const token = await withinDeadline(sdk.token(flow), "Sentinel token");
        const timingValue = typeof sdk.timing === "function"
          ? await withinDeadline(sdk.timing(), "Sentinel timing")
          : null;
        return {
          token: typeof token === "string" ? token : "",
          telemetry: typeof timingValue === "string" && timingValue
            ? timingValue
            : "[1,null]"
        };
      },
      args: [SENTINEL_FLOW, SENTINEL_SDK_URL, SENTINEL_TIMEOUT_MS]
    });

    const raw = execution && execution[0] && execution[0].result;
    const token = raw && typeof raw.token === "string" ? raw.token.trim() : "";
    const telemetry = raw && typeof raw.telemetry === "string" ? raw.telemetry.trim() : "";
    if (!token || token.length > 16_384) {
      throw new Error("Sentinel SDK 未返回有效结账校验令牌");
    }
    if (telemetry.length > 16_384) {
      throw new Error("Sentinel SDK 返回的遥测头长度异常");
    }
    return {
      ok: true,
      headers: {
        "OpenAI-Sentinel-Token": token,
        ...(telemetry ? { "OAI-Telemetry": telemetry } : {})
      },
      headerNames: [
        "OpenAI-Sentinel-Token",
        ...(telemetry ? ["OAI-Telemetry"] : [])
      ],
      flow: SENTINEL_FLOW
    };
  }

  async function inspectOfficialCheckoutBundles(message) {
    const rawUrls = Array.isArray(message.urls) ? message.urls : [];
    const urls = [];
    for (const raw of rawUrls.slice(0, 100)) {
      try {
        const url = new URL(String(raw));
        const host = url.hostname.toLowerCase();
        if (url.protocol !== "https:" || ![
          "chatgpt.com",
          "cdn.openai.com",
          "cdn.oaistatic.com"
        ].some((domain) => host === domain || host.endsWith(`.${domain}`))) continue;
        urls.push(url.toString());
      } catch {
        // Ignore malformed DOM resource URLs.
      }
    }
    const needles = [
      "promo_campaign",
      "is_coupon_from_query_param",
      "scheduled_discount_preview",
      "immediate_discount_settings",
      "oaics_"
    ];
    const reports = [];
    const counts = Object.fromEntries(needles.map((needle) => [needle, 0]));
    for (const url of [...new Set(urls)].slice(0, 80)) {
      try {
        const response = await fetch(url, { cache: "force-cache", credentials: "omit" });
        if (!response.ok) continue;
        const text = await response.text();
        if (text.length > 12_000_000) continue;
        for (const needle of needles) {
          if (counts[needle] >= 4) continue;
          let offset = 0;
          while (counts[needle] < 4) {
            const index = text.indexOf(needle, offset);
            if (index < 0) break;
            reports.push({
              file: new URL(url).pathname.split("/").pop(),
              needle,
              excerpt: core.sanitizeDiagnosticText(text.slice(Math.max(0, index - 360), index + 760), 1120)
            });
            counts[needle] += 1;
            offset = index + needle.length;
          }
        }
      } catch {
        // A single optional bundle must not stop the probe.
      }
    }
    if (!reports.length) {
      await recordLocalDiagnostic("checkout_contract", {
        promotion: JSON.stringify({ scanned: urls.length, report: null })
      });
    } else {
      for (const report of reports) {
        await recordLocalDiagnostic("checkout_contract", {
          promotion: JSON.stringify({ scanned: urls.length, report })
        });
      }
    }
    return { ok: true, scanned: urls.length, reports: reports.length };
  }

  extensionApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== "object" || !String(message.type || "").startsWith("checkout-helper:")) {
      return undefined;
    }

    (async () => {
      assertTrustedSender(sender);
      if (message.type === "checkout-helper:set-proxy") {
        return setActiveProxy(message.proxy, message.phase);
      }
      if (message.type === "checkout-helper:clear-proxy") {
        return clearActiveProxy();
      }
      if (message.type === "checkout-helper:get-proxy-status") {
        return getProxyStatus();
      }
      if (message.type === "checkout-helper:test-proxy") {
        return testActiveProxy();
      }
      if (message.type === "checkout-helper:trace-exit") {
        return traceExit(message.probe || "baseline");
      }
      if (message.type === "checkout-helper:stripe-init") {
        return initializeStripeCheckout(message);
      }
      if (message.type === "checkout-helper:get-sentinel-headers") {
        return acquireSentinelCheckoutHeaders(sender);
      }
      if (message.type === "checkout-helper:record-diagnostic") {
        return recordLocalDiagnostic(message.event, message.details);
      }
      if (message.type === "checkout-helper:inspect-contract") {
        return inspectOfficialCheckoutBundles(message);
      }
      throw new Error("未知扩展消息");
    })().then(sendResponse, (error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    });
    return true;
  });

  extensionApi.webRequest.onAuthRequired.addListener(
    (details, callback) => {
      if (!details.isProxy) {
        callback({});
        return;
      }

      const attempts = authAttempts.get(details.requestId) || 0;
      if (attempts >= AUTH_ATTEMPT_LIMIT) {
        callback({ cancel: true });
        return;
      }

      getActiveProxy().then((proxy) => {
        const challenger = details.challenger || {};
        const samePort = proxy && (!challenger.port || Number(challenger.port) === Number(proxy.port));
        if (!proxy || proxy.transport === "relay" || !proxy.username || !samePort) {
          callback({});
          return;
        }
        authAttempts.set(details.requestId, attempts + 1);
        callback({
          authCredentials: {
            username: proxy.username,
            password: proxy.password
          }
        });
      }, () => callback({}));
    },
    { urls: ["<all_urls>"] },
    ["asyncBlocking"]
  );

  const clearAuthAttempt = (details) => authAttempts.delete(details.requestId);
  extensionApi.webRequest.onCompleted.addListener(clearAuthAttempt, { urls: ["<all_urls>"] });
  extensionApi.webRequest.onErrorOccurred.addListener((details) => {
    clearAuthAttempt(details);
    let hostname = "";
    try {
      hostname = new URL(details.url).hostname.toLowerCase();
    } catch {
      hostname = "";
    }
    if (hostname === "chatgpt.com" || hostname.endsWith(".chatgpt.com")) {
      void recordProxyError(details.error || "网络请求失败", { url: details.url }).catch(() => undefined);
    }
  }, { urls: ["<all_urls>"] });

  if (extensionApi.proxy.onProxyError) {
    extensionApi.proxy.onProxyError.addListener((details) => {
      void recordProxyError(details.error || details.details || "代理配置错误").catch(() => undefined);
    });
  }

  extensionApi.runtime.onInstalled.addListener(() => {
    void clearActiveProxy().catch(() => undefined);
  });
})(typeof globalThis === "object" ? globalThis : this);
