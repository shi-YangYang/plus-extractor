"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { AppError } = require("../lib/errors");
const { BrowserProxyRelay } = require("./browser-proxy-relay");
const { maskEmail } = require("./mailbox-code-reader");
const { normalizeRegistrationIdentity } = require("./registration-identity");

const CHATGPT_ORIGIN = "https://chatgpt.com";
const AUTH_ORIGIN = "https://auth.openai.com";
const ACCOUNT_API = `${AUTH_ORIGIN}/api/accounts`;
const DEFAULT_MODES = Object.freeze(["signup", "login_or_signup", "login"]);
const NON_RETRYABLE_SESSION_ERRORS = new Set([
  "REGISTRATION_CLOUDFLARE_CHALLENGE"
]);
const TRANSIENT_SESSION_ERROR = /(?:ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|EPROTO|ECONNRESET|ETIMEDOUT|socket disconnected|TLS connection|tlsv1 alert|network path|Target page, context or browser has been closed|Timeout \d+ms exceeded)/i;

function findBrowserExecutable(explicitPath = "") {
  const candidates = [
    explicitPath,
    process.env.LOCAL_WEB_BROWSER_EXECUTABLE,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

function createStickyProxySession(proxy, options = {}) {
  if (!proxy || typeof proxy !== "object") return proxy;
  const hostname = String(proxy.host || "").toLowerCase();
  const password = String(proxy.password || "");
  if (!/(^|\.)kookeey\.(?:info|io|com|net)$/.test(hostname) || !/-(?:US|TR)$/i.test(password)) {
    return proxy;
  }
  const sessionId = String(options.sessionId || crypto.randomBytes(4).toString("hex"));
  if (!/^[a-z0-9]{8}$/i.test(sessionId)) {
    throw new AppError(500, "INVALID_PROXY_SESSION_ID", "Proxy sticky-session id must contain eight letters or digits.");
  }
  return Object.freeze({ ...proxy, password: `${password}-${sessionId}` });
}

function loadChromium() {
  try {
    return require("playwright-core").chromium;
  } catch (error) {
    throw new AppError(503, "PLAYWRIGHT_NOT_INSTALLED", "Protocol challenge runtime is missing; install local-web dependencies.", error);
  }
}

function parseTrace(text) {
  return Object.fromEntries(String(text || "")
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split("=", 2))
    .filter((parts) => parts.length === 2));
}

function pageType(result) {
  return result && result.pageType || null;
}

function isOtpPage(type) {
  return ["email_otp_verification", "email_otp_verification_registration"].includes(type);
}

function isCompletionPage(type) {
  return ["external_url", "token_exchange", "token_response", "workspace", "choose_an_account"].includes(type);
}

function responseError(step, result) {
  if (result && result.cloudflareChallenge) {
    return new AppError(
      502,
      "REGISTRATION_CLOUDFLARE_CHALLENGE",
      `Cloudflare challenged the ${step} protocol request with HTTP ${result.status}.`
    );
  }
  const status = Number(result && result.status) || 502;
  const code = result && result.errorCode ? String(result.errorCode) : "REGISTRATION_PROTOCOL_REJECTED";
  return new AppError(status >= 400 && status < 600 ? status : 502, code, `${step} protocol request returned HTTP ${status}.`);
}

function requireSuccess(step, result) {
  if (!result || !result.ok) throw responseError(step, result);
  return result;
}

function normalizeSessionInitializationError(error) {
  if (error && error.code && String(error.code).startsWith("REGISTRATION_")) return error;
  const message = String(error && error.message || error || "");
  if (TRANSIENT_SESSION_ERROR.test(message)) {
    return new AppError(
      502,
      "REGISTRATION_NETWORK_TRANSIENT",
      "Registration network path closed before the protocol session was ready.",
      error
    );
  }
  return error;
}

function withTimeout(promise, timeoutMs = 3_000) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
}

function buildAboutYouSubmission(profile, inputMode = "birthday") {
  const mode = inputMode === "age" ? "age" : "birthday";
  return Object.freeze({
    inputMode: mode,
    visibleFields: Object.freeze(mode === "age"
      ? { name: profile.fullName, age: profile.age }
      : { name: profile.fullName, birthday: profile.birthdate }),
    apiBody: Object.freeze({ name: profile.fullName, birthdate: profile.birthdate })
  });
}

class AuthProtocolRuntime {
  constructor(proxy, options = {}) {
    this.proxy = proxy;
    this.chromium = options.chromium || null;
    this.browserExecutable = options.browserExecutable || "";
    this.headless = Object.hasOwn(options, "headless")
      ? Boolean(options.headless)
      : process.env.LOCAL_WEB_PROTOCOL_HEADLESS === "1";
    this.timeoutMs = Number(options.timeoutMs) || 60_000;
    this.callbackRetryDelayMs = Object.hasOwn(options, "callbackRetryDelayMs")
      ? Math.max(0, Number(options.callbackRetryDelayMs) || 0)
      : 8_000;
    this.sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.stealth = options.stealth !== false;
    this.relayFactory = options.relayFactory || ((selectedProxy) => new BrowserProxyRelay(selectedProxy, options.relayOptions));
    this.relay = null;
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  async open(mode) {
    const executablePath = findBrowserExecutable(this.browserExecutable);
    if (!executablePath) throw new AppError(503, "BROWSER_EXECUTABLE_NOT_FOUND", "Chrome or Edge is required for protocol challenge tokens.");
    this.relay = this.relayFactory(this.proxy);
    const proxyServer = await this.relay.start();
    const chromium = this.chromium || loadChromium();
    this.browser = await chromium.launch({
      executablePath,
      headless: this.headless,
      ignoreDefaultArgs: this.stealth ? ["--enable-automation"] : [],
      args: [
        "--no-first-run",
        "--disable-default-apps",
        ...(!this.headless ? ["--window-position=-32000,-32000", "--window-size=1,1"] : []),
        ...(this.stealth ? ["--disable-blink-features=AutomationControlled"] : [])
      ]
    });
    this.context = await this.browser.newContext({ proxy: { server: proxyServer }, locale: "en-US" });
    if (this.stealth) {
      await this.context.addInitScript(() => {
        try {
          Object.defineProperty(Navigator.prototype, "webdriver", { get: () => undefined });
        } catch {}
      });
    }
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(this.timeoutMs);

    const traceResponse = await this.page.goto(`${CHATGPT_ORIGIN}/cdn-cgi/trace?_=${Date.now()}`, {
      waitUntil: "domcontentloaded",
      timeout: this.timeoutMs
    });
    const chatgptTrace = parseTrace(await this.page.locator("body").innerText());
    if (!traceResponse || traceResponse.status() !== 200 || chatgptTrace.loc !== "US") {
      throw new AppError(502, "REGISTRATION_US_EXIT_REQUIRED", `ChatGPT protocol exit returned ${chatgptTrace.loc || "unknown"}.`);
    }

    const routeHint = mode === "signup" ? "signup" : "login";
    const bootstrap = await this.page.evaluate(async ({ routeHint }) => {
      const readJson = async (response, step) => {
        const text = await response.text();
        const cloudflareChallenge = response.headers.get("cf-mitigated") === "challenge"
          || /Just a moment/i.test(text);
        if (!response.ok || cloudflareChallenge) {
          return { error: true, step, status: response.status, cloudflareChallenge };
        }
        try {
          return { data: JSON.parse(text) };
        } catch {
          return { error: true, step, status: response.status, invalidJson: true };
        }
      };
      const providersResponse = await fetch("/api/auth/providers", { credentials: "include", cache: "no-store" });
      const providers = await readJson(providersResponse, "providers");
      if (providers.error) return providers;
      const csrfResponse = await fetch("/api/auth/csrf", { credentials: "include", cache: "no-store" });
      const csrfResult = await readJson(csrfResponse, "csrf");
      if (csrfResult.error) return csrfResult;
      const csrf = csrfResult.data;
      if (!csrf || !csrf.csrfToken) {
        return { error: true, step: "csrf", status: csrfResponse.status, missingCsrfToken: true };
      }
      const form = new URLSearchParams({
        callbackUrl: "https://chatgpt.com/",
        csrfToken: csrf.csrfToken,
        json: "true"
      });
      const response = await fetch(`/api/auth/signin/openai?screen_hint=${encodeURIComponent(routeHint)}&prompt=login`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form
      });
      const result = await readJson(response, "signin");
      if (result.error) return result;
      return { status: response.status, url: result.data && result.data.url || null };
    }, { routeHint });
    if (bootstrap.cloudflareChallenge) {
      throw new AppError(
        502,
        "REGISTRATION_CLOUDFLARE_CHALLENGE",
        `Cloudflare challenged the ChatGPT ${bootstrap.step} bootstrap request with HTTP ${bootstrap.status}.`
      );
    }
    if (bootstrap.status !== 200 || !bootstrap.url) {
      throw new AppError(
        502,
        "REGISTRATION_AUTH_BOOTSTRAP_FAILED",
        `Auth bootstrap ${bootstrap.step || "signin"} returned HTTP ${bootstrap.status || "unknown"}.`
      );
    }
    let authorizeUrl;
    try {
      authorizeUrl = new URL(bootstrap.url);
    } catch {
      throw new AppError(502, "REGISTRATION_AUTH_BOOTSTRAP_INVALID", "Auth bootstrap returned an invalid continuation URL.");
    }
    if (authorizeUrl.origin !== AUTH_ORIGIN || authorizeUrl.pathname !== "/api/accounts/authorize") {
      throw new AppError(502, "REGISTRATION_AUTH_BOOTSTRAP_INVALID", "Auth bootstrap returned an unexpected continuation URL.");
    }
    const authResponse = await this.page.goto(authorizeUrl.href, { waitUntil: "commit", timeout: this.timeoutMs });
    if (!authResponse || authResponse.status() >= 400) {
      throw new AppError(502, "REGISTRATION_AUTH_AUTHORIZE_FAILED", `Auth authorization returned HTTP ${authResponse && authResponse.status()}.`);
    }
    await this.page.waitForURL((url) => url.hostname === "auth.openai.com" && !url.pathname.startsWith("/api/"), {
      timeout: this.timeoutMs
    });
    await this.page.waitForLoadState("domcontentloaded", { timeout: this.timeoutMs }).catch(() => {});
    const authTrace = await this.page.evaluate(async () => {
      const text = await fetch(`/cdn-cgi/trace?_=${Date.now()}`, { cache: "no-store" }).then((response) => response.text());
      return Object.fromEntries(text.trim().split(/\r?\n/).map((line) => line.split("=", 2)).filter((parts) => parts.length === 2));
    });
    if (authTrace.loc !== "US") {
      throw new AppError(502, "REGISTRATION_AUTH_US_EXIT_REQUIRED", `Auth protocol exit returned ${authTrace.loc || "unknown"}.`);
    }
    try {
      await this.page.waitForFunction(() => window.SentinelSDK && typeof window.SentinelSDK.token === "function", null, {
        timeout: Math.min(this.timeoutMs, 20_000)
      });
    } catch {
      await this.page.addScriptTag({ url: "https://sentinel.openai.com/backend-api/sentinel/sdk.js" });
      await this.page.waitForFunction(() => window.SentinelSDK && typeof window.SentinelSDK.token === "function", null, {
        timeout: Math.min(this.timeoutMs, 20_000)
      });
    }
  }

  async call({ endpoint, body, flow, method = "POST" }) {
    if (!this.page) throw new AppError(500, "REGISTRATION_PROTOCOL_NOT_OPEN", "Protocol runtime has not been opened.");
    return this.page.evaluate(async ({ accountApi, endpoint, body, flow, method, timeoutMs }) => {
      let sentinelToken;
      let sessionObserverToken;
      if (flow) {
        const sdk = window.SentinelSDK;
        if (!sdk || typeof sdk.token !== "function") throw new Error("Sentinel SDK is not ready");
        if (typeof sdk.init === "function") sdk.init(flow).catch(() => null);
        let mintedSentinel;
        let mintedSessionObserver;
        const sentinelPromise = sdk.token(flow)
          .catch(() => JSON.stringify({ e: "k9d4s6v3b2" }))
          .then((value) => { mintedSentinel = value; });
        const sessionObserverPromise = (typeof sdk.sessionObserverToken === "function"
          ? sdk.sessionObserverToken(flow).catch(() => null)
          : Promise.resolve(null))
          .then((value) => { mintedSessionObserver = value; });
        const completed = await Promise.race([
          Promise.all([sentinelPromise, sessionObserverPromise]).then(() => true),
          new Promise((resolve) => setTimeout(() => resolve(false), 20_000))
        ]);
        if (mintedSentinel === undefined) {
          throw new Error(`Sentinel token timed out for ${flow}`);
        }
        sentinelToken = mintedSentinel;
        sessionObserverToken = mintedSessionObserver
          || (completed ? null : JSON.stringify({ e: "client_timeout" }));
      }
      const headers = {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-access-flow-invocation-id": crypto.randomUUID()
      };
      if (sentinelToken) headers["OpenAI-Sentinel-Token"] = sentinelToken;
      if (sessionObserverToken) headers["OpenAI-Sentinel-SO-Token"] = sessionObserverToken;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetch(`${accountApi}${endpoint}`, {
          method,
          credentials: "include",
          headers,
          signal: controller.signal,
          ...(body === undefined ? {} : { body: JSON.stringify(body) })
        });
      } catch (error) {
        return {
          status: 0,
          ok: false,
          errorCode: error && error.name === "AbortError"
            ? "REGISTRATION_PROTOCOL_TIMEOUT"
            : "REGISTRATION_PROTOCOL_NETWORK_ERROR"
        };
      } finally {
        clearTimeout(timer);
      }
      const contentType = response.headers.get("content-type") || "";
      const isJson = contentType.includes("application/json");
      const data = isJson ? await response.json() : { text: await response.text() };
      const text = data && typeof data.text === "string" ? data.text : "";
      return {
        status: response.status,
        ok: response.ok,
        responseKind: isJson ? "json" : "text",
        cloudflareChallenge: response.status === 403 && (/Just a moment/i.test(text) || response.headers.get("cf-mitigated") === "challenge"),
        pageType: data && data.page && data.page.type || null,
        pagePayload: data && data.page && data.page.payload || null,
        errorCode: data && data.error && data.error.code || null,
        data
      };
    }, { accountApi: ACCOUNT_API, endpoint, body, flow, method, timeoutMs: this.timeoutMs });
  }

  async prewarm(flow, timeoutMs = 60_000) {
    if (!this.page) throw new AppError(500, "REGISTRATION_PROTOCOL_NOT_OPEN", "Protocol runtime has not been opened.");
    return this.page.evaluate(async ({ flow, timeoutMs }) => {
      const sdk = window.SentinelSDK;
      const startedAt = performance.now();
      if (!sdk || typeof sdk.init !== "function") {
        return { ready: false, reason: "sdk_init_missing", durationMs: Math.round(performance.now() - startedAt) };
      }
      try {
        const outcome = await Promise.race([
          sdk.init(flow).then(() => "completed"),
          new Promise((resolve) => setTimeout(() => resolve("timeout"), timeoutMs))
        ]);
        return {
          ready: outcome === "completed",
          reason: outcome,
          durationMs: Math.round(performance.now() - startedAt)
        };
      } catch (error) {
        return {
          ready: false,
          reason: error && error.name || "init_error",
          durationMs: Math.round(performance.now() - startedAt)
        };
      }
    }, { flow, timeoutMs: Math.max(5_000, Math.min(Number(timeoutMs) || 60_000, 90_000)) });
  }

  async requestText(input, _proxy, options = {}) {
    if (!this.context) throw new AppError(500, "REGISTRATION_PROTOCOL_NOT_OPEN", "Protocol runtime has not been opened.");
    const timeoutMs = Number(options.timeoutMs) || 30_000;
    const maxBytes = Number(options.maxBytes) || 2 * 1024 * 1024;
    const response = await this.context.request.get(String(input), {
      timeout: timeoutMs,
      headers: options.headers || {
        Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "Cache-Control": "no-store"
      }
    });
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new AppError(502, "UPSTREAM_RESPONSE_TOO_LARGE", "Mailbox response exceeded the local size limit.");
    }
    return {
      status: response.status(),
      headers: response.headers(),
      text,
      url: response.url(),
      route: "browser_context",
      firstHop: this.relay && this.relay.url ? this.relay.url() : null
    };
  }

  async detectProfileFieldMode() {
    if (!this.page) throw new AppError(500, "REGISTRATION_PROTOCOL_NOT_OPEN", "Protocol runtime has not been opened.");
    return this.page.evaluate(() => {
      const isVisible = (element) => {
        if (!element || element.type === "hidden" || element.hidden || element.disabled) return false;
        if (element.closest("[hidden], [aria-hidden='true']")) return false;
        const style = window.getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden";
      };
      const age = document.querySelector("form input[name='age']");
      if (isVisible(age)) return "age";
      const birthday = document.querySelector("form input[name='birthday'], form [name='birthday']");
      return birthday ? "birthday" : "birthday";
    });
  }

  async transition(result) {
    const continuation = result && result.data && result.data.continue_url;
    if (!continuation) return { followed: false, pathname: new URL(this.page.url()).pathname };
    let parsed;
    try {
      parsed = new URL(continuation, AUTH_ORIGIN);
    } catch {
      throw new AppError(502, "REGISTRATION_CONTINUATION_INVALID", "Auth continuation URL is invalid.");
    }
    if (parsed.origin !== AUTH_ORIGIN || parsed.pathname.startsWith("/api/")) {
      return { followed: false, pathname: parsed.pathname };
    }
    const response = await this.page.goto(parsed.href, {
      waitUntil: "domcontentloaded",
      timeout: this.timeoutMs
    });
    if (!response || response.status() >= 400) {
      throw new AppError(
        502,
        "REGISTRATION_CONTINUATION_FAILED",
        `Auth continuation returned HTTP ${response && response.status()}.`
      );
    }
    await this.page.waitForFunction(
      () => window.SentinelSDK && typeof window.SentinelSDK.token === "function",
      null,
      { timeout: Math.min(this.timeoutMs, 20_000) }
    ).catch(() => {});
    return { followed: true, pathname: parsed.pathname };
  }

  async finalize(result) {
    const nextUrl = result && result.pagePayload && result.pagePayload.url
      || result && result.data && result.data.continue_url
      || null;
    let parsedCallback = null;
    let callbackError = null;
    if (nextUrl) {
      parsedCallback = new URL(nextUrl);
      if (parsedCallback.protocol !== "https:") throw new AppError(502, "REGISTRATION_CONTINUATION_INVALID", "Registration continuation URL is invalid.");
      try {
        await this.page.goto(parsedCallback.href, { waitUntil: "domcontentloaded", timeout: this.timeoutMs });
      } catch (error) {
        callbackError = normalizeSessionInitializationError(error);
      }
    }
    // Read the session through BrowserContext.request: it shares this browser
    // context's callback cookies and proxy, but is independent of a transient
    // callback page whose JavaScript context may be replaced mid-request.
    const readContextSession = async () => {
      try {
        const response = await this.context.request.get(`${CHATGPT_ORIGIN}/api/auth/session?_=${Date.now()}`, {
          timeout: this.timeoutMs,
          headers: { Accept: "application/json", "Cache-Control": "no-store" }
        });
        return response.ok() ? await response.json() : null;
      } catch {
        return null;
      }
    };
    let session = await readContextSession();
    if (!session && parsedCallback && callbackError) {
      await this.sleep(this.callbackRetryDelayMs);
      try {
        await this.page.goto(parsedCallback.href, { waitUntil: "commit", timeout: this.timeoutMs });
        callbackError = null;
      } catch (error) {
        callbackError = normalizeSessionInitializationError(error);
      }
      session = await readContextSession();
    }
    if (!session) {
      const response = await this.page.goto(`${CHATGPT_ORIGIN}/api/auth/session?_=${Date.now()}`, {
        waitUntil: "commit",
        timeout: this.timeoutMs
      }).catch(() => null);
      if (response && response.ok()) {
        try {
          session = await response.json();
        } catch {
          session = null;
        }
      }
    }
    if (!session && callbackError) throw callbackError;
    if (session && (session.user || session.accessToken || session.expires)) {
      await this.page.goto(`${CHATGPT_ORIGIN}/`, {
        waitUntil: "commit",
        timeout: Math.min(this.timeoutMs, 20_000)
      }).catch(() => null);
    }
    return {
      authenticated: Boolean(session && (session.user || session.accessToken || session.expires)),
      origin: new URL(this.page.url()).origin,
      pathname: new URL(this.page.url()).pathname,
      authSession: session && typeof session === "object" && !Array.isArray(session) ? session : null
    };
  }

  async saveSession(taskId, directory) {
    fs.mkdirSync(directory, { recursive: true });
    const safeTaskId = /^[0-9a-f-]{16,}$/i.test(String(taskId || "")) ? String(taskId) : `registration-${Date.now()}`;
    const sessionPath = path.join(directory, `${safeTaskId}.storage.json`);
    await this.context.storageState({ path: sessionPath });
    return sessionPath;
  }

  async saveAuthSession(taskId, directory, authSession) {
    if (!authSession || typeof authSession !== "object" || Array.isArray(authSession)) return null;
    if (!String(authSession.accessToken || "").trim()) return null;
    fs.mkdirSync(directory, { recursive: true });
    const safeTaskId = /^[0-9a-f-]{16,}$/i.test(String(taskId || "")) ? String(taskId) : `registration-${Date.now()}`;
    const authSessionPath = path.join(directory, `${safeTaskId}.auth-session.json`);
    fs.writeFileSync(authSessionPath, JSON.stringify(authSession), { encoding: "utf8", mode: 0o600 });
    return authSessionPath;
  }

  async close() {
    if (this.browser) await withTimeout(this.browser.close().catch(() => {}));
    if (this.relay) await withTimeout(this.relay.close().catch(() => {}));
    this.page = null;
    this.context = null;
    this.browser = null;
    this.relay = null;
  }
}

class ChatGptProtocolRegistrationClient {
  constructor(options = {}) {
    this.sessionDirectory = path.resolve(options.sessionDirectory || path.join(__dirname, "../../data/sessions"));
    this.modes = Array.isArray(options.modes) && options.modes.length ? [...options.modes] : [...DEFAULT_MODES];
    this.proxySessionId = options.proxySessionId || "";
    this.retryDelayMs = Object.hasOwn(options, "retryDelayMs")
      ? Math.max(0, Number(options.retryDelayMs) || 0)
      : 8_000;
    this.sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.runtimeFactory = options.runtimeFactory
      || ((proxy) => new AuthProtocolRuntime(proxy, options));
  }

  describe() {
    return {
      transport: "auth_protocol",
      formAutomation: false,
      challengeRuntime: "system_chromium",
      endpoints: [
        "/api/auth/csrf",
        "/api/auth/signin/openai",
        "/api/accounts/authorize/continue",
        "/api/accounts/passwordless/send-otp",
        "/api/accounts/email-otp/validate",
        "/api/accounts/create_account"
      ]
    };
  }

  async register({
    taskId,
    email,
    identity,
    proxy,
    readVerificationSnapshot,
    waitForVerificationCode,
    reportProgress = async () => {}
  }) {
    if (typeof waitForVerificationCode !== "function") {
      throw new AppError(500, "VERIFICATION_READER_MISSING", "Protocol registration requires a verification-code reader.");
    }
    const profile = normalizeRegistrationIdentity(identity);
    const sessionProxy = createStickyProxySession(
      proxy,
      this.proxySessionId ? { sessionId: this.proxySessionId } : undefined
    );
    await reportProgress(`已生成账户资料：${profile.fullName}，${profile.age} 岁`);
    if (sessionProxy !== proxy) {
      await reportProgress("注册流程使用单一代理凭据；实际出口切换仍由代理后台模式决定");
    }
    let runtime;
    let start;
    let lastError;
    let mailboxBaseline = null;
    for (let modeIndex = 0; modeIndex < this.modes.length; modeIndex += 1) {
      const mode = this.modes[modeIndex];
      const candidate = this.runtimeFactory(sessionProxy);
      try {
        await reportProgress(`正在初始化 ${mode} 协议会话`);
        await candidate.open(mode);
        let candidateBaseline = null;
        if (typeof readVerificationSnapshot === "function") {
          try {
            candidateBaseline = await readVerificationSnapshot({
              proxy: sessionProxy,
              timeoutMs: 30_000
            });
          } catch {
            await reportProgress("邮箱基线读取暂时失败；保留当前注册会话并在验证码阶段继续轮询");
          }
        }
        const body = {
          username: { kind: "email", value: email },
          ...(mode === "signup" ? { screen_hint: "signup" } : {}),
          ...(mode === "login_or_signup" ? { screen_hint: "login_or_signup" } : {})
        };
        start = requireSuccess("authorize/continue", await candidate.call({
          endpoint: "/authorize/continue",
          flow: "authorize_continue",
          body
        }));
        await candidate.transition(start);
        runtime = candidate;
        mailboxBaseline = candidateBaseline;
        await reportProgress("邮箱身份已通过 authorize/continue 接口提交");
        break;
      } catch (error) {
        lastError = normalizeSessionInitializationError(error);
        await candidate.close();
        if (NON_RETRYABLE_SESSION_ERRORS.has(lastError && lastError.code)) throw lastError;
        if (modeIndex + 1 < this.modes.length) {
          await reportProgress(`注册网络节点未就绪，等待 ${Math.ceil(this.retryDelayMs / 1000)} 秒后重建浏览器上下文`);
          await this.sleep(this.retryDelayMs);
        }
      }
    }
    if (!runtime) throw lastError || new AppError(502, "REGISTRATION_PROTOCOL_SESSION_FAILED", "Protocol session initialization failed.");

    let created = false;
    try {
      let type = pageType(start);
      if (["create_account_password", "login_password"].includes(type)) {
        await reportProgress("正在调用 passwordless/send-otp 接口");
        const sent = requireSuccess("passwordless/send-otp", await runtime.call({
          endpoint: "/passwordless/send-otp",
          method: "POST"
        }));
        await runtime.transition(sent);
        start = sent;
        type = pageType(sent);
        await reportProgress("验证码请求已提交，正在轮询接码平台");
      }

      if (isOtpPage(type)) {
        const code = await waitForVerificationCode({
          timeoutMs: 3 * 60_000,
          pollIntervalMs: 3_000,
          proxy: sessionProxy,
          ...(mailboxBaseline ? {
            afterMessageCount: mailboxBaseline.messageCount,
            afterLatestMessageAt: mailboxBaseline.latestMessageAt,
            afterVerificationCode: mailboxBaseline.verificationCode || ""
          } : {})
        });
        const validated = requireSuccess("email-otp/validate", await runtime.call({
          endpoint: "/email-otp/validate",
          flow: "email_otp_validate",
          body: { code }
        }));
        type = pageType(validated);
        start = validated;
        await runtime.transition(validated);
        await reportProgress("邮箱验证码已通过协议接口验证");
      }

      if (type === "about_you") {
        const profileInputMode = typeof runtime.detectProfileFieldMode === "function"
          ? await runtime.detectProfileFieldMode()
          : "birthday";
        const submission = buildAboutYouSubmission(profile, profileInputMode);
        await reportProgress(submission.inputMode === "age"
          ? `检测到 age 资料页，使用年龄 ${profile.age} 并换算对应生日`
          : `检测到 birthday 资料页，使用生日 ${profile.birthdate}`);
        await reportProgress("正在预热账户创建校验令牌");
        const prewarm = await runtime.prewarm("oauth_create_account", 60_000);
        if (!prewarm.ready) {
          throw new AppError(504, "REGISTRATION_SENTINEL_PREWARM_FAILED", `Account-creation token prewarm ended with ${prewarm.reason}.`);
        }
        const completed = requireSuccess("create_account", await runtime.call({
          endpoint: "/create_account",
          flow: "oauth_create_account",
          body: submission.apiBody
        }));
        start = completed;
        type = pageType(completed);
        created = true;
        await reportProgress("姓名和生日已通过资料接口提交");
      }

      if (!created && !isCompletionPage(type)) {
        throw new AppError(502, "REGISTRATION_PROTOCOL_UNEXPECTED_PAGE", `Registration protocol returned page type ${type || "unknown"}.`);
      }
      const completion = await runtime.finalize(start);
      if (!completion.authenticated) {
        throw new AppError(502, "REGISTRATION_SESSION_NOT_AUTHENTICATED", "Registration finished without an authenticated ChatGPT session.");
      }
      const sessionPath = await runtime.saveSession(taskId, this.sessionDirectory);
      const authSessionPath = completion.authSession && typeof runtime.saveAuthSession === "function"
        ? await runtime.saveAuthSession(taskId, this.sessionDirectory, completion.authSession)
        : null;
      await reportProgress(created ? "ChatGPT 账户协议注册完成" : "ChatGPT 未完成账户会话已恢复");
      return Object.freeze({
        account: maskEmail(email),
        mode: created ? "created" : "authenticated",
        profile,
        registeredAt: new Date().toISOString(),
        transport: "auth_protocol",
        session: Object.freeze({
          kind: "playwright_storage_state",
          path: sessionPath,
          ...(authSessionPath ? {
            authSessionPath,
            authSessionCachedAt: new Date().toISOString(),
            authSessionExpiresAt: completion.authSession.expires || null
          } : {})
        })
      });
    } catch (error) {
      throw normalizeSessionInitializationError(error);
    } finally {
      await runtime.close();
    }
  }
}

module.exports = {
  ACCOUNT_API,
  AuthProtocolRuntime,
  AuthProtocolRuntime,
  ChatGptProtocolRegistrationClient,
  buildAboutYouSubmission,
  createStickyProxySession,
  findBrowserExecutable,
  isCompletionPage,
  isOtpPage,
  parseTrace,
  normalizeSessionInitializationError,
  responseError
};
