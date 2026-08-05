"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { AppError } = require("../lib/errors");
const { BrowserProxyRelay } = require("./browser-proxy-relay");
const {
  createStickyProxySession,
  findBrowserExecutable,
  parseTrace
} = require("./chatgpt-protocol-registration-client");

const core = require(path.resolve(__dirname, "../../../chatgpt-checkout-helper/core.js"));

const CHATGPT_ORIGIN = "https://chatgpt.com";
const SESSION_ENDPOINT = "/api/auth/session";
const CHECKOUT_ENDPOINT = "/backend-api/payments/checkout";
const CHECKOUT_UPDATE_ENDPOINT = "/backend-api/payments/checkout/update";
const ACCOUNT_CONTEXT_ENDPOINT = "/backend-api/accounts/check/v4-2023-04-27";
const PAYMENT_METHODS_ENDPOINT = "/backend-api/payments/payment_methods";
const SENTINEL_SDK_URL = "https://sentinel.openai.com/backend-api/sentinel/sdk.js";
const SENTINEL_FLOW = "chatgpt_checkout";
const SENTINEL_FLOWS = new Set([SENTINEL_FLOW, "checkout_session_approval"]);

function loadChromium() {
  try {
    return require("playwright-core").chromium;
  } catch (error) {
    throw new AppError(503, "PLAYWRIGHT_NOT_INSTALLED", "Checkout runtime is missing; install local-web dependencies.", error);
  }
}

function normalizeAccountSession(input) {
  const kind = String(input && input.kind || "");
  const sessionPath = path.resolve(String(input && input.path || ""));
  if (kind !== "playwright_storage_state" || !sessionPath || path.extname(sessionPath).toLowerCase() !== ".json") {
    throw new AppError(409, "ACCOUNT_SESSION_REQUIRED", "The checkout stage requires a saved browser session.");
  }
  let stats;
  try {
    stats = fs.statSync(sessionPath);
  } catch {
    throw new AppError(409, "ACCOUNT_SESSION_MISSING", "The saved browser session file is missing.");
  }
  if (!stats.isFile() || stats.size < 2 || stats.size > 2 * 1024 * 1024) {
    throw new AppError(409, "ACCOUNT_SESSION_INVALID", "The saved browser session file is invalid.");
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
    if (!parsed || !Array.isArray(parsed.cookies) || !Array.isArray(parsed.origins)) throw new Error("shape");
  } catch {
    throw new AppError(409, "ACCOUNT_SESSION_INVALID", "The saved browser session file is invalid.");
  }
  return Object.freeze({ kind, path: sessionPath });
}

function normalizeCheckoutProxies(input = {}) {
  const US = input.US;
  const TR = input.TR;
  if (!US || typeof US !== "object" || !TR || typeof TR !== "object") {
    throw new AppError(409, "CHECKOUT_PROXIES_REQUIRED", "The checkout stage requires both US and TR proxies.");
  }
  return Object.freeze({ US, TR });
}

function rotateStickyProxyCredential(proxy, region, sessionId = crypto.randomBytes(4).toString("hex")) {
  if (!proxy || typeof proxy !== "object") return proxy;
  const expected = String(region || "").toUpperCase();
  const nextSession = String(sessionId || "");
  if (!/^[A-Za-z0-9]{8}$/.test(nextSession) || !/^[A-Z]{2}$/.test(expected)) return proxy;
  const password = String(proxy.password || "");
  const marker = `-${expected}`;
  const stickyPattern = new RegExp(`${marker}-[A-Za-z0-9]{8}$`, "i");
  let nextPassword = "";
  if (stickyPattern.test(password)) nextPassword = password.replace(stickyPattern, `${marker}-${nextSession}`);
  else if (password.toUpperCase().endsWith(marker)) nextPassword = `${password}-${nextSession}`;
  if (!nextPassword || nextPassword === password) return proxy;
  return Object.freeze({ ...proxy, password: nextPassword });
}

function authHeaders(accessToken, extra = {}) {
  return {
    Accept: "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    Authorization: `Bearer ${accessToken}`,
    ...extra
  };
}

function upstreamError(stage, status, payload, cloudflareChallenge = false) {
  if (cloudflareChallenge) {
    return new AppError(502, "CHECKOUT_CLOUDFLARE_CHALLENGE", `${stage} was challenged by Cloudflare.`);
  }
  if (status === 401) return new AppError(401, "CHECKOUT_SESSION_EXPIRED", "The saved ChatGPT session has expired.");
  if (status === 403) return new AppError(502, "CHECKOUT_REQUEST_REJECTED", `${stage} was rejected with HTTP 403.`);
  if (status === 429) return new AppError(429, "CHECKOUT_RATE_LIMITED", `${stage} was rate limited.`);
  const upstreamCode = payload && payload.error && payload.error.code;
  return new AppError(502, upstreamCode || "CHECKOUT_UPSTREAM_FAILED", `${stage} returned HTTP ${status || "unknown"}.`);
}

class CheckoutProtocolRuntime {
  constructor(options = {}) {
    this.chromium = options.chromium || null;
    this.browserExecutable = options.browserExecutable || "";
    this.headless = Object.hasOwn(options, "headless")
      ? Boolean(options.headless)
      : process.env.LOCAL_WEB_CHECKOUT_HEADLESS === "1";
    this.timeoutMs = Number(options.timeoutMs) || 60_000;
    this.stealth = options.stealth !== false;
    this.relayFactory = options.relayFactory || ((proxy) => new BrowserProxyRelay(proxy, options.relayOptions));
    this.relay = null;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.proxyRegion = null;
    this.stripeBridgeInstalled = false;
  }

  async open({ accountSession, proxy }) {
    const executablePath = findBrowserExecutable(this.browserExecutable);
    if (!executablePath) throw new AppError(503, "BROWSER_EXECUTABLE_NOT_FOUND", "Chrome or Edge is required for checkout extraction.");
    this.relay = this.relayFactory(proxy);
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
    this.context = await this.browser.newContext({
      proxy: { server: proxyServer },
      locale: "en-US",
      storageState: accountSession.path,
      bypassCSP: true
    });
    if (this.stealth) {
      await this.context.addInitScript(() => {
        try {
          Object.defineProperty(Navigator.prototype, "webdriver", { get: () => undefined });
        } catch {}
      });
    }
    await this.createPage();
    this.proxyRegion = "US";
  }

  async createPage() {
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(this.timeoutMs);
  }

  async ensureChatGptPage() {
    if (!this.page || this.page.isClosed()) await this.createPage();
    let origin = "";
    try {
      origin = new URL(this.page.url()).origin;
    } catch {}
    if (origin === CHATGPT_ORIGIN) return;
    const response = await this.page.goto(`${CHATGPT_ORIGIN}/?_=${Date.now()}`, {
      waitUntil: "domcontentloaded",
      timeout: this.timeoutMs
    });
    if (!response || response.status() >= 400) {
      throw new AppError(502, "CHECKOUT_PAGE_FAILED", `ChatGPT page returned HTTP ${response && response.status()}.`);
    }
  }

  async navigateCheckout(checkoutUrl) {
    if (!this.page) throw new AppError(500, "CHECKOUT_RUNTIME_NOT_OPEN", "Checkout runtime has not been opened.");
    const target = new URL(String(checkoutUrl || ""));
    if (target.origin !== CHATGPT_ORIGIN || !/^\/checkout\/[a-z0-9_]+\/oaics_[A-Za-z0-9_-]+\/?$/i.test(target.pathname)) {
      throw new AppError(400, "CHECKOUT_URL_INVALID", "The checkout URL is not an official ChatGPT OAICS checkout.");
    }
    let response;
    try {
      response = await this.page.goto(target.href, {
        waitUntil: "domcontentloaded",
        timeout: this.timeoutMs
      });
    } catch (error) {
      let current = null;
      try { current = new URL(this.page.url()); } catch {}
      if (current && current.origin === target.origin && current.pathname === target.pathname && !this.page.isClosed()) {
        return Object.freeze({ status: 0, path: target.pathname, partial: true });
      }
      throw new AppError(
        502,
        "CHECKOUT_PAGE_FAILED",
        `ChatGPT checkout navigation failed: ${String(error && error.message || error).slice(0, 220)}`
      );
    }
    if (!response || response.status() >= 400) {
      throw new AppError(502, "CHECKOUT_PAGE_FAILED", `ChatGPT checkout page returned HTTP ${response && response.status()}.`);
    }
    return Object.freeze({ status: response.status(), path: target.pathname });
  }

  async refreshCheckout(checkoutUrl) {
    if (!this.page) throw new AppError(500, "CHECKOUT_RUNTIME_NOT_OPEN", "Checkout runtime has not been opened.");
    const target = new URL(String(checkoutUrl || ""));
    if (target.origin !== CHATGPT_ORIGIN || !/^\/checkout\/[a-z0-9_]+\/oaics_[A-Za-z0-9_-]+\/?$/i.test(target.pathname)) {
      throw new AppError(400, "CHECKOUT_URL_INVALID", "The checkout URL is not an official ChatGPT OAICS checkout.");
    }
    let current = null;
    try { current = new URL(this.page.url()); } catch {}
    if (!current || current.origin !== target.origin || current.pathname !== target.pathname) {
      return this.navigateCheckout(target.href);
    }
    let response;
    try {
      response = await this.page.reload({
        waitUntil: "domcontentloaded",
        timeout: this.timeoutMs
      });
    } catch (error) {
      throw new AppError(
        502,
        "CHECKOUT_PAGE_REFRESH_FAILED",
        `ChatGPT checkout refresh failed: ${String(error && error.message || error).slice(0, 220)}`
      );
    }
    if (!response || response.status() >= 400) {
      throw new AppError(502, "CHECKOUT_PAGE_FAILED", `ChatGPT checkout refresh returned HTTP ${response && response.status()}.`);
    }
    return Object.freeze({ status: response.status(), path: target.pathname, refreshed: true });
  }

  async installCheckoutStripeBridge() {
    if (!this.page) throw new AppError(500, "CHECKOUT_RUNTIME_NOT_OPEN", "Checkout runtime has not been opened.");
    if (this.stripeBridgeInstalled) return;
    await this.page.addInitScript(() => {
      const bridge = {
        instances: [],
        elementsCalls: [],
        created: [],
        errors: []
      };
      Object.defineProperty(window, "__plusExtractorStripeBridge", {
        value: bridge,
        configurable: true
      });
      const elementsProxyToRaw = new WeakMap();
      const unwrapElements = (options) => {
        if (!options || typeof options !== "object" || !options.elements) return options;
        const raw = elementsProxyToRaw.get(options.elements);
        return raw ? { ...options, elements: raw } : options;
      };
      const patchStripe = (stripe) => {
        if (!stripe || typeof stripe.elements !== "function") return stripe;
        bridge.instances.push(stripe);
        let stripeProxy;
        const wrapElements = (elements, options) => {
          const call = { stripe, elements, options, ready: false, loadError: null };
          let elementsProxy;
          elementsProxy = new Proxy(elements, {
            get(target, property) {
              if (property === "create") {
                return (type, createOptions) => {
                  const element = target.create(type, createOptions);
                  const created = { type, element: null, elements, options: createOptions, call, mounted: false };
                  const elementProxy = element && typeof element === "object"
                    ? new Proxy(element, {
                      get(elementTarget, elementProperty) {
                        if (elementProperty === "mount" && typeof elementTarget.mount === "function") {
                          return (...args) => {
                            created.mounted = true;
                            return elementTarget.mount(...args);
                          };
                        }
                        if (["unmount", "destroy"].includes(String(elementProperty))
                            && typeof elementTarget[elementProperty] === "function") {
                          return (...args) => {
                            created.mounted = false;
                            return elementTarget[elementProperty](...args);
                          };
                        }
                        const elementValue = Reflect.get(elementTarget, elementProperty, elementTarget);
                        return typeof elementValue === "function" ? elementValue.bind(elementTarget) : elementValue;
                      }
                    })
                    : element;
                  created.element = elementProxy;
                  bridge.created.push(created);
                  if (type === "payment" && element && typeof element.on === "function") {
                    element.on("ready", () => { call.ready = true; });
                    element.on("loaderror", (event) => {
                      call.loadError = event && event.error && event.error.message || "loaderror";
                    });
                  }
                  return elementProxy;
                };
              }
              const value = Reflect.get(target, property, target);
              return typeof value === "function" ? value.bind(target) : value;
            }
          });
          elementsProxyToRaw.set(elementsProxy, elements);
          call.elementsProxy = elementsProxy;
          call.stripeProxy = stripeProxy;
          bridge.elementsCalls.push(call);
          return elementsProxy;
        };
        stripeProxy = new Proxy(stripe, {
          get(target, property) {
            if (property === "elements") {
              return (options) => wrapElements(target.elements(options), options);
            }
            const value = Reflect.get(target, property, target);
            if (typeof value !== "function") return value;
            if (["createConfirmationToken", "confirmPayment", "confirmSetup"].includes(String(property))) {
              return (options) => value.call(target, unwrapElements(options));
            }
            return value.bind(target);
          }
        });
        return stripeProxy;
      };
      let stripeFactory;
      Object.defineProperty(window, "Stripe", {
        configurable: true,
        enumerable: true,
        get: () => stripeFactory,
        set(value) {
          stripeFactory = typeof value === "function"
            ? new Proxy(value, {
              apply(target, thisArg, args) {
                return patchStripe(Reflect.apply(target, thisArg, args));
              }
            })
            : value;
        }
      });
    });
    this.stripeBridgeInstalled = true;
  }

  async waitForCheckoutPaymentElement(timeoutMs = this.timeoutMs) {
    if (!this.page) throw new AppError(500, "CHECKOUT_RUNTIME_NOT_OPEN", "Checkout runtime has not been opened.");
    const result = await this.page.evaluate(async ({ timeoutMs: waitMs }) => {
      const deadline = Date.now() + waitMs;
      let lastLoadError = "";
      while (Date.now() < deadline) {
        const bridge = window.__plusExtractorStripeBridge;
        const calls = bridge && bridge.elementsCalls || [];
        const call = [...calls].reverse().find((candidate) => (
          (bridge.created || []).some((item) => item.type === "payment" && item.call === candidate && item.mounted === true)
        )) || calls[calls.length - 1];
        const hasPaymentElement = Boolean(
          call
          && (bridge.created || []).some((item) => item.type === "payment" && item.call === call && item.mounted === true)
        );
        const hasSecurePaymentFrame = [...document.querySelectorAll("iframe")].some((frame) => {
          const title = String(frame.title || "").toLowerCase();
          let host = "";
          try { host = new URL(frame.src || "", location.href).host.toLowerCase(); } catch {}
          return host === "js.stripe.com" && title.includes("secure payment input frame");
        });
        if (call && call.loadError) lastLoadError = String(call.loadError).slice(0, 200);
        if (call && hasPaymentElement && (call.ready || hasSecurePaymentFrame)
            && typeof call.elements.submit === "function"
            && typeof call.stripe.createConfirmationToken === "function") {
          return { ready: true };
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return { ready: false, error: lastLoadError || "timeout" };
    }, { timeoutMs: Math.max(1_000, Math.min(Number(timeoutMs) || this.timeoutMs, 90_000)) });
    if (!result || result.ready !== true) {
      throw new AppError(
        502,
        "CHECKOUT_PAYMENT_ELEMENT_NOT_READY",
        `Stripe Payment Element did not become ready (${result && result.error || "unknown"}).`
      );
    }
    return Object.freeze({ ready: true });
  }

  async createCheckoutConfirmationToken(billingDetails) {
    if (!this.page) throw new AppError(500, "CHECKOUT_RUNTIME_NOT_OPEN", "Checkout runtime has not been opened.");
    const result = await this.page.evaluate(async (input) => {
      const bridge = window.__plusExtractorStripeBridge;
      const calls = bridge && bridge.elementsCalls || [];
      const call = [...calls].reverse().find((candidate) => (
        (bridge.created || []).some((item) => item.type === "payment" && item.call === candidate && item.mounted === true)
      ));
      const safeError = (error) => ({
        message: String(error && error.message || "Stripe confirmation-token request failed.").slice(0, 240),
        code: String(error && error.code || "").slice(0, 80),
        type: String(error && error.type || "").slice(0, 80),
        declineCode: String(error && error.decline_code || "").slice(0, 80)
      });
      if (!call) return { error: safeError(new Error("Stripe Payment Element is not ready.")) };
      const withinDeadline = async (promise, label) => {
        let timer;
        try {
          return await Promise.race([
            promise,
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out.`)), input.timeoutMs); })
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      };
      try {
        const submitted = await withinDeadline(call.elements.submit(), "Stripe Elements submit");
        if (submitted && submitted.error) return { error: safeError(submitted.error) };
        const created = await withinDeadline(call.stripe.createConfirmationToken({
          elements: call.elements,
          params: { payment_method_data: { billing_details: input.billing } }
        }), "Stripe confirmation token");
        if (created && created.error) return { error: safeError(created.error) };
        const token = created && created.confirmationToken && created.confirmationToken.id || "";
        const selected = submitted && submitted.selectedPaymentMethod;
        const selectedPaymentMethodType = typeof selected === "string"
          ? selected
          : selected && typeof selected.type === "string" ? selected.type : "card";
        return { token, selectedPaymentMethodType };
      } catch (error) {
        return { error: safeError(error) };
      }
    }, { billing: billingDetails, timeoutMs: Math.min(this.timeoutMs, 60_000) });
    if (result && result.error) {
      const code = /auth|captcha|challenge|action/i.test(`${result.error.code} ${result.error.type} ${result.error.message}`)
        ? "TRIAL_SUBSCRIPTION_ACTION_REQUIRED"
        : "CHECKOUT_CONFIRMATION_TOKEN_FAILED";
      throw new AppError(code === "TRIAL_SUBSCRIPTION_ACTION_REQUIRED" ? 409 : 502, code, result.error.message);
    }
    const token = String(result && result.token || "").trim();
    const selectedPaymentMethodType = String(result && result.selectedPaymentMethodType || "card").trim().toLowerCase();
    if (!/^[A-Za-z][A-Za-z0-9_]{7,255}$/.test(token) || !/^[a-z0-9_]{2,40}$/.test(selectedPaymentMethodType)) {
      throw new AppError(502, "CHECKOUT_CONFIRMATION_TOKEN_INVALID", "Stripe returned an invalid confirmation token.");
    }
    return Object.freeze({ token, selectedPaymentMethodType });
  }

  async observeCheckoutPaymentError(timeoutMs = 60_000) {
    if (!this.page) throw new AppError(500, "CHECKOUT_RUNTIME_NOT_OPEN", "Checkout runtime has not been opened.");
    const startedAt = Date.now();
    const deadline = startedAt + Math.max(1_000, Math.min(Number(timeoutMs) || 60_000, 120_000));
    while (Date.now() < deadline) {
      for (const frame of this.page.frames()) {
        const match = await frame.evaluate(() => {
          const pattern = /paym(?:e|a)nt(?:\s+method)?\s+(?:is\s+)?not\s+approved/i;
          const body = document.body;
          if (!body || !pattern.test(String(body.innerText || ""))) return null;
          const nodes = [...body.querySelectorAll("*")].filter((element) => {
            const text = String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
            if (!pattern.test(text)) return false;
            return ![...element.children].some((child) => pattern.test(String(child.innerText || child.textContent || "")));
          });
          const element = nodes.sort((left, right) => (
            String(left.innerText || left.textContent || "").length
            - String(right.innerText || right.textContent || "").length
          ))[0];
          if (!element) return null;
          const text = String(element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
          const label = (text.match(pattern) || [""])[0].slice(0, 80);
          const style = getComputedStyle(element);
          const color = String(style.color || "").slice(0, 80);
          const rgb = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
          const red = Boolean(rgb && Number(rgb[1]) >= 140 && Number(rgb[1]) > Number(rgb[2]) * 1.25 && Number(rgb[1]) > Number(rgb[3]) * 1.25);
          const rect = element.getBoundingClientRect();
          const anchors = [...body.querySelectorAll("iframe, label, h1, h2, h3, h4, div, span")].filter((candidate) => {
            if (candidate === element) return false;
            if (candidate.tagName === "IFRAME") {
              const title = String(candidate.title || "").toLowerCase();
              return title.includes("secure payment input frame") || String(candidate.src || "").includes("js.stripe.com");
            }
            const own = String(candidate.innerText || candidate.textContent || "").replace(/\s+/g, " ").trim();
            return /^(payment method|支付方式)$/i.test(own);
          });
          const nearPaymentElement = anchors.some((anchor) => {
            const target = anchor.getBoundingClientRect();
            const vertical = Math.max(0, Math.max(target.top - rect.bottom, rect.top - target.bottom));
            const horizontal = Math.max(0, Math.max(target.left - rect.right, rect.left - target.right));
            return vertical <= 420 && horizontal <= 420;
          });
          return {
            label,
            color,
            red,
            nearPaymentElement,
            role: String(element.getAttribute("role") || "").slice(0, 40),
            ariaLive: String(element.getAttribute("aria-live") || "").slice(0, 40)
          };
        }).catch(() => null);
        if (match && match.label) {
          return Object.freeze({
            found: true,
            ...match,
            frame: frame === this.page.mainFrame() ? "main" : "embedded",
            elapsedMs: Date.now() - startedAt
          });
        }
      }
      await this.page.waitForTimeout(250);
    }
    return Object.freeze({ found: false, label: "", red: false, nearPaymentElement: false, elapsedMs: Date.now() - startedAt });
  }

  async captureCheckoutScreenshot(filePath) {
    if (!this.page) throw new AppError(500, "CHECKOUT_RUNTIME_NOT_OPEN", "Checkout runtime has not been opened.");
    const output = path.resolve(String(filePath || ""));
    fs.mkdirSync(path.dirname(output), { recursive: true });
    await this.page.screenshot({ path: output, fullPage: true });
    return output;
  }

  async confirmStripeIntent({ type, clientSecret, confirmationToken }) {
    if (!this.page) throw new AppError(500, "CHECKOUT_RUNTIME_NOT_OPEN", "Checkout runtime has not been opened.");
    const intentType = String(type || "").toLowerCase();
    if (!["payment_intent", "setup_intent"].includes(intentType)) {
      throw new AppError(502, "CHECKOUT_INTENT_TYPE_INVALID", "Checkout confirmation returned an unsupported Stripe intent type.");
    }
    const result = await this.page.evaluate(async (input) => {
      const bridge = window.__plusExtractorStripeBridge;
      const calls = bridge && bridge.elementsCalls || [];
      const call = calls[calls.length - 1];
      if (!call) return { error: { message: "Stripe checkout instance is missing.", code: "instance_missing" } };
      const options = {
        clientSecret: input.clientSecret,
        redirect: "if_required",
        confirmParams: { confirmation_token: input.confirmationToken }
      };
      let timer;
      const confirmation = input.type === "setup_intent"
        ? call.stripe.confirmSetup(options)
        : call.stripe.confirmPayment(options);
      const response = await Promise.race([
        confirmation,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Stripe intent confirmation timed out.")), input.timeoutMs); })
      ]).finally(() => { if (timer) clearTimeout(timer); });
      if (response && response.error) {
        return { error: {
          message: String(response.error.message || "Stripe confirmation failed.").slice(0, 240),
          code: String(response.error.code || "").slice(0, 80),
          type: String(response.error.type || "").slice(0, 80),
          declineCode: String(response.error.decline_code || "").slice(0, 80)
        } };
      }
      const intent = response && (response.paymentIntent || response.setupIntent) || {};
      return { status: String(intent.status || "").slice(0, 80) };
    }, {
      type: intentType,
      clientSecret,
      confirmationToken,
      timeoutMs: Math.min(this.timeoutMs, 60_000)
    }).catch((error) => ({ error: { message: String(error && error.message || "Stripe confirmation failed.").slice(0, 240) } }));
    if (result && result.error) {
      const actionRequired = /auth|captcha|challenge|action|required/i.test(
        `${result.error.code} ${result.error.type} ${result.error.message}`
      );
      throw new AppError(
        actionRequired ? 409 : 502,
        actionRequired ? "TRIAL_SUBSCRIPTION_ACTION_REQUIRED" : "CHECKOUT_STRIPE_CONFIRM_FAILED",
        result.error.message
      );
    }
    const status = String(result && result.status || "").toLowerCase();
    if (["requires_action", "requires_payment_method", "requires_confirmation"].includes(status)) {
      throw new AppError(409, "TRIAL_SUBSCRIPTION_ACTION_REQUIRED", `Stripe returned ${status}.`);
    }
    if (status && !["succeeded", "processing", "requires_capture"].includes(status)) {
      throw new AppError(502, "CHECKOUT_STRIPE_STATUS_INVALID", `Stripe returned ${status}.`);
    }
    return Object.freeze({ status: status || "submitted" });
  }

  async handleStripeNextAction(clientSecret) {
    if (!this.page) throw new AppError(500, "CHECKOUT_RUNTIME_NOT_OPEN", "Checkout runtime has not been opened.");
    const result = await this.page.evaluate(async (input) => {
      const bridge = window.__plusExtractorStripeBridge;
      const calls = bridge && bridge.elementsCalls || [];
      const call = calls[calls.length - 1];
      if (!call || typeof call.stripe.handleNextAction !== "function") {
        return { error: { message: "Stripe next-action handler is missing." } };
      }
      let timer;
      const response = await Promise.race([
        call.stripe.handleNextAction({ clientSecret: input.clientSecret }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Stripe next action timed out.")), input.timeoutMs); })
      ]).finally(() => { if (timer) clearTimeout(timer); });
      if (response && response.error) return { error: { message: String(response.error.message || "Stripe action failed.").slice(0, 240) } };
      return { ok: true };
    }, { clientSecret, timeoutMs: Math.min(this.timeoutMs, 60_000) })
      .catch((error) => ({ error: { message: String(error && error.message || "Stripe action failed.").slice(0, 240) } }));
    if (!result || result.ok !== true) {
      throw new AppError(409, "TRIAL_SUBSCRIPTION_ACTION_REQUIRED", result && result.error && result.error.message || "Stripe action is required.");
    }
    return Object.freeze({ ok: true });
  }

  async switchProxy(region, proxy) {
    if (!this.relay || !this.context) throw new AppError(500, "CHECKOUT_RUNTIME_NOT_OPEN", "Checkout runtime has not been opened.");
    const reset = this.relay.reconfigure(proxy);
    await new Promise((resolve) => setTimeout(resolve, 250));
    this.proxyRegion = String(region || "").toUpperCase();
    return reset;
  }

  async verifyExit(expectedRegion) {
    if (!this.page) throw new AppError(500, "CHECKOUT_RUNTIME_NOT_OPEN", "Checkout runtime has not been opened.");
    const expected = String(expectedRegion || "").toUpperCase();
    let lastError;
    let lastTrace = {};
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.ensureChatGptPage();
        const traceResult = await this.page.evaluate(async ({ attempt, timeoutMs }) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeoutMs);
          try {
            const response = await fetch(`/cdn-cgi/trace?_=${Date.now()}-${attempt}`, {
              credentials: "include",
              cache: "no-store",
              signal: controller.signal
            });
            return { status: response.status, text: await response.text() };
          } finally {
            clearTimeout(timer);
          }
        }, { attempt, timeoutMs: this.timeoutMs });
        lastTrace = parseTrace(traceResult.text);
        if (traceResult.status === 200 && lastTrace.loc === expected) {
          return Object.freeze({ region: lastTrace.loc, colo: lastTrace.colo || "" });
        }
      } catch (error) {
        lastError = error;
      }
      if (attempt < 2) {
        const rotatedProxy = rotateStickyProxyCredential(this.relay.proxy, expected);
        if (rotatedProxy !== this.relay.proxy) this.relay.reconfigure(rotatedProxy);
        await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
        if (!this.page || this.page.isClosed()) await this.createPage();
      }
    }
    if (lastTrace.loc && lastTrace.loc !== expected) {
      throw new AppError(502, "CHECKOUT_PROXY_REGION_MISMATCH", `${expected} checkout phase returned ${lastTrace.loc}.`);
    }
    throw new AppError(
      502,
      "CHECKOUT_PROXY_TRACE_FAILED",
      `${expected} checkout phase could not verify its proxy exit.`,
      lastError
    );
  }

  async prepareSentinelSdk() {
    await this.ensureChatGptPage();
    return this.page.evaluate(async ({ sdkUrl, timeoutMs }) => {
      if (window.SentinelSDK && typeof window.SentinelSDK.token === "function") return true;
      let script = document.querySelector(`script[src="${sdkUrl}"]`);
      if (!script) {
        script = document.createElement("script");
        script.src = sdkUrl;
        script.async = true;
        (document.head || document.documentElement).appendChild(script);
      }
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (window.SentinelSDK && typeof window.SentinelSDK.token === "function") return true;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return false;
    }, { sdkUrl: SENTINEL_SDK_URL, timeoutMs: Math.min(this.timeoutMs, 25_000) });
  }

  async requestJson(route, options = {}) {
    if (!this.context || !this.page) throw new AppError(500, "CHECKOUT_RUNTIME_NOT_OPEN", "Checkout runtime has not been opened.");
    const target = new URL(String(route || ""), CHATGPT_ORIGIN);
    if (target.origin !== CHATGPT_ORIGIN) throw new AppError(400, "CHECKOUT_ROUTE_INVALID", "Checkout requests must stay on chatgpt.com.");
    const request = {
      href: target.href,
      method: options.method || "GET",
      timeoutMs: Number(options.timeoutMs) || this.timeoutMs,
      headers: options.headers || { Accept: "application/json" },
      hasBody: Object.hasOwn(options, "body"),
      body: options.body
    };
    let result;
    let lastError;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        result = await this.page.evaluate(async (input) => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), input.timeoutMs);
          try {
            const response = await fetch(input.href, {
              method: input.method,
              credentials: "include",
              cache: "no-store",
              headers: input.headers,
              signal: controller.signal,
              ...(input.hasBody ? { body: JSON.stringify(input.body) } : {})
            });
            return {
              status: response.status,
              ok: response.ok,
              cfMitigated: response.headers.get("cf-mitigated") === "challenge",
              text: await response.text()
            };
          } finally {
            clearTimeout(timer);
          }
        }, request);
        break;
      } catch (error) {
        lastError = error;
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (!result) {
      throw new AppError(
        502,
        "CHECKOUT_NETWORK_ERROR",
        `${options.stage || "Checkout request"} failed in the ChatGPT page context.`,
        lastError
      );
    }
    const text = result.text;
    if (Buffer.byteLength(text, "utf8") > 4 * 1024 * 1024) {
      throw new AppError(502, "CHECKOUT_RESPONSE_TOO_LARGE", `${options.stage || "Checkout request"} returned an oversized response.`);
    }
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { text: text.slice(0, 200) };
    }
    const cloudflareChallenge = result.cfMitigated || /Just a moment/i.test(text);
    if (!result.ok || cloudflareChallenge) {
      throw upstreamError(options.stage || "Checkout request", result.status, payload, cloudflareChallenge);
    }
    return payload;
  }

  async readSession() {
    const session = await this.requestJson(`${SESSION_ENDPOINT}?_=${Date.now()}`, {
      headers: { Accept: "application/json", "Cache-Control": "no-store" },
      stage: "Session check"
    });
    const accessToken = session && typeof session.accessToken === "string" ? session.accessToken.trim() : "";
    if (!accessToken || !(session.user || session.expires)) {
      throw new AppError(401, "CHECKOUT_SESSION_EXPIRED", "The saved ChatGPT session has expired.");
    }
    return Object.freeze({ session, accessToken });
  }

  async acquireSentinelHeaders(flow = SENTINEL_FLOW) {
    if (!this.page) throw new AppError(500, "CHECKOUT_RUNTIME_NOT_OPEN", "Checkout runtime has not been opened.");
    const requestedFlow = String(flow || "");
    if (!SENTINEL_FLOWS.has(requestedFlow)) {
      throw new AppError(400, "CHECKOUT_SENTINEL_FLOW_INVALID", "The requested Sentinel flow is invalid.");
    }
    await this.ensureChatGptPage();
    const raw = await this.page.evaluate(async ({ flow, sdkUrl, timeoutMs }) => {
      const deadline = Date.now() + timeoutMs;
      const withinDeadline = async (value, label) => {
        const remaining = Math.max(250, deadline - Date.now());
        let timer;
        try {
          return await Promise.race([
            Promise.resolve(value),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), remaining); })
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      };
      const waitForSdk = async () => {
        if (window.SentinelSDK && typeof window.SentinelSDK.token === "function") return window.SentinelSDK;
        let script = document.querySelector(`script[src="${sdkUrl}"]`);
        if (!script) {
          script = document.createElement("script");
          script.src = sdkUrl;
          script.async = true;
          (document.head || document.documentElement).appendChild(script);
        }
        while (Date.now() < deadline) {
          if (window.SentinelSDK && typeof window.SentinelSDK.token === "function") return window.SentinelSDK;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error("Sentinel SDK timed out");
      };
      const sdk = await waitForSdk();
      const token = await withinDeadline(sdk.token(flow), "Sentinel token");
      const telemetry = typeof sdk.timing === "function"
        ? await withinDeadline(sdk.timing(), "Sentinel timing")
        : "[1,null]";
      return { token, telemetry };
    }, { flow: requestedFlow, sdkUrl: SENTINEL_SDK_URL, timeoutMs: Math.min(this.timeoutMs, 25_000) });
    const token = raw && typeof raw.token === "string" ? raw.token.trim() : "";
    const telemetry = raw && typeof raw.telemetry === "string" ? raw.telemetry.trim() : "";
    if (!token || token.length > 16_384 || telemetry.length > 16_384) {
      throw new AppError(502, "CHECKOUT_SENTINEL_INVALID", "Sentinel SDK returned an invalid checkout token.");
    }
    return Object.freeze({
      "OpenAI-Sentinel-Token": token,
      ...(telemetry ? { "OAI-Telemetry": telemetry } : {})
    });
  }

  async saveSession(sessionPath) {
    if (!this.context) throw new AppError(500, "CHECKOUT_RUNTIME_NOT_OPEN", "Checkout runtime has not been opened.");
    await this.context.storageState({ path: sessionPath });
  }

  async close() {
    if (this.browser) await this.browser.close().catch(() => {});
    if (this.relay) await this.relay.close().catch(() => {});
    this.page = null;
    this.context = null;
    this.browser = null;
    this.relay = null;
    this.stripeBridgeInstalled = false;
  }
}

class ChatGptCheckoutLinkClient {
  constructor(options = {}) {
    this.runtimeFactory = options.runtimeFactory || (() => new CheckoutProtocolRuntime(options));
    this.proxySessionId = options.proxySessionId || "";
  }

  async extract({ accountSession, proxies, reportProgress = async () => {} } = {}) {
    const session = normalizeAccountSession(accountSession);
    const selected = normalizeCheckoutProxies(proxies);
    const sessionId = this.proxySessionId || crypto.randomBytes(4).toString("hex");
    const sticky = Object.freeze({
      US: createStickyProxySession(selected.US, { sessionId }),
      TR: createStickyProxySession(selected.TR, { sessionId })
    });
    const runtime = this.runtimeFactory();
    let baselineCheckout = null;
    try {
      await reportProgress("正在通过 US 代理恢复已保存的 ChatGPT 会话");
      await runtime.open({ accountSession: session, proxy: sticky.US });
      await runtime.verifyExit("US");
      const usSession = await runtime.readSession();
      await reportProgress("US 出口和登录会话实时校验通过");

      if (typeof runtime.prepareSentinelSdk === "function") {
        const prepared = await runtime.prepareSentinelSdk().catch(() => false);
        if (prepared) await reportProgress("结账校验 SDK 已在 US 会话预载");
      }

      baselineCheckout = await runtime.requestJson(CHECKOUT_ENDPOINT, {
        method: "POST",
        headers: authHeaders(usSession.accessToken, { "Content-Type": "application/json" }),
        body: core.buildBaselineCheckoutPayload(),
        stage: "US baseline checkout"
      });
      await reportProgress("US 基线 Checkout 已创建，正在切换到 TR 代理");

      await runtime.switchProxy("TR", sticky.TR);
      await runtime.verifyExit("TR");
      const trSession = await runtime.readSession();
      await reportProgress("TR 出口和登录会话实时校验通过");

      let accountContext = core.resolveAccountPromotionContext({});
      try {
        const accountQuery = new URLSearchParams({ timezone_offset_min: "0" });
        const accountPayload = await runtime.requestJson(`${ACCOUNT_CONTEXT_ENDPOINT}?${accountQuery}`, {
          headers: authHeaders(trSession.accessToken),
          stage: "Account promotion context"
        });
        accountContext = core.resolveAccountPromotionContext(accountPayload, {
          preferredAccountId: core.getSessionAccountId(trSession.session)
        });
      } catch (error) {
        if (error && error.code === "CHECKOUT_SESSION_EXPIRED") throw error;
        await reportProgress("账户活动上下文未返回，继续使用默认活动策略");
      }

      let paymentPreflight = core.summarizePaymentMethodsPreflight({});
      if (accountContext.accountId) {
        try {
          const paymentQuery = new URLSearchParams({ account_id: accountContext.accountId });
          const paymentPayload = await runtime.requestJson(`${PAYMENT_METHODS_ENDPOINT}?${paymentQuery}`, {
            headers: authHeaders(trSession.accessToken),
            stage: "Payment methods preflight"
          });
          paymentPreflight = core.summarizePaymentMethodsPreflight(paymentPayload);
        } catch (error) {
          if (error && error.code === "CHECKOUT_SESSION_EXPIRED") throw error;
        }
      }

      const campaignId = core.selectPlusPromotionCampaign(accountContext);
      await reportProgress("已解析账户活动上下文", {
        campaignId,
        account: core.summarizeAccountPromotionContext(accountContext),
        oneClickTrialEligible: paymentPreflight.oneClickTrialEligible
      });
      const baselineOaics = core.extractOpenAICheckoutSessionId(baselineCheckout);
      let checkout = null;
      let oaicsSessionId = "";
      let fallbackCheckout = baselineOaics
        ? { ...baselineCheckout, checkout_session_id: baselineOaics, processor_entity: "openai_llc" }
        : null;
      let fallbackOaics = baselineOaics;

      if (baselineOaics) {
        await reportProgress("正在通过 TR 将活动应用到 US 阶段创建的同一 OAICS Checkout");
        try {
          const updated = await runtime.requestJson(CHECKOUT_UPDATE_ENDPOINT, {
            method: "POST",
            headers: authHeaders(trSession.accessToken, { "Content-Type": "application/json" }),
            body: core.buildPromotionUpdatePayload({
              checkoutSessionId: baselineOaics,
              processorEntity: "openai_llc",
              campaignId
            }),
            stage: "TR checkout promotion update"
          });
          const updatedOaics = core.extractOpenAICheckoutSessionId(updated) || baselineOaics;
          const updateApplied = core.hasAppliedPromotion(updated);
          if (updatedOaics) {
            fallbackCheckout = { ...updated, checkout_session_id: updatedOaics, processor_entity: "openai_llc" };
            fallbackOaics = updatedOaics;
          }
          await reportProgress("TR 同会话活动更新已返回", {
            promotionApplied: updateApplied,
            shape: core.describeCheckoutResponseShape(updated),
            identifiers: core.describeCheckoutIdentifiers(updated),
            promotion: core.summarizePromotionState(updated)
          });
          if (updatedOaics && updateApplied) {
            checkout = { ...updated, checkout_session_id: updatedOaics, processor_entity: "openai_llc" };
            oaicsSessionId = updatedOaics;
          }
        } catch (error) {
          if (error && error.code === "CHECKOUT_SESSION_EXPIRED") throw error;
        }
      }

      if (!checkout) {
        await reportProgress("同会话更新尚未确认活动，正在生成 Sentinel 结账校验头");
        const sentinelHeaders = await runtime.acquireSentinelHeaders();
        const attempts = [
          core.buildPhShortPromotionPayload({ campaignId }),
          core.buildPromotionCheckoutPayload({ campaignId, oneClickTrial: false })
        ];
        for (const [attemptIndex, body] of attempts.entries()) {
          let candidate;
          try {
            candidate = await runtime.requestJson(CHECKOUT_ENDPOINT, {
              method: "POST",
              headers: authHeaders(trSession.accessToken, {
                ...sentinelHeaders,
                "Content-Type": "application/json"
              }),
              body,
              stage: "TR promoted checkout"
            });
          } catch (error) {
            if (error && error.code === "CHECKOUT_SESSION_EXPIRED") throw error;
            continue;
          }
          const candidateOaics = core.extractOpenAICheckoutSessionId(candidate);
          const candidateApplied = core.hasAppliedPromotion(candidate);
          if (candidateOaics) {
            fallbackCheckout = { ...candidate, checkout_session_id: candidateOaics, processor_entity: "openai_llc" };
            fallbackOaics = candidateOaics;
          }
          await reportProgress(`TR 活动 Checkout 尝试 ${attemptIndex + 1} 已返回`, {
            promotionApplied: candidateApplied,
            shape: core.describeCheckoutResponseShape(candidate),
            identifiers: core.describeCheckoutIdentifiers(candidate),
            promotion: core.summarizePromotionState(candidate)
          });
          if (candidateOaics && candidateApplied) {
            checkout = { ...candidate, checkout_session_id: candidateOaics, processor_entity: "openai_llc" };
            oaicsSessionId = candidateOaics;
            break;
          }
        }
      }

      if (!checkout && fallbackCheckout && fallbackOaics) {
        checkout = fallbackCheckout;
        oaicsSessionId = fallbackOaics;
        await reportProgress("当前账号未检测到活动资格，已保留可导航的 OAICS 结账链接");
      }
      if (!checkout || !oaicsSessionId) throw new AppError(502, "CHECKOUT_SESSION_ID_MISSING", "Checkout response did not include an OAICS session.");
      core.requireOpenAICheckoutSession(checkout);
      const promotionApplied = core.hasAppliedPromotion(checkout);

      let checkoutUrl = "";
      let route = "hosted";
      try {
        checkoutUrl = core.resolveHostedCheckoutUrl(checkout);
      } catch {
        checkoutUrl = core.buildInternalCheckoutUrl(checkout) || core.buildClientSecretCheckoutUrl(checkout);
        route = checkoutUrl.includes("/checkout/") ? "chatgpt_internal" : "client_secret";
      }
      if (!checkoutUrl) throw new AppError(502, "CHECKOUT_URL_MISSING", "Checkout response did not include a navigable URL.");

      await runtime.saveSession(session.path);
      await reportProgress("US → TR 提链完成，结账链接已写入当前任务");
      return Object.freeze({
        checkoutUrl,
        campaignId,
        promotionApplied,
        promotionStatus: promotionApplied ? "applied" : "not_offered",
        sessionKind: "oaics",
        route,
        proxyFlow: Object.freeze(["US", "TR"]),
        account: Object.freeze({
          planType: accountContext.planType || "",
          eligibleCampaignCount: accountContext.eligibleCampaignIds.length,
          oneClickTrialEligible: paymentPreflight.oneClickTrialEligible
        }),
        extractedAt: new Date().toISOString()
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(502, "CHECKOUT_EXTRACTION_FAILED", error && error.message || "Checkout extraction failed.");
    } finally {
      await runtime.close().catch(() => {});
    }
  }
}

module.exports = {
  CHATGPT_ORIGIN,
  CheckoutProtocolRuntime,
  ChatGptCheckoutLinkClient,
  authHeaders,
  normalizeAccountSession,
  normalizeCheckoutProxies,
  rotateStickyProxyCredential
};
