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
const {
  BANGKA_CHECKOUT_CONFIG,
  buildCheckoutCreateBody,
  buildCheckoutUpdateBody,
  extractCheckoutAmount: extractBangKaCheckoutAmount,
  extractCheckoutSessionId: extractBangKaCheckoutSessionId,
  extractProcessorEntity: extractBangKaProcessorEntity,
  extractStripePublishableKey
} = require("./chatgpt-bangka-protocol");

const core = require(path.resolve(__dirname, "../../../chatgpt-checkout-helper/core.js"));

const CHATGPT_ORIGIN = "https://chatgpt.com";
const SESSION_ENDPOINT = "/api/auth/session";
const CHECKOUT_ENDPOINT = "/backend-api/payments/checkout";
const CHECKOUT_UPDATE_ENDPOINT = "/backend-api/payments/checkout/update";
const ACCOUNT_CONTEXT_ENDPOINT = "/backend-api/accounts/check/v4-2023-04-27";
const PAYMENT_METHODS_ENDPOINT = "/backend-api/payments/payment_methods";
const PROMOTION_COUPON_ENDPOINTS = Object.freeze([
  "/backend-api/payments/promo_campaign/check_coupon",
  "/backend-api/promo_campaign/check_coupon"
]);
const SENTINEL_SDK_URL = "https://sentinel.openai.com/backend-api/sentinel/sdk.js";
const SENTINEL_FLOW = "chatgpt_checkout";
const SENTINEL_FLOWS = new Set([SENTINEL_FLOW, "checkout_session_approval"]);
const MAX_STORAGE_STATE_BYTES = 16 * 1024 * 1024;

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
  if (!stats.isFile() || stats.size < 2 || stats.size > MAX_STORAGE_STATE_BYTES) {
    throw new AppError(409, "ACCOUNT_SESSION_INVALID", "The saved browser session file is invalid.");
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
    if (!parsed || !Array.isArray(parsed.cookies) || !Array.isArray(parsed.origins)) throw new Error("shape");
  } catch {
    throw new AppError(409, "ACCOUNT_SESSION_INVALID", "The saved browser session file is invalid.");
  }
  let importedAuthSession = null;
  // Every registration path persists an adjacent auth-session cache. Protocol
  // registrations previously supplied that path without either legacy mode
  // flag, so checkout ignored the still-valid AT and relied only on cookies.
  // Once those cookies rolled over, Plus verification reported an expired
  // session even though the preserved AT remained valid.
  const privateAuthCacheRequested = Boolean(input && (
    String(input.authSessionPath || "").trim()
    || input.accessTokenImported === true
    || input.registrationMode === "roxybrowser"
  ));
  if (privateAuthCacheRequested) {
    const authSessionPath = path.resolve(String(input.authSessionPath || ""));
    const expectedAuthSessionPath = sessionPath.toLowerCase().endsWith(".storage.json")
      ? sessionPath.slice(0, -".storage.json".length) + ".auth-session.json"
      : "";
    if (!authSessionPath || authSessionPath !== expectedAuthSessionPath
        || !authSessionPath.toLowerCase().endsWith(".auth-session.json")) {
      throw new AppError(409, "ACCOUNT_AUTH_SESSION_REQUIRED", "The private access token cache is missing.");
    }
    try {
      const authStats = fs.statSync(authSessionPath);
      if (!authStats.isFile() || authStats.size < 2 || authStats.size > 2 * 1024 * 1024) throw new Error("size");
      const parsed = JSON.parse(fs.readFileSync(authSessionPath, "utf8"));
      const accessToken = String(parsed && parsed.accessToken || "").trim();
      const accountId = core.getSessionAccountId(parsed);
      if (!accessToken || accessToken.length < 20 || accessToken.length > 20_000
          || !/^[A-Za-z0-9._~+\/-]+=*$/.test(accessToken) || !accountId) {
        throw new Error("shape");
      }
      importedAuthSession = parsed;
    } catch {
      throw new AppError(409, "ACCOUNT_AUTH_SESSION_INVALID", "The private access token cache is invalid.");
    }
  }
  return Object.freeze({ kind, path: sessionPath, importedAuthSession });
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

function accountCheckoutHeaders(accessToken, accountId, route, extra = {}) {
  const normalizedAccountId = typeof accountId === "string" ? accountId.trim() : "";
  return authHeaders(accessToken, {
    ...(normalizedAccountId ? { "chatgpt-account-id": normalizedAccountId } : {}),
    "x-openai-target-path": route,
    "x-openai-target-route": route,
    ...extra
  });
}

function extractAnyCheckoutSessionId(payload) {
  return core.extractOpenAICheckoutSessionId(payload) || core.extractCheckoutSessionId(payload);
}

function extractCheckoutProcessorEntity(payload) {
  const candidate = payload && (payload.processor_entity
    || payload.processorEntity
    || (payload.data && (payload.data.processor_entity || payload.data.processorEntity)));
  const normalized = typeof candidate === "string" ? candidate.trim().toLowerCase() : "";
  return /^(?:openai_llc|openai_ie)$/.test(normalized) ? normalized : "";
}

function checkoutProcessorEntity(payload) {
  return extractCheckoutProcessorEntity(payload) || "openai_llc";
}

function summarizeCouponEligibility(payload) {
  const rawStatus = [payload && payload.status, payload && payload.state, payload && payload.eligibility]
    .find((value) => typeof value === "string");
  const status = String(rawStatus || "").trim().toLowerCase();
  const explicit = payload && typeof payload.eligible === "boolean"
    ? payload.eligible
    : payload && typeof payload.is_eligible === "boolean" ? payload.is_eligible : null;
  const eligible = explicit === true || /^(?:eligible|available|active)$/.test(status);
  const ineligible = explicit === false || /^(?:not_eligible|ineligible|unavailable|inactive)$/.test(status);
  return Object.freeze({
    known: eligible || ineligible,
    eligible,
    status: status || (explicit === true ? "eligible" : explicit === false ? "not_eligible" : "unknown")
  });
}

function mergeSameSessionCheckout(baseline, update, expectedSessionId) {
  if (!baseline || typeof baseline !== "object" || !update || typeof update !== "object") return null;
  return {
    ...baseline,
    ...update,
    checkout_session_id: expectedSessionId,
    processor_entity: extractCheckoutProcessorEntity(update) || checkoutProcessorEntity(baseline)
  };
}

function resolveInternalCheckout(payload) {
  const checkoutUrl = core.buildInternalCheckoutUrl(payload);
  const sessionId = extractAnyCheckoutSessionId(payload);
  if (!checkoutUrl || !sessionId) return null;
  const oaicsSessionId = core.extractOpenAICheckoutSessionId(payload);
  return Object.freeze({
    payload,
    checkoutUrl,
    route: "chatgpt_internal",
    oaicsSessionId,
    sessionKind: /^oaics_/i.test(sessionId) ? "oaics" : "standard"
  });
}

function upstreamError(stage, status, payload, cloudflareChallenge = false) {
  if (cloudflareChallenge) {
    return new AppError(502, "CHECKOUT_CLOUDFLARE_CHALLENGE", `${stage} was challenged by Cloudflare.`);
  }
  if (status === 401) return new AppError(401, "CHECKOUT_SESSION_EXPIRED", "The saved ChatGPT session has expired.");
  if (status === 403) return new AppError(502, "CHECKOUT_REQUEST_REJECTED", `${stage} was rejected with HTTP 403.`);
  if (status === 429) return new AppError(429, "CHECKOUT_RATE_LIMITED", `${stage} was rate limited.`);
  const detail = typeof (payload && payload.detail) === "string" ? payload.detail.trim() : "";
  if (status === 400 && /no payment account exists for this account/i.test(detail)) {
    return new AppError(409, "CHECKOUT_PAYMENT_ACCOUNT_MISSING", "The account payment profile has not been initialized.");
  }
  const upstreamCode = payload && payload.error && payload.error.code;
  return new AppError(502, upstreamCode || "CHECKOUT_UPSTREAM_FAILED", `${stage} returned HTTP ${status || "unknown"}.`);
}

function resolveNavigableCheckout(payload) {
  if (!payload || typeof payload !== "object") return null;
  const oaicsSessionId = core.extractOpenAICheckoutSessionId(payload);
  let checkoutUrl = "";
  let route = "";
  try {
    checkoutUrl = core.resolveHostedCheckoutUrl(payload);
    route = "hosted";
  } catch {}
  if (!checkoutUrl && oaicsSessionId) {
    checkoutUrl = core.buildInternalCheckoutUrl(payload);
    route = checkoutUrl ? "chatgpt_internal" : "";
  }
  if (!checkoutUrl) {
    checkoutUrl = core.buildClientSecretCheckoutUrl(payload);
    route = checkoutUrl ? "client_secret" : "";
  }
  if (!checkoutUrl) {
    checkoutUrl = core.buildInternalCheckoutUrl(payload);
    route = checkoutUrl ? "chatgpt_internal" : "";
  }
  if (!checkoutUrl) return null;
  return Object.freeze({
    payload,
    checkoutUrl,
    route,
    oaicsSessionId,
    sessionKind: oaicsSessionId ? "oaics" : "standard"
  });
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
    this.deviceId = String(options.deviceId || crypto.randomUUID());
    this.relayFactory = options.relayFactory || ((proxy) => new BrowserProxyRelay(proxy, options.relayOptions));
    this.relay = null;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.proxyRegion = null;
    this.stripeBridgeInstalled = false;
    this.importedAuthSession = null;
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
    this.importedAuthSession = accountSession.importedAuthSession || null;
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
    if (target.origin !== CHATGPT_ORIGIN || !/^\/checkout\/[a-z0-9_]+\/(?:oaics_[A-Za-z0-9_-]+|cs_(?:live|test)_[A-Za-z0-9_-]+)\/?$/i.test(target.pathname)) {
      throw new AppError(400, "CHECKOUT_URL_INVALID", "The checkout URL is not an official ChatGPT checkout.");
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

  async createPromotedCheckoutFromPricing({ campaignId = core.CHECKOUT_CONFIG.campaignId } = {}) {
    if (!this.page) throw new AppError(500, "CHECKOUT_RUNTIME_NOT_OPEN", "Checkout runtime has not been opened.");
    const normalizedCampaignId = typeof campaignId === "string" ? campaignId.trim() : "";
    if (!/^[A-Za-z0-9_.-]{2,120}$/.test(normalizedCampaignId)) {
      throw new AppError(400, "CHECKOUT_PROMOTION_INVALID", "The promotion campaign id is invalid.");
    }

    const pricingUrl = new URL(CHATGPT_ORIGIN);
    pricingUrl.searchParams.set("promo_campaign", normalizedCampaignId);
    pricingUrl.hash = "pricing";
    let response;
    try {
      response = await this.page.goto(pricingUrl.href, {
        waitUntil: "domcontentloaded",
        timeout: this.timeoutMs
      });
    } catch (error) {
      throw new AppError(502, "CHECKOUT_PRICING_PAGE_FAILED", "The official promotion pricing page did not load.", error);
    }
    if (!response || response.status() >= 400) {
      throw new AppError(502, "CHECKOUT_PRICING_PAGE_FAILED", `The official promotion pricing page returned HTTP ${response && response.status()}.`);
    }

    const offerButton = this.page.getByRole("button", {
      name: /^(?:claim free offer|claim offer|start free trial|try plus)$/i
    }).first();
    try {
      await offerButton.waitFor({ state: "visible", timeout: Math.min(this.timeoutMs, 30_000) });
    } catch (error) {
      throw new AppError(
        409,
        "CHECKOUT_PROMOTION_OFFER_NOT_VISIBLE",
        "The official pricing page does not show a free Plus offer for this account.",
        error
      );
    }

    const evidence = await offerButton.evaluate((button) => {
      const bodyText = String(document.body && document.body.innerText || "").replace(/\r/g, "");
      const buttonText = String(button && button.textContent || "").trim();
      const plusVisible = /(?:^|\n)(?:ChatGPT\s+)?Plus(?:\n|$)/i.test(bodyText);
      const freeOfferVisible = /claim\s+(?:free\s+)?offer|start\s+free\s+trial|try\s+plus/i.test(buttonText);
      const zeroPriceVisible = /(?:\$|USD\s*)\s*0(?:\.00)?(?:\s|\n|\/|$)/i.test(bodyText)
        || /0(?:\.00)?\s*USD/i.test(bodyText)
        || /^claim\s+free\s+offer$/i.test(buttonText);
      const firstMonthVisible = /first\s+month|promo\s+pricing\s+applies\s+for\s+1\s+month|free\s+offer/i.test(bodyText);
      const priceMatch = bodyText.match(/\$\s*(\d+(?:\.\d{1,2})?)\s*\n\s*\$\s*0(?:\.00)?/i);
      const subtotalMinorUnits = priceMatch ? Math.round(Number(priceMatch[1]) * 100) : null;
      return {
        plusVisible,
        freeOfferVisible,
        zeroPriceVisible,
        firstMonthVisible,
        subtotalMinorUnits: Number.isFinite(subtotalMinorUnits) ? subtotalMinorUnits : null
      };
    });
    if (!evidence.plusVisible || !evidence.freeOfferVisible || !evidence.zeroPriceVisible || !evidence.firstMonthVisible) {
      throw new AppError(
        409,
        "CHECKOUT_PROMOTION_PRICE_NOT_VERIFIED",
        `The official pricing page did not verify a zero-price first month for Plus (plus=${evidence.plusVisible}, offer=${evidence.freeOfferVisible}, zero=${evidence.zeroPriceVisible}, firstMonth=${evidence.firstMonthVisible}).`
      );
    }

    const checkoutResponsePromise = this.page.waitForResponse((candidate) => {
      try {
        const target = new URL(candidate.url());
        return candidate.request().method() === "POST"
          && target.origin === CHATGPT_ORIGIN
          && target.pathname === CHECKOUT_ENDPOINT;
      } catch {
        return false;
      }
    }, { timeout: Math.min(this.timeoutMs, 45_000) });
    await offerButton.click({ timeout: Math.min(this.timeoutMs, 30_000) });
    const checkoutResponse = await checkoutResponsePromise;
    let checkoutPayload = {};
    try {
      checkoutPayload = await checkoutResponse.json();
    } catch {
      throw new AppError(502, "CHECKOUT_UPSTREAM_FAILED", "The official pricing flow returned a non-JSON Checkout response.");
    }
    if (!checkoutResponse.ok()) {
      throw upstreamError("Official pricing Checkout", checkoutResponse.status(), checkoutPayload);
    }

    const payloadResolved = resolveInternalCheckout(checkoutPayload) || resolveNavigableCheckout(checkoutPayload);
    try {
      await this.page.waitForURL((url) => (
        url.origin === CHATGPT_ORIGIN
        && /^\/checkout\/[a-z0-9_]+\/(?:oaics_[A-Za-z0-9_-]+|cs_(?:live|test)_[A-Za-z0-9_-]+)\/?$/i.test(url.pathname)
      ), { timeout: Math.min(this.timeoutMs, 30_000) });
    } catch {}
    let checkoutUrl = "";
    try {
      const current = new URL(this.page.url());
      if (current.origin === CHATGPT_ORIGIN
          && /^\/checkout\/[a-z0-9_]+\/(?:oaics_[A-Za-z0-9_-]+|cs_(?:live|test)_[A-Za-z0-9_-]+)\/?$/i.test(current.pathname)) {
        checkoutUrl = current.href;
      }
    } catch {}
    checkoutUrl = checkoutUrl || (payloadResolved && payloadResolved.checkoutUrl) || "";
    if (!checkoutUrl) {
      throw new AppError(502, "CHECKOUT_URL_MISSING", "The official pricing flow did not return a navigable Checkout URL.");
    }

    const subtotalMinorUnits = evidence.subtotalMinorUnits;
    return Object.freeze({
      checkout: checkoutPayload,
      checkoutUrl,
      fullDiscount: Object.freeze({
        fullDiscountVerified: true,
        discountPercent: 100,
        subtotalMinorUnits,
        discountMinorUnits: subtotalMinorUnits,
        dueTodayMinorUnits: 0
      })
    });
  }

  async refreshCheckout(checkoutUrl) {
    if (!this.page) throw new AppError(500, "CHECKOUT_RUNTIME_NOT_OPEN", "Checkout runtime has not been opened.");
    const target = new URL(String(checkoutUrl || ""));
    if (target.origin !== CHATGPT_ORIGIN || !/^\/checkout\/[a-z0-9_]+\/(?:oaics_[A-Za-z0-9_-]+|cs_(?:live|test)_[A-Za-z0-9_-]+)\/?$/i.test(target.pathname)) {
      throw new AppError(400, "CHECKOUT_URL_INVALID", "The checkout URL is not an official ChatGPT checkout.");
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

  async refreshCurrentPage() {
    if (!this.page) throw new AppError(500, "CHECKOUT_RUNTIME_NOT_OPEN", "Checkout runtime has not been opened.");
    await this.ensureChatGptPage();
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
        `ChatGPT page refresh failed: ${String(error && error.message || error).slice(0, 220)}`
      );
    }
    if (!response || response.status() >= 400) {
      throw new AppError(502, "CHECKOUT_PAGE_REFRESH_FAILED", `ChatGPT page refresh returned HTTP ${response && response.status()}.`);
    }
    return Object.freeze({ status: response.status(), path: new URL(this.page.url()).pathname, refreshed: true });
  }

  async installCheckoutStripeBridge() {
    if (!this.page) throw new AppError(500, "CHECKOUT_RUNTIME_NOT_OPEN", "Checkout runtime has not been opened.");
    if (this.stripeBridgeInstalled) return;
    await this.page.addInitScript(() => {
      const bridge = {
        instances: [],
        elementsCalls: [],
        checkoutCalls: [],
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
            if (property === "initCheckout") {
              return (...args) => Promise.resolve(value.apply(target, args)).then((checkout) => {
                bridge.checkoutCalls.push({ stripe, checkout, stripeProxy, readyAt: Date.now() });
                return checkout;
              });
            }
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

  async waitForCheckoutCustomSession(timeoutMs = this.timeoutMs) {
    if (!this.page) throw new AppError(500, "CHECKOUT_RUNTIME_NOT_OPEN", "Checkout runtime has not been opened.");
    const result = await this.page.evaluate(async ({ timeoutMs: waitMs }) => {
      const summarize = (session) => {
        const amount = (value) => {
          const number = Number(value);
          return Number.isFinite(number) ? number : null;
        };
        const discounts = Array.isArray(session && session.discountAmounts) ? session.discountAmounts : [];
        const taxes = Array.isArray(session && session.taxAmounts) ? session.taxAmounts : [];
        const saved = Array.isArray(session && session.savedPaymentMethods) ? session.savedPaymentMethods : [];
        const discountPercent = discounts.reduce((maximum, item) => (
          Math.max(maximum, Number(item && item.percentOff) || 0)
        ), 0);
        const discountMinorUnits = discounts.reduce((sum, item) => (
          sum + (amount(item && item.amount && item.amount.minorUnitsAmount) ?? amount(item && item.minorUnitsAmount) ?? 0)
        ), 0);
        const taxMinorUnits = taxes.reduce((sum, item) => (
          sum + (amount(item && item.amount && item.amount.minorUnitsAmount) ?? amount(item && item.minorUnitsAmount) ?? 0)
        ), 0);
        const taxLabels = [...new Set(taxes.map((item) => String(item && item.displayName || "").trim()).filter(Boolean))];
        const taxRatePercent = taxLabels.reduce((maximum, label) => {
          for (const match of label.matchAll(/(\d+(?:\.\d+)?)\s*%/g)) {
            maximum = Math.max(maximum, Number(match[1]) || 0);
          }
          return maximum;
        }, 0);
        const dueTodayMinorUnits = amount(session && session.total && session.total.total
          && session.total.total.minorUnitsAmount);
        const subtotalMinorUnits = amount(session && session.total && session.total.subtotal
          && session.total.subtotal.minorUnitsAmount);
        const billing = session && session.billingAddress || {};
        const address = billing.address || {};
        const statusValue = session && session.status;
        return {
          status: typeof statusValue === "string"
            ? statusValue
            : String(statusValue && (statusValue.type || statusValue.status) || ""),
          discountPercent,
          discountMinorUnits,
          subtotalMinorUnits,
          dueTodayMinorUnits,
          taxMinorUnits,
          taxRatePercent,
          taxLabels,
          canConfirm: session && session.canConfirm === true,
          savedPaymentMethodCount: saved.length,
          billing: {
            name: String(billing.name || "").trim(),
            address: {
              line1: String(address.line1 || "").trim(),
              city: String(address.city || "").trim(),
              state: String(address.state || "").trim().toUpperCase(),
              postal_code: String(address.postal_code || address.postalCode || "").trim(),
              country: String(address.country || "").trim().toUpperCase()
            }
          }
        };
      };
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        if (location.pathname === "/checkout/verify") return { expired: true, path: location.pathname };
        const calls = window.__plusExtractorStripeBridge && window.__plusExtractorStripeBridge.checkoutCalls || [];
        const call = [...calls].reverse().find((candidate) => (
          candidate && candidate.checkout && typeof candidate.checkout.session === "function"
        ));
        if (call) {
          window.__plusExtractorActiveCustomCheckout = call.checkout;
          window.__plusExtractorSummarizeCustomCheckout = summarize;
          return { ready: true, summary: summarize(call.checkout.session()) };
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return {
        ready: false,
        path: location.pathname,
        stripeInstanceCount: window.__plusExtractorStripeBridge && window.__plusExtractorStripeBridge.instances.length || 0
      };
    }, { timeoutMs: Math.max(1_000, Math.min(Number(timeoutMs) || this.timeoutMs, 90_000)) });
    if (result && result.expired) {
      throw new AppError(409, "TRIAL_CHECKOUT_SESSION_EXPIRED", "The saved Checkout session expired before its live amount could be verified.");
    }
    if (!result || result.ready !== true) {
      throw new AppError(
        502,
        "CHECKOUT_CUSTOM_SESSION_NOT_READY",
        `Stripe Custom Checkout did not initialize (path=${result && result.path || "unknown"}).`
      );
    }
    return Object.freeze({
      ...result.summary,
      billing: Object.freeze({
        ...result.summary.billing,
        address: Object.freeze({ ...result.summary.billing.address })
      })
    });
  }

  async updateCustomCheckoutBilling(billing) {
    if (!this.page) throw new AppError(500, "CHECKOUT_RUNTIME_NOT_OPEN", "Checkout runtime has not been opened.");
    const result = await this.page.evaluate(async (input) => {
      const checkout = window.__plusExtractorActiveCustomCheckout;
      const summarize = window.__plusExtractorSummarizeCustomCheckout;
      if (!checkout || typeof checkout.updateBillingAddress !== "function" || typeof summarize !== "function") {
        return { error: { message: "Stripe Custom Checkout is not ready." } };
      }
      try {
        const updated = await checkout.updateBillingAddress({ name: input.name, address: input.address });
        if (updated && updated.type === "error") {
          return { error: { message: String(updated.error && updated.error.message || "Billing update failed.").slice(0, 240) } };
        }
        return { summary: summarize(checkout.session()) };
      } catch (error) {
        return { error: { message: String(error && error.message || error).slice(0, 240) } };
      }
    }, billing);
    if (!result || result.error || !result.summary) {
      throw new AppError(502, "CHECKOUT_CUSTOM_BILLING_FAILED", result && result.error && result.error.message || "Stripe Custom Checkout billing update failed.");
    }
    return Object.freeze({
      ...result.summary,
      billing: Object.freeze({
        ...result.summary.billing,
        address: Object.freeze({ ...result.summary.billing.address })
      })
    });
  }

  async confirmCustomCheckout({ paymentMethodId, billing }) {
    if (!this.page) throw new AppError(500, "CHECKOUT_RUNTIME_NOT_OPEN", "Checkout runtime has not been opened.");
    const id = String(paymentMethodId || "").trim();
    if (!/^pm_[A-Za-z0-9_-]{8,255}$/.test(id)) {
      throw new AppError(409, "TRIAL_DEFAULT_CARD_REQUIRED", "The verified default payment method is missing.");
    }
    const result = await this.page.evaluate(async (input) => {
      const checkout = window.__plusExtractorActiveCustomCheckout;
      if (!checkout || typeof checkout.confirm !== "function") {
        return { error: { message: "Stripe Custom Checkout is not ready.", code: "checkout_not_ready" } };
      }
      try {
        const confirmed = await checkout.confirm({
          paymentMethod: input.paymentMethodId,
          redirect: "if_required"
        });
        if (confirmed && confirmed.type === "error") {
          return { error: {
            message: String(confirmed.error && confirmed.error.message || "Stripe confirmation failed.").slice(0, 240),
            code: String(confirmed.error && confirmed.error.code || "").slice(0, 80),
            type: String(confirmed.error && confirmed.error.type || "").slice(0, 80)
          } };
        }
        return { type: String(confirmed && confirmed.type || "success") };
      } catch (error) {
        return { error: { message: String(error && error.message || error).slice(0, 240) } };
      }
    }, { paymentMethodId: id, billing });
    if (!result || result.error) {
      throw new AppError(409, "TRIAL_SUBSCRIPTION_REJECTED", result && result.error && result.error.message || "Stripe Custom Checkout rejected the subscription.", {
        provider: result && result.error || null
      });
    }
    return Object.freeze({ type: result.type || "success" });
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

  async createBangKaConfirmationToken({
    publishableKey,
    customerSessionClientSecret,
    amount = 0,
    currency,
    paymentMethodTypes,
    paymentMethodId,
    email = ""
  } = {}) {
    if (!this.page) throw new AppError(500, "CHECKOUT_RUNTIME_NOT_OPEN", "Checkout runtime has not been opened.");
    const result = await this.page.evaluate(async (input) => {
      const safeError = (error) => ({
        message: String(error && error.message || "Stripe confirmation-token request failed.").slice(0, 240),
        code: String(error && error.code || "").slice(0, 80),
        type: String(error && error.type || "").slice(0, 80)
      });
      const waitForStripe = async () => {
        if (typeof window.Stripe === "function") return window.Stripe;
        let script = document.querySelector('script[src^="https://js.stripe.com/v3"]');
        if (!script) {
          script = document.createElement("script");
          script.src = "https://js.stripe.com/v3/";
          script.async = true;
          (document.head || document.documentElement).appendChild(script);
        }
        const deadline = Date.now() + input.timeoutMs;
        while (Date.now() < deadline) {
          if (typeof window.Stripe === "function") return window.Stripe;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error("Stripe.js did not load before the Payment Element deadline.");
      };
      let mount = null;
      let paymentElement = null;
      try {
        const StripeFactory = await waitForStripe();
        const stripe = StripeFactory(input.publishableKey);
        const elements = stripe.elements({
          mode: "subscription",
          amount: input.amount,
          currency: input.currency,
          customerSessionClientSecret: input.customerSessionClientSecret,
          paymentMethodTypes: input.paymentMethodTypes
        });
        paymentElement = elements.create("payment", {
          fields: { billingDetails: { email: "never", phone: "never" } },
          defaultValues: { billingDetails: { email: input.email } },
          wallets: { applePay: "never", googlePay: "never" },
          business: { name: "OpenAI" },
          layout: { type: "accordion", defaultCollapsed: false }
        });
        mount = document.createElement("div");
        mount.id = `plus-extractor-protocol-element-${Date.now()}`;
        Object.assign(mount.style, {
          position: "fixed",
          left: "-10000px",
          top: "0",
          width: "420px",
          minHeight: "240px",
          opacity: "0.01",
          pointerEvents: "none"
        });
        document.body.appendChild(mount);
        let selectedPaymentMethodId = "";
        let readyResolve;
        let readyReject;
        const ready = new Promise((resolve, reject) => {
          readyResolve = resolve;
          readyReject = reject;
        });
        paymentElement.on("ready", readyResolve);
        paymentElement.on("loaderror", (event) => readyReject(event && event.error || new Error("Stripe Payment Element load failed.")));
        paymentElement.on("change", (event) => {
          const changedId = String(event && event.value && event.value.payment_method && event.value.payment_method.id || "").trim();
          if (/^pm_/.test(changedId)) selectedPaymentMethodId = changedId;
        });
        paymentElement.mount(mount);
        let timer;
        await Promise.race([
          ready,
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Stripe Payment Element load timed out.")), input.timeoutMs); })
        ]).finally(() => { if (timer) clearTimeout(timer); });
        const submitted = await elements.submit();
        if (submitted && submitted.error) return { error: safeError(submitted.error) };
        const submittedSelection = String(submitted && submitted.selectedPaymentMethod || "").trim();
        let selectedPaymentMethodType = "";
        if (/^pm_/.test(submittedSelection)) selectedPaymentMethodId = submittedSelection;
        else selectedPaymentMethodType = submittedSelection;
        if (selectedPaymentMethodType && selectedPaymentMethodType !== "card") {
          return { error: safeError(Object.assign(new Error(`Stripe.js selected ${selectedPaymentMethodType} instead of card.`), { code: "unexpected_payment_method_type" })) };
        }
        if (selectedPaymentMethodId && selectedPaymentMethodId !== input.paymentMethodId) {
          return { error: safeError(Object.assign(new Error("Stripe.js selected a different saved card."), { code: "payment_method_id_mismatch" })) };
        }
        const created = await stripe.createConfirmationToken({ elements });
        if (created && created.error) return { error: safeError(created.error) };
        return {
          token: String(created && created.confirmationToken && created.confirmationToken.id || ""),
          selectedPaymentMethodType: "card",
          selectedPaymentMethodId
        };
      } catch (error) {
        return { error: safeError(error) };
      } finally {
        try { if (paymentElement) paymentElement.destroy(); } catch {}
        try { if (mount) mount.remove(); } catch {}
      }
    }, {
      publishableKey,
      customerSessionClientSecret,
      amount: Number(amount),
      currency: String(currency || "").toLowerCase(),
      paymentMethodTypes: Array.isArray(paymentMethodTypes) ? paymentMethodTypes : ["card", "link"],
      paymentMethodId,
      email: String(email || "").trim(),
      timeoutMs: Math.min(this.timeoutMs, 30_000)
    });
    if (result && result.error) {
      const actionRequired = /auth|captcha|challenge|action/i.test(`${result.error.code} ${result.error.type} ${result.error.message}`);
      throw new AppError(actionRequired ? 409 : 502,
        actionRequired ? "TRIAL_SUBSCRIPTION_ACTION_REQUIRED" : "CHECKOUT_CONFIRMATION_TOKEN_FAILED",
        result.error.message);
    }
    const token = String(result && result.token || "").trim();
    if (!/^ctoken_[A-Za-z0-9]+$/.test(token)) {
      throw new AppError(502, "CHECKOUT_CONFIRMATION_TOKEN_INVALID", "Stripe.js did not return a valid ConfirmationToken.");
    }
    return Object.freeze({
      token,
      selectedPaymentMethodType: "card",
      selectedPaymentMethodId: String(result.selectedPaymentMethodId || "")
    });
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

  async confirmBangKaStripeIntent({
    type,
    clientSecret,
    confirmationToken,
    publishableKey,
    checkoutSessionId,
    processorEntity,
    planType = "plus"
  } = {}) {
    if (!this.context || !this.context.request) {
      throw new AppError(500, "CHECKOUT_RUNTIME_NOT_OPEN", "Checkout runtime has not been opened.");
    }
    const normalizedType = String(type || "").trim().toLowerCase();
    const secret = String(clientSecret || "").trim();
    const token = String(confirmationToken || "").trim();
    const key = String(publishableKey || "").trim();
    const secretKind = secret.startsWith("seti_") ? "setup_intent" : secret.startsWith("pi_") ? "payment_intent" : "";
    const intentType = ["setup_intent", "payment_intent"].includes(normalizedType) ? normalizedType : secretKind;
    const intentId = secret.split("_secret_", 1)[0];
    if (!intentType || !/^(?:seti|pi)_[A-Za-z0-9_-]+$/.test(intentId)
        || !/^(?:seti|pi)_[A-Za-z0-9_-]+_secret_[A-Za-z0-9_-]+$/.test(secret)
        || !/^ctoken_[A-Za-z0-9]+$/.test(token)
        || !/^pk_(?:live|test)_[A-Za-z0-9]+$/.test(key)) {
      throw new AppError(502, "CHECKOUT_STRIPE_CONFIRM_INPUT_INVALID", "Stripe intent confirmation input is invalid.");
    }
    const intentKind = intentType === "setup_intent" ? "setup_intents" : "payment_intents";
    const returnUrl = `${CHATGPT_ORIGIN}/checkout/verify?${new URLSearchParams({
      stripe_session_id: String(checkoutSessionId || ""),
      processor_entity: String(processorEntity || ""),
      plan_type: String(planType || "plus")
    })}`;
    let response;
    try {
      response = await this.context.request.post(`https://api.stripe.com/v1/${intentKind}/${intentId}/confirm`, {
        headers: {
          Accept: "application/json",
          "Accept-Language": "en-US,en;q=0.9",
          Origin: "https://js.stripe.com",
          Priority: "u=1, i",
          Referer: "https://js.stripe.com/",
          "Content-Type": "application/x-www-form-urlencoded"
        },
        form: {
          client_secret: secret,
          return_url: returnUrl,
          key,
          _stripe_version: "2025-03-31.basil; checkout_server_update_beta=v1; checkout_manual_approval_preview=v1",
          confirmation_token: token
        },
        timeout: Math.min(this.timeoutMs, 60_000)
      });
    } catch (error) {
      throw new AppError(502, "CHECKOUT_STRIPE_CONFIRM_FAILED", `Stripe intent confirmation failed: ${String(error && error.message || error).slice(0, 220)}`);
    }
    const text = await response.text();
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch {}
    if (!response.ok()) {
      const provider = payload && payload.error || {};
      const message = String(provider.message || `Stripe returned HTTP ${response.status()}`).slice(0, 240);
      const actionRequired = /auth|captcha|challenge|action|required/i.test(`${provider.code || ""} ${provider.type || ""} ${message}`);
      throw new AppError(actionRequired ? 409 : 502,
        actionRequired ? "TRIAL_SUBSCRIPTION_ACTION_REQUIRED" : "CHECKOUT_STRIPE_CONFIRM_FAILED",
        message);
    }
    const status = String(payload && payload.status || "").trim().toLowerCase();
    if (["requires_action", "requires_confirmation", "requires_payment_method"].includes(status)) {
      throw new AppError(409, "TRIAL_SUBSCRIPTION_ACTION_REQUIRED", `Stripe returned ${status}.`);
    }
    if (status && !["succeeded", "processing", "requires_capture"].includes(status)) {
      throw new AppError(502, "CHECKOUT_STRIPE_STATUS_INVALID", `Stripe returned ${status}.`);
    }
    return Object.freeze({ status: status || "submitted", transport: "stripe_form_protocol" });
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
    let lastTraceStatus = null;
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
        lastTraceStatus = Number(traceResult.status);
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
    const tunnelFailure = this.relay && typeof this.relay.getLastTunnelFailure === "function"
      ? this.relay.getLastTunnelFailure()
      : null;
    if (tunnelFailure) {
      const upstreamStatus = Number(tunnelFailure.upstreamStatus) || null;
      const authenticationRejected = upstreamStatus === 407;
      throw new AppError(
        502,
        authenticationRejected ? "CHECKOUT_PROXY_AUTH_FAILED" : "CHECKOUT_PROXY_TUNNEL_FAILED",
        authenticationRejected
          ? `${expected} proxy gateway rejected the HTTPS tunnel with HTTP 407 (proxy authentication required).`
          : `${expected} proxy tunnel failed (${tunnelFailure.code || "PROXY_TUNNEL_FAILED"}).`,
        Object.freeze({
          expectedRegion: expected,
          tunnelCode: tunnelFailure.code || null,
          upstreamStatus
        })
      );
    }
    const traceStatus = Number.isFinite(lastTraceStatus) ? lastTraceStatus : null;
    const causeCode = String(lastError && (lastError.code || lastError.name) || "").slice(0, 80);
    const diagnostic = traceStatus == null
      ? `no trace response${causeCode ? `, cause=${causeCode}` : ""}`
      : `trace HTTP ${traceStatus}${lastTrace.loc ? `, loc=${lastTrace.loc}` : ", loc=missing"}`;
    throw new AppError(
      502,
      "CHECKOUT_PROXY_TRACE_FAILED",
      `${expected} checkout phase could not verify its proxy exit (${diagnostic}; attempts=3).`,
      Object.freeze({
        expectedRegion: expected,
        attempts: 3,
        traceStatus,
        traceRegion: lastTrace.loc || null,
        causeCode: causeCode || null
      })
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
      headers: {
        "oai-device-id": this.deviceId,
        "oai-language": "en-US",
        ...(options.headers || { Accept: "application/json" })
      },
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
    if (this.importedAuthSession) {
      const session = this.importedAuthSession;
      const accessToken = String(session.accessToken || "").trim();
      const expiresMs = Date.parse(String(session.expires || ""));
      if (!accessToken || (Number.isFinite(expiresMs) && expiresMs <= Date.now())) {
        throw new AppError(401, "CHECKOUT_SESSION_EXPIRED", "The imported access token has expired.");
      }
      return Object.freeze({ session, accessToken });
    }
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
    }, { flow: requestedFlow, sdkUrl: SENTINEL_SDK_URL, timeoutMs: Math.min(this.timeoutMs, 60_000) });
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
    this.importedAuthSession = null;
  }
}

class ChatGptCheckoutLinkClient {
  constructor(options = {}) {
    this.runtimeFactory = options.runtimeFactory || (() => new CheckoutProtocolRuntime(options));
    this.proxySessionId = options.proxySessionId || "";
    this.sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    const loadWaitMs = Number(options.checkoutLoadWaitMs);
    const verificationDelayMs = Number(options.checkoutVerificationDelayMs);
    const verificationAttempts = Number(options.checkoutVerificationAttempts);
    this.checkoutLoadWaitMs = Number.isFinite(loadWaitMs) ? Math.max(0, loadWaitMs) : 30_000;
    this.checkoutVerificationDelayMs = Number.isFinite(verificationDelayMs)
      ? Math.max(0, verificationDelayMs)
      : 20_000;
    this.checkoutVerificationAttempts = Number.isInteger(verificationAttempts)
      ? Math.max(1, Math.min(verificationAttempts, 5))
      : 3;
  }

  async extract({ accountSession, proxies, proxySessionId = "", reportProgress = async () => {} } = {}) {
    const session = normalizeAccountSession(accountSession);
    const selected = normalizeCheckoutProxies(proxies);
    const flowSessionId = String(proxySessionId || this.proxySessionId || crypto.randomBytes(4).toString("hex")).trim();
    if (!/^[a-z0-9]{8}$/i.test(flowSessionId)) {
      throw new AppError(400, "INVALID_PROXY_SESSION_ID", "Checkout flow session id must contain eight letters or digits.");
    }
    const sticky = Object.freeze({
      US: createStickyProxySession(selected.US, { sessionId: flowSessionId }),
      TR: createStickyProxySession(selected.TR, { sessionId: flowSessionId })
    });
    const runtime = this.runtimeFactory();
    try {
      await reportProgress("正在通过 US 代理创建 PH/PHP 优惠 Checkout");
      await runtime.open({ accountSession: session, proxy: sticky.US });
      await runtime.verifyExit("US");
      const usSession = await runtime.readSession();
      const accountId = core.getSessionAccountId(usSession.session);
      const created = await runtime.requestJson(CHECKOUT_ENDPOINT, {
        method: "POST",
        headers: accountCheckoutHeaders(usSession.accessToken, accountId, CHECKOUT_ENDPOINT, {
          "Content-Type": "application/json"
        }),
        body: buildCheckoutCreateBody(),
        stage: "US PH/PHP checkout creation"
      });
      let checkoutSessionId = extractBangKaCheckoutSessionId(created);
      let processorEntity = extractBangKaProcessorEntity(created, BANGKA_CHECKOUT_CONFIG.country);
      if (!checkoutSessionId) {
        throw new AppError(502, "CHECKOUT_SESSION_ID_MISSING", "Checkout creation succeeded without a checkout session id.");
      }
      await reportProgress("US Checkout 已创建，正在通过 TR 代理更新同一会话的首月优惠", {
        protocolMode: "bangka_oaics",
        checkoutCountry: BANGKA_CHECKOUT_CONFIG.country,
        currency: BANGKA_CHECKOUT_CONFIG.currency
      });

      await runtime.switchProxy("TR", sticky.TR);
      await runtime.verifyExit("TR");
      const trSession = await runtime.readSession();
      const trAccountId = core.getSessionAccountId(trSession.session) || accountId;
      const provisionalUrl = `${CHATGPT_ORIGIN}/checkout/${processorEntity}/${checkoutSessionId}`;
      const updated = await runtime.requestJson(CHECKOUT_UPDATE_ENDPOINT, {
        method: "POST",
        headers: accountCheckoutHeaders(trSession.accessToken, trAccountId, CHECKOUT_UPDATE_ENDPOINT, {
          "Content-Type": "application/json",
          Referer: provisionalUrl
        }),
        body: buildCheckoutUpdateBody({ checkoutSessionId, processorEntity }),
        stage: "TR same-session promotion update"
      });
      checkoutSessionId = extractBangKaCheckoutSessionId(updated) || checkoutSessionId;
      processorEntity = extractBangKaProcessorEntity(updated, BANGKA_CHECKOUT_CONFIG.country) || processorEntity;
      if (!/^oaics_[A-Za-z0-9_-]+$/.test(checkoutSessionId)) {
        throw new AppError(409, "CHECKOUT_OAICS_REQUIRED", "Checkout promotion update did not return an oaics_ session.");
      }
      const amount = extractBangKaCheckoutAmount(updated);
      if (amount.source && amount.amount !== 0) {
        throw new AppError(409, "CHECKOUT_NONZERO_AMOUNT", `Checkout promotion update returned a non-zero amount (${amount.amount}).`);
      }
      const checkoutUrl = `${CHATGPT_ORIGIN}/checkout/${processorEntity}/${checkoutSessionId}`;
      await runtime.requestJson(checkoutUrl, {
        headers: { Accept: "text/html,application/xhtml+xml", Referer: `${CHATGPT_ORIGIN}/` },
        stage: "TR checkout link verification"
      });
      const stripePublishableKey = extractStripePublishableKey(updated) || extractStripePublishableKey(created);
      if (!/^pk_(?:live|test)_[A-Za-z0-9]+$/.test(stripePublishableKey)) {
        throw new AppError(502, "CHECKOUT_STRIPE_KEY_MISSING", "Checkout response did not include a Stripe publishable key.");
      }
      await runtime.saveSession(session.path);
      const zeroAmountVerified = Boolean(amount.source) && amount.amount === 0;
      await reportProgress(zeroAmountVerified
        ? "US → TR 提链完成；oaics_ 链接与返回金额 0 已验证"
        : "US → TR 提链完成；oaics_ 链接已验证，金额将在 Taxes 阶段复核", {
        protocolMode: "bangka_oaics",
        amountSource: amount.source || "unknown",
        zeroAmountVerified
      });
      return Object.freeze({
        checkoutUrl,
        checkoutSessionId,
        processorEntity,
        stripePublishableKey,
        campaignId: BANGKA_CHECKOUT_CONFIG.campaignId,
        promotionApplied: zeroAmountVerified,
        fullDiscountVerified: zeroAmountVerified,
        zeroAmountVerified,
        discountPercent: zeroAmountVerified ? 100 : null,
        subtotalMinorUnits: null,
        discountMinorUnits: null,
        dueTodayMinorUnits: amount.source ? amount.amount : null,
        amountSource: amount.source,
        promotionStatus: zeroAmountVerified ? "zero_due" : "pending_zero_amount_verification",
        promotionVerification: amount.source ? "bangka_checkout_update" : "bangka_taxes_pending",
        protocolMode: "bangka_oaics",
        sessionKind: "oaics",
        route: "chatgpt_internal",
        checkoutCountry: BANGKA_CHECKOUT_CONFIG.country,
        currency: BANGKA_CHECKOUT_CONFIG.currency,
        proxyFlow: Object.freeze(["US", "TR"]),
        extractedAt: new Date().toISOString()
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(502, "CHECKOUT_EXTRACTION_FAILED", error && error.message || "Checkout extraction failed.");
    } finally {
      await runtime.close().catch(() => {});
    }
  }

  async waitForCheckout(runtime, milliseconds) {
    if (milliseconds <= 0) return;
    if (runtime && typeof runtime.waitForRetry === "function") {
      await runtime.waitForRetry(milliseconds);
      return;
    }
    await this.sleep(milliseconds);
  }

  async verifyPromotionUnderUs({
    runtime,
    checkout,
    authenticated,
    accountId,
    reportProgress
  }) {
    const sessionId = extractAnyCheckoutSessionId(checkout);
    if (!sessionId) {
      return Object.freeze({
        checkout,
        navigable: resolveNavigableCheckout(checkout),
        promotionApplied: core.hasAppliedPromotion(checkout),
        detailVerified: false
      });
    }
    const processorEntity = checkoutProcessorEntity(checkout);
    const internalCheckout = resolveInternalCheckout({
      ...checkout,
      checkout_session_id: sessionId,
      processor_entity: processorEntity
    });
    if (!internalCheckout) {
      return Object.freeze({
        checkout,
        navigable: resolveNavigableCheckout(checkout),
        promotionApplied: core.hasAppliedPromotion(checkout),
        detailVerified: false
      });
    }
    if (typeof runtime.navigateCheckout !== "function" && core.hasFullDiscountPromotion(checkout)) {
      return Object.freeze({
        checkout,
        navigable: internalCheckout,
        promotionApplied: true,
        detailVerified: false
      });
    }

    let current = checkout;
    let detailVerified = false;
    if (typeof runtime.navigateCheckout === "function") {
      await reportProgress("正在通过 US 打开同一个 Checkout，等待优惠和金额充分加载");
      try {
        await runtime.navigateCheckout(internalCheckout.checkoutUrl);
        await this.waitForCheckout(runtime, this.checkoutLoadWaitMs);
      } catch (error) {
        if (error && error.code === "CHECKOUT_SESSION_EXPIRED") throw error;
        await reportProgress("Checkout 页面尚未完全加载，继续使用同一会话读取优惠状态");
      }
    }

    const route = `/backend-api/payments/checkout/${encodeURIComponent(processorEntity)}/${encodeURIComponent(sessionId)}`;
    for (let attempt = 0; attempt < this.checkoutVerificationAttempts; attempt += 1) {
      try {
        const detail = await runtime.requestJson(route, {
          headers: accountCheckoutHeaders(authenticated.accessToken, accountId, route),
          stage: "US checkout promotion verification"
        });
        const merged = mergeSameSessionCheckout(current, detail, sessionId);
        if (merged) current = merged;
        detailVerified = true;
        await reportProgress(`US Checkout 优惠与金额校验 ${attempt + 1}/${this.checkoutVerificationAttempts} 已返回`, {
          promotionApplied: core.hasAppliedPromotion(current),
          fullDiscountVerified: core.hasFullDiscountPromotion(current),
          shape: core.describeCheckoutResponseShape(detail),
          promotion: core.summarizePromotionState(detail)
        });
        if (core.hasFullDiscountPromotion(current)) break;
      } catch (error) {
        if (error && error.code === "CHECKOUT_SESSION_EXPIRED") throw error;
      }
      if (attempt >= this.checkoutVerificationAttempts - 1) break;
      await reportProgress(`Checkout 尚未显示优惠，${Math.round(this.checkoutVerificationDelayMs / 1000)} 秒后仅刷新当前提链页（${attempt + 1}/${this.checkoutVerificationAttempts - 1}）`);
      await this.waitForCheckout(runtime, this.checkoutVerificationDelayMs);
      try {
        if (typeof runtime.refreshCheckout === "function") {
          await runtime.refreshCheckout(internalCheckout.checkoutUrl);
        } else if (typeof runtime.refreshCurrentPage === "function") {
          await runtime.refreshCurrentPage();
        }
      } catch {}
    }

    return Object.freeze({
      checkout: current,
      navigable: resolveInternalCheckout(current) || internalCheckout,
      promotionApplied: core.hasAppliedPromotion(current),
      detailVerified
    });
  }

  async extractLegacy({ accountSession, proxies, proxySessionId = "", checkoutSeed = null, reportProgress = async () => {} } = {}) {
    const session = normalizeAccountSession(accountSession);
    const selected = normalizeCheckoutProxies(proxies);
    const sessionId = String(proxySessionId || this.proxySessionId || crypto.randomBytes(4).toString("hex")).trim();
    if (!/^[a-z0-9]{8}$/i.test(sessionId)) {
      throw new AppError(400, "INVALID_PROXY_SESSION_ID", "Checkout flow session id must contain eight letters or digits.");
    }
    const sticky = Object.freeze({
      US: createStickyProxySession(selected.US, { sessionId }),
      TR: createStickyProxySession(selected.TR, { sessionId })
    });
    const runtime = this.runtimeFactory();
    let baselineCheckout = checkoutSeed && typeof checkoutSeed === "object"
      && extractAnyCheckoutSessionId(checkoutSeed)
      ? checkoutSeed
      : null;
    const reusedCheckoutSeed = Boolean(baselineCheckout);
    try {
      await reportProgress("正在通过 US 代理恢复已保存的 ChatGPT 会话");
      await runtime.open({ accountSession: session, proxy: sticky.US });
      await runtime.verifyExit("US");
      const usSession = await runtime.readSession();
      await reportProgress("US 出口和登录会话实时校验通过");

      if (typeof runtime.installCheckoutStripeBridge === "function") {
        await runtime.installCheckoutStripeBridge();
      }

      if (typeof runtime.prepareSentinelSdk === "function") {
        const prepared = await runtime.prepareSentinelSdk().catch(() => false);
        if (prepared) await reportProgress("结账校验 SDK 已在 US 会话预载");
      }

      if (baselineCheckout) {
        await reportProgress("正在复用绑卡临时账单的原始 Checkout 身份", {
          flow: "isolated_card_flow",
          sessionKind: extractAnyCheckoutSessionId(baselineCheckout).startsWith("oaics_") ? "oaics" : "standard"
        });
      } else {
        baselineCheckout = await runtime.requestJson(CHECKOUT_ENDPOINT, {
          method: "POST",
          headers: accountCheckoutHeaders(
            usSession.accessToken,
            core.getSessionAccountId(usSession.session),
            CHECKOUT_ENDPOINT,
            { "Content-Type": "application/json" }
          ),
          body: core.buildBaselineCheckoutPayload(),
          stage: "US baseline checkout"
        });
      }
      let fallbackNavigable = resolveNavigableCheckout(baselineCheckout);
      await reportProgress(reusedCheckoutSeed
        ? "原始 Checkout 身份已恢复，正在执行 US/TR 代理预检"
        : "US 基线 Checkout 已创建，正在切换到 TR 代理");

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
      const accountId = accountContext.accountId || core.getSessionAccountId(trSession.session);
      let couponEligibility = Object.freeze({ known: false, eligible: false, status: "unavailable" });
      const couponQuery = new URLSearchParams({
        coupon: campaignId,
        is_coupon_from_query_param: "false"
      });
      for (const endpoint of PROMOTION_COUPON_ENDPOINTS) {
        const route = `${endpoint}?${couponQuery}`;
        try {
          const couponPayload = await runtime.requestJson(route, {
            headers: accountCheckoutHeaders(trSession.accessToken, accountId, endpoint),
            stage: "Promotion coupon eligibility"
          });
          couponEligibility = summarizeCouponEligibility(couponPayload);
          break;
        } catch (error) {
          if (error && error.code === "CHECKOUT_SESSION_EXPIRED") throw error;
          if (Number(error && error.status) !== 404) break;
        }
      }
      const accountCampaignEligible = accountContext.eligibleCampaignIds.includes(campaignId);
      const officialPromotionEligible = accountCampaignEligible || couponEligibility.eligible;
      const promotionPathEligible = officialPromotionEligible
        || paymentPreflight.oneClickTrialEligible;
      await reportProgress("已解析账户活动上下文", {
        campaignId,
        account: core.summarizeAccountPromotionContext(accountContext),
        oneClickTrialEligible: paymentPreflight.oneClickTrialEligible,
        couponEligibilityStatus: couponEligibility.status,
        couponEligible: couponEligibility.eligible,
        officialPromotionEligible,
        promotionPathEligible
      });
      const baselineSessionId = extractAnyCheckoutSessionId(baselineCheckout);
      let checkout = null;
      let preferredCheckout = baselineCheckout;
      let preferredNavigable = fallbackNavigable;
      let promotionVerification = "unverified";
      let authoritativeDiscount = null;

      if (officialPromotionEligible && !reusedCheckoutSeed
          && typeof runtime.createPromotedCheckoutFromPricing === "function") {
        await reportProgress("正在通过 TR 官方定价页核验免费 Plus 报价并创建 Checkout");
        const officialPromotion = await runtime.createPromotedCheckoutFromPricing({ campaignId });
        checkout = officialPromotion.checkout;
        preferredCheckout = officialPromotion.checkout;
        authoritativeDiscount = officialPromotion.fullDiscount;
        promotionVerification = "tr_official_pricing_ui";
        const officialResolved = resolveInternalCheckout(officialPromotion.checkout)
          || resolveNavigableCheckout(officialPromotion.checkout);
        preferredNavigable = Object.freeze({
          ...(officialResolved || {}),
          payload: officialPromotion.checkout,
          checkoutUrl: officialPromotion.checkoutUrl,
          route: officialResolved && officialResolved.route || "chatgpt_internal",
          oaicsSessionId: officialResolved && officialResolved.oaicsSessionId || "",
          sessionKind: officialResolved && officialResolved.sessionKind || "standard"
        });
        await reportProgress("TR 官方定价页已确认首月 100% 优惠与本次应付 0，并返回 Checkout", {
          promotionApplied: true,
          fullDiscountVerified: true,
          discountPercent: authoritativeDiscount.discountPercent,
          dueTodayMinorUnits: authoritativeDiscount.dueTodayMinorUnits,
          shape: core.describeCheckoutResponseShape(officialPromotion.checkout),
          promotion: core.summarizePromotionState(officialPromotion.checkout)
        });
      }

      if (!checkout && baselineSessionId) {
        await reportProgress("正在通过 TR 将活动更新到 US 阶段创建的同一个 Checkout");
        try {
          const updated = await runtime.requestJson(CHECKOUT_UPDATE_ENDPOINT, {
            method: "POST",
            headers: accountCheckoutHeaders(trSession.accessToken, accountId, CHECKOUT_UPDATE_ENDPOINT, {
              "Content-Type": "application/json"
            }),
            body: core.buildPromotionUpdatePayload({
              checkoutSessionId: baselineSessionId,
              processorEntity: checkoutProcessorEntity(baselineCheckout),
              campaignId
            }),
            stage: "TR same-session checkout promotion update"
          });
          const merged = mergeSameSessionCheckout(baselineCheckout, updated, baselineSessionId);
          const updateApplied = Boolean(merged && core.hasAppliedPromotion(merged));
          if (merged) preferredCheckout = merged;
          await reportProgress("TR 同会话活动更新已返回", {
            sameSession: Boolean(merged),
            promotionApplied: updateApplied,
            shape: core.describeCheckoutResponseShape(updated),
            identifiers: core.describeCheckoutIdentifiers(updated),
            promotion: core.summarizePromotionState(updated)
          });
          if (updateApplied) {
            checkout = merged;
            promotionVerification = "same_session_update";
          }
        } catch (error) {
          if (error && error.code === "CHECKOUT_SESSION_EXPIRED") throw error;
          await reportProgress("TR 同会话活动更新暂未完成，保留 US Checkout 并回到 US 继续验证");
        }
      }

      await reportProgress("正在切回 US，确保提链、账单和最终验证保持同一国家");
      await runtime.switchProxy("US", sticky.US);
      await runtime.verifyExit("US");
      const finalUsSession = await runtime.readSession();
      await reportProgress("US 最终校验出口和登录会话已确认");

      const liveResolved = preferredNavigable || resolveInternalCheckout(preferredCheckout)
        || resolveNavigableCheckout(preferredCheckout);
      if (liveResolved && liveResolved.sessionKind === "standard"
          && typeof runtime.waitForCheckoutCustomSession === "function") {
        await reportProgress("正在从 Stripe Custom Checkout 读取实时折扣与本次应付金额");
        if (typeof runtime.refreshCheckout === "function") {
          await runtime.refreshCheckout(liveResolved.checkoutUrl);
        } else if (typeof runtime.navigateCheckout === "function") {
          await runtime.navigateCheckout(liveResolved.checkoutUrl);
        }
        const liveFinancials = await runtime.waitForCheckoutCustomSession(this.checkoutLoadWaitMs);
        const subtotalMinorUnits = liveFinancials.subtotalMinorUnits == null
          ? (liveFinancials.dueTodayMinorUnits == null
            ? null
            : liveFinancials.dueTodayMinorUnits + liveFinancials.discountMinorUnits)
          : liveFinancials.subtotalMinorUnits;
        const zeroAmountVerified = liveFinancials.dueTodayMinorUnits === 0;
        authoritativeDiscount = Object.freeze({
          fullDiscountVerified: zeroAmountVerified,
          zeroAmountVerified,
          discountPercent: liveFinancials.discountPercent,
          subtotalMinorUnits,
          discountMinorUnits: liveFinancials.discountMinorUnits,
          dueTodayMinorUnits: liveFinancials.dueTodayMinorUnits
        });
        promotionVerification = "stripe_custom_checkout";
        await reportProgress("Stripe Custom Checkout 实时金额已返回", {
          fullDiscountVerified: authoritativeDiscount.fullDiscountVerified,
          discountPercent: authoritativeDiscount.discountPercent,
          subtotalMinorUnits: authoritativeDiscount.subtotalMinorUnits,
          discountMinorUnits: authoritativeDiscount.discountMinorUnits,
          dueTodayMinorUnits: authoritativeDiscount.dueTodayMinorUnits
        });
      }

      if (promotionPathEligible && !authoritativeDiscount) {
        const verifiedBaseline = await this.verifyPromotionUnderUs({
          runtime,
          checkout: preferredCheckout,
          authenticated: finalUsSession,
          accountId,
          reportProgress
        });
        preferredCheckout = verifiedBaseline.checkout;
        preferredNavigable = verifiedBaseline.navigable || preferredNavigable;
        if (verifiedBaseline.promotionApplied) {
          checkout = verifiedBaseline.checkout;
          promotionVerification = verifiedBaseline.detailVerified
            ? "us_checkout_detail"
            : promotionVerification;
        }
      }

      if (!checkout && promotionPathEligible) {
        await reportProgress("同会话优惠尚未确认，正在 US 下生成带活动参数的 Checkout");
        let sentinelHeaders = null;
        for (let sentinelAttempt = 0; sentinelAttempt < 3; sentinelAttempt += 1) {
          try {
            sentinelHeaders = await runtime.acquireSentinelHeaders();
            break;
          } catch (error) {
            if (error && error.code === "CHECKOUT_SESSION_EXPIRED") throw error;
            if (sentinelAttempt >= 2 || typeof runtime.refreshCurrentPage !== "function") break;
            await reportProgress(`Sentinel 尚未加载，20 秒后仅刷新当前提链页并重试（${sentinelAttempt + 1}/2）`);
            await this.waitForCheckout(runtime, 20_000);
            await runtime.refreshCurrentPage();
          }
        }

        if (sentinelHeaders) {
          const attempts = [
            core.buildShortPromotionPayload({ campaignId, country: "US", currency: "USD" }),
            core.buildPromotionCheckoutPayload({
              campaignId,
              oneClickTrial: paymentPreflight.oneClickTrialEligible,
              country: "US",
              currency: "USD"
            })
          ];
          for (const [attemptIndex, body] of attempts.entries()) {
            let candidate;
            try {
              candidate = await runtime.requestJson(CHECKOUT_ENDPOINT, {
                method: "POST",
                headers: accountCheckoutHeaders(finalUsSession.accessToken, accountId, CHECKOUT_ENDPOINT, {
                  ...sentinelHeaders,
                  "Content-Type": "application/json"
                }),
                body,
                stage: "US promoted checkout"
              });
            } catch (error) {
              if (error && error.code === "CHECKOUT_SESSION_EXPIRED") throw error;
              continue;
            }
            const navigableCandidate = resolveNavigableCheckout(candidate);
            if (!navigableCandidate) continue;
            preferredCheckout = candidate;
            preferredNavigable = resolveInternalCheckout(candidate) || navigableCandidate;
            const verifiedCandidate = await this.verifyPromotionUnderUs({
              runtime,
              checkout: candidate,
              authenticated: finalUsSession,
              accountId,
              reportProgress
            });
            preferredCheckout = verifiedCandidate.checkout;
            preferredNavigable = verifiedCandidate.navigable || preferredNavigable;
            await reportProgress(`US 活动 Checkout 尝试 ${attemptIndex + 1} 已完成`, {
              promotionApplied: verifiedCandidate.promotionApplied,
              checkoutCountry: "US",
              shape: core.describeCheckoutResponseShape(candidate),
              identifiers: core.describeCheckoutIdentifiers(candidate),
              promotion: core.summarizePromotionState(verifiedCandidate.checkout)
            });
            if (verifiedCandidate.promotionApplied) {
              checkout = verifiedCandidate.checkout;
              promotionVerification = verifiedCandidate.detailVerified
                ? "us_checkout_detail"
                : "us_checkout_response";
              break;
            }
          }
        } else {
          await reportProgress("Sentinel 暂未就绪，已保留同一个 US Checkout，等待后续复检");
        }
      }

      if (!checkout) checkout = preferredCheckout;
      let resolved = preferredNavigable || resolveInternalCheckout(checkout) || resolveNavigableCheckout(checkout);
      if (!resolved) throw new AppError(502, "CHECKOUT_URL_MISSING", "Checkout response did not include a navigable URL.");
      const fullDiscount = authoritativeDiscount || core.summarizeFullDiscountPromotion(checkout);
      const zeroAmountVerified = fullDiscount.zeroAmountVerified === true
        || (fullDiscount.fullDiscountVerified === true && fullDiscount.dueTodayMinorUnits === 0);
      const promotionApplied = zeroAmountVerified;
      if (!promotionApplied) {
        await reportProgress("Checkout 链接已生成，等待零金额订阅准备阶段复核", {
          discountPercent: fullDiscount.discountPercent,
          subtotalMinorUnits: fullDiscount.subtotalMinorUnits,
          discountMinorUnits: fullDiscount.discountMinorUnits,
          dueTodayMinorUnits: fullDiscount.dueTodayMinorUnits
        });
      }
      const checkoutUrl = resolved.checkoutUrl;
      const route = resolved.route;
      const sessionKind = resolved.sessionKind;
      const promotionStatus = promotionApplied
        ? "applied"
        : fullDiscount.dueTodayMinorUnits > 0
          ? "nonzero_due"
          : "pending_zero_amount_verification";

      await runtime.saveSession(session.path);
      await reportProgress(promotionApplied
        ? "US → TR → US 提链完成，零金额已验证并写入当前任务"
        : "US → TR → US 协议提链完成；链接已写入，等待零金额验证");
      return Object.freeze({
        checkoutUrl,
        campaignId,
        promotionApplied,
        fullDiscountVerified: zeroAmountVerified,
        zeroAmountVerified,
        discountPercent: fullDiscount.discountPercent,
        subtotalMinorUnits: fullDiscount.subtotalMinorUnits,
        discountMinorUnits: fullDiscount.discountMinorUnits,
        dueTodayMinorUnits: fullDiscount.dueTodayMinorUnits,
        promotionStatus,
        promotionVerification,
        sessionKind,
        route,
        checkoutCountry: promotionVerification === "stripe_custom_checkout" ? "US" : authoritativeDiscount ? "TR" : "US",
        proxyFlow: Object.freeze(["US", "TR", "US"]),
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
  CHECKOUT_ENDPOINT,
  CheckoutProtocolRuntime,
  ChatGptCheckoutLinkClient,
  authHeaders,
  normalizeAccountSession,
  normalizeCheckoutProxies,
  rotateStickyProxyCredential,
  summarizeCouponEligibility
};
