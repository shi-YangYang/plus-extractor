"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { AppError } = require("../lib/errors");
const { sanitizeText } = require("../lib/sanitize");
const { maskEmail } = require("./mailbox-code-reader");
const { normalizeRegistrationIdentity } = require("./registration-identity");

const CHATGPT_HOME = "https://chatgpt.com/";
const CHATGPT_SIGNUP = "https://chatgpt.com/auth/login?next=%2F&screen_hint=signup";
const CHATGPT_TRACE = "https://chatgpt.com/cdn-cgi/trace";
const CHATGPT_SESSION = "https://chatgpt.com/api/auth/session";
const AUTH_PREFLIGHT = "https://auth.openai.com/";
const PLUS_TRIAL_CAMPAIGN_ID = "plus-1-month-free";
const PLUS_TRIAL_COUPON_ENDPOINT = "/backend-api/promo_campaign/check_coupon";

function terminationError(signal) {
  if (signal && signal.reason instanceof AppError) return signal.reason;
  return new AppError(409, "TASK_TERMINATED", "The current task was terminated by the user.");
}

function throwIfTerminated(signal) {
  if (signal && signal.aborted) throw terminationError(signal);
}

function normalizeRoxyRegistrationFailure(error) {
  if (error instanceof AppError) return error;
  const rawMessage = String(error && error.message || "");
  const networkCode = rawMessage.match(/\b(?:net::)?(ERR_(?:PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED|CONNECTION_RESET|CONNECTION_CLOSED|CONNECTION_TIMED_OUT|TIMED_OUT))\b/i);
  if (networkCode) {
    return new AppError(
      502,
      "ROXY_PROFILE_NETWORK_FAILED",
      `RoxyBrowser profile navigation failed with ${networkCode[1].toUpperCase()}.`,
      error
    );
  }
  if (/Target page, context or browser has been closed|WebSocket (?:connection )?(?:is )?(?:not open|closed)|Browser has been closed/i.test(rawMessage)) {
    return new AppError(502, "ROXY_PROFILE_DISCONNECTED", "RoxyBrowser profile disconnected while registration was opening.", error);
  }
  const name = String(error && error.name || "BROWSER_ERROR");
  const summary = sanitizeText(rawMessage.split(/\r?\n/, 1)[0], 180).replace(/[.\s]+$/, "");
  return new AppError(
    502,
    "ROXY_REGISTRATION_FAILED",
    `RoxyBrowser registration failed: ${name}${summary ? `: ${summary}` : ""}.`,
    error
  );
}

function loadChromium() {
  try {
    return require("playwright-core").chromium;
  } catch (error) {
    throw new AppError(503, "PLAYWRIGHT_NOT_INSTALLED", "RoxyBrowser registration requires the local Playwright runtime.", error);
  }
}

function parseTrace(text) {
  return Object.fromEntries(String(text || "")
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split("=", 2))
    .filter((parts) => parts.length === 2));
}

function hasConfiguredProfileProxy(profile) {
  const category = String(profile && profile.proxyCategory || "").trim().toLowerCase();
  return Boolean(category && category !== "noproxy");
}

function createRoxyMailboxRequester(context, options = {}) {
  let mailboxPage = null;
  let closed = false;
  const signal = options.signal || null;
  const foregroundPage = options.foregroundPage || null;

  const close = async () => {
    closed = true;
    const activePage = mailboxPage;
    mailboxPage = null;
    if (activePage && !activePage.isClosed()) await activePage.close().catch(() => {});
  };

  const requestText = async (input, _proxy, requestOptions = {}) => {
    throwIfTerminated(signal);
    if (closed) {
      throw new AppError(409, "ROXY_MAILBOX_REQUEST_CLOSED", "The RoxyBrowser mailbox request context is closed.");
    }
    if (!mailboxPage || mailboxPage.isClosed()) {
      mailboxPage = await context.newPage();
      await mailboxPage.setExtraHTTPHeaders({
        accept: "text/html,application/json;q=0.9,*/*;q=0.8",
        "cache-control": "no-cache, no-store",
        pragma: "no-cache"
      }).catch(() => {});
    }
    const timeoutMs = Number(requestOptions.timeoutMs) || 20_000;
    const maxBytes = Number(requestOptions.maxBytes) || (2 * 1024 * 1024);
    try {
      const response = await mailboxPage.goto(String(input), {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs
      });
      if (!response) {
        throw new AppError(502, "ROXY_MAILBOX_RESPONSE_MISSING", "The mailbox page did not return an HTTP response through the RoxyBrowser profile.");
      }
      const body = await response.text();
      if (Buffer.byteLength(body, "utf8") > maxBytes) {
        throw new AppError(502, "ROXY_MAILBOX_RESPONSE_TOO_LARGE", "The mailbox response exceeded the configured size limit.");
      }
      const headers = typeof response.allHeaders === "function"
        ? await response.allHeaders()
        : typeof response.headers === "function" ? response.headers() : {};
      return Object.freeze({ status: response.status(), headers, text: body });
    } finally {
      if (foregroundPage && !foregroundPage.isClosed()) await foregroundPage.bringToFront().catch(() => {});
    }
  };

  return Object.freeze({ requestText, close });
}

async function visibleLocator(candidates) {
  for (const locator of candidates) {
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
  }
  return null;
}

async function locatorInputValue(locator) {
  if (!locator) return "";
  if (typeof locator.inputValue === "function") return String(await locator.inputValue());
  if (typeof locator.evaluate === "function") {
    return String(await locator.evaluate((element) => element && element.value || ""));
  }
  return "";
}

async function fillHydratedInput(page, locator, value, options = {}) {
  const expected = String(value || "");
  const attempts = Math.max(1, Math.min(Number(options.attempts) || 3, 5));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    throwIfTerminated(options.signal);
    await locator.fill(expected);
    await page.waitForTimeout(Number(options.settleMs) || 300);
    if (await locatorInputValue(locator).catch(() => "") === expected) return attempt + 1;
  }
  throw new AppError(
    502,
    options.code || "ROXY_FORM_INPUT_UNSTABLE",
    options.message || "RoxyBrowser form input was replaced before its value became stable."
  );
}

async function waitForStableCondition(page, predicate, options = {}) {
  const deadline = Date.now() + (Number(options.timeoutMs) || 10_000);
  const consecutiveRequired = Math.max(1, Number(options.consecutive) || 2);
  let consecutive = 0;
  while (Date.now() < deadline) {
    throwIfTerminated(options.signal);
    if (await predicate()) {
      consecutive += 1;
      if (consecutive >= consecutiveRequired) return true;
    } else {
      consecutive = 0;
    }
    await page.waitForTimeout(Number(options.pollMs) || 250);
  }
  return false;
}

async function inspectPageDocument(page) {
  const [title, bodyText, controlCount, readyState] = await Promise.all([
    page.title().catch(() => ""),
    page.locator("body").innerText().catch(() => ""),
    page.locator("form, input, button, main, [role=alert], iframe").count().catch(() => 0),
    page.evaluate(() => document.readyState).catch(() => "")
  ]);
  const titleLength = String(title || "").trim().length;
  const bodyTextLength = String(bodyText || "").trim().length;
  return Object.freeze({
    meaningful: Boolean(titleLength || bodyTextLength || Number(controlCount)),
    titleLength,
    bodyTextLength,
    controlCount: Number(controlCount) || 0,
    readyState: String(readyState || "")
  });
}

async function meaningfulDocumentVisible(page) {
  return Boolean((await inspectPageDocument(page)).meaningful);
}

async function waitForMeaningfulDocument(page, options = {}) {
  let snapshot = null;
  const ready = await waitForStableCondition(page, async () => {
    snapshot = await inspectPageDocument(page);
    return snapshot.meaningful;
  }, {
    timeoutMs: Number(options.timeoutMs) || 4_000,
    pollMs: Number(options.pollMs) || 250,
    consecutive: Number(options.consecutive) || 2,
    signal: options.signal
  });
  return ready ? snapshot : null;
}

function safePageLocation(value) {
  try {
    const parsed = new URL(String(value || ""));
    return Object.freeze({ pageHost: parsed.hostname, pagePath: parsed.pathname });
  } catch {
    return Object.freeze({ pageHost: "", pagePath: "" });
  }
}

async function loadMeaningfulDocument(page, options = {}) {
  const attempts = Math.max(1, Math.min(Number(options.attempts) || 2, 3));
  const timeoutMs = Math.max(3_000, Number(options.timeoutMs) || 20_000);
  const mode = options.mode === "reload" ? "reload" : "goto";
  const targetUrl = String(options.url || page.url() || "");
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    throwIfTerminated(options.signal);
    if (attempt > 0 && options.reportProgress) {
      await options.reportProgress("RoxyBrowser detected an empty authentication document and is retrying the bounded navigation.", {
        roxyState: "AUTH_DOCUMENT_RETRY",
        attempt: attempt + 1,
        ...safePageLocation(targetUrl)
      });
    }
    await page.evaluate(() => window.stop()).catch(() => {});
    try {
      const response = mode === "reload"
        ? await page.reload({ waitUntil: "domcontentloaded", timeout: timeoutMs })
        : await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      const status = response && typeof response.status === "function" ? Number(response.status()) : null;
      if (status != null && status >= 500) {
        throw new AppError(
          502,
          options.httpCode || "ROXY_AUTH_DOCUMENT_HTTP_FAILED",
          `RoxyBrowser authentication document returned HTTP ${status}.`
        );
      }
      const snapshot = await waitForMeaningfulDocument(page, {
        timeoutMs: Math.min(Math.max(10, Number(options.documentTimeoutMs) || 5_000), timeoutMs),
        signal: options.signal
      });
      if (snapshot) return Object.freeze({ status, snapshot, ...safePageLocation(page.url()) });
      lastError = new AppError(
        502,
        options.blankCode || "ROXY_AUTH_PAGE_BLANK",
        options.blankMessage || "RoxyBrowser authentication navigation returned an empty document."
      );
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError instanceof AppError) throw lastError;
  throw new AppError(
    502,
    options.networkCode || "ROXY_AUTH_PAGE_NETWORK_FAILED",
    options.networkMessage || "RoxyBrowser authentication navigation did not return a usable document within the bounded timeout.",
    lastError
  );
}

function isRoxyControlFailure(error) {
  return Boolean(error && [
    "ROXY_BRIDGE_UNAVAILABLE",
    "ROXY_INSPECTOR_TARGET_MISSING",
    "ROXY_BRIDGE_RECOVERY_TIMEOUT"
  ].includes(String(error.code || "")));
}

async function challengeVisible(page) {
  if (await page.locator('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], iframe[src*="hcaptcha.com"]').count()) {
    return true;
  }
  return Boolean(await visibleLocator([
    page.getByText(/Verify you are human|验证您是真人|人机验证/i),
    page.locator('[data-testid*="challenge"]')
  ]));
}

async function waitForVisible(page, candidates, options = {}) {
  const timeoutMs = Number(options.timeoutMs) || 90_000;
  const deadline = Date.now() + timeoutMs;
  let challengeReported = false;
  while (Date.now() < deadline) {
    throwIfTerminated(options.signal);
    const found = await visibleLocator(candidates);
    if (found) return found;
    if (!challengeReported && await challengeVisible(page)) {
      challengeReported = true;
      if (options.reportProgress) {
        await options.reportProgress("RoxyBrowser is waiting for the visible human-verification step to finish.", {
          roxyState: "CHALLENGE"
        });
      }
    }
    await page.waitForTimeout(250);
  }
  throw new AppError(
    504,
    options.code || "ROXY_REGISTRATION_PAGE_TIMEOUT",
    options.message || "RoxyBrowser registration did not reach the expected page state."
  );
}

function validAuthenticatedSession(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && String(value.accessToken || "").trim()
    ? value
    : null;
}

function summarizePlusTrialEligibility(input = {}) {
  const payload = input.payload && typeof input.payload === "object" ? input.payload : {};
  const state = String(payload.state || payload.status || payload.eligibility || "").trim().toLowerCase();
  const explicit = typeof payload.eligible === "boolean"
    ? payload.eligible
    : typeof payload.is_eligible === "boolean" ? payload.is_eligible : null;
  const redemption = payload.redemption && typeof payload.redemption === "object" ? payload.redemption : {};
  const redeemed = redemption.redeemed === true
    || redemption.redeemed_by_user === true
    || redemption.redeemed_by_workspace === true;
  const buttonVisible = input.buttonVisible === true;
  const couponEligible = explicit === true || /^(?:eligible|available|active)$/.test(state);
  const couponIneligible = explicit === false
    || /^(?:not_eligible|ineligible|unavailable|inactive|expired|redeemed)$/.test(state);
  const eligible = !redeemed && (couponEligible || buttonVisible);
  const status = eligible ? "eligible" : redeemed || couponIneligible ? "ineligible" : "unknown";
  const source = couponEligible && buttonVisible
    ? "coupon_api_and_visible_offer"
    : couponEligible
      ? "coupon_api"
      : buttonVisible
        ? "visible_offer"
        : status === "ineligible" ? "coupon_api" : "unavailable";
  return Object.freeze({
    campaignId: PLUS_TRIAL_CAMPAIGN_ID,
    status,
    eligible,
    redeemed,
    couponStatus: state || "unknown",
    couponHttpStatus: Number(input.httpStatus) || 0,
    buttonVisible,
    source,
    checkedAt: input.checkedAt || new Date().toISOString()
  });
}

async function inspectPlusTrialEligibility(page, authSession, checkedAt = new Date().toISOString()) {
  const accessToken = String(authSession && authSession.accessToken || "").trim();
  if (!page || page.isClosed() || !accessToken) {
    return summarizePlusTrialEligibility({ checkedAt });
  }
  try {
    if (new URL(page.url()).hostname !== "chatgpt.com") {
      await page.goto(CHATGPT_HOME, { waitUntil: "domcontentloaded", timeout: 30_000 });
    }
    await page.waitForTimeout(1_000);
    const snapshot = await page.evaluate(async ({ endpoint, campaignId, accessToken: token }) => {
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const offerPattern = /(?:free offer|free trial|trial offer|\u7121\u6599\u30aa\u30d5\u30a1\u30fc|\u7121\u6599\u30c8\u30e9\u30a4\u30a2\u30eb|\u8a66\u7528|\u514d\u8d39\u4f18\u60e0|\u514d\u8d39\u512a\u60e0|\u8bd5\u7528)/i;
      const buttonVisible = [...document.querySelectorAll("a,button,[role='button']")].some((element) => {
        const label = normalize(element.innerText || element.textContent || element.getAttribute("aria-label"));
        const link = element instanceof HTMLAnchorElement
          ? element.href
          : element.closest("a") && element.closest("a").href || "";
        return link.includes(`promo_campaign=${campaignId}`) || offerPattern.test(label);
      });
      const query = new URLSearchParams({
        coupon: campaignId,
        is_coupon_from_query_param: "true"
      });
      const response = await fetch(`${endpoint}?${query}`, {
        credentials: "include",
        cache: "no-store",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          "oai-language": document.documentElement.lang || "en-US"
        }
      });
      let payload = null;
      try { payload = await response.json(); } catch {}
      return { httpStatus: response.status, payload, buttonVisible };
    }, {
      endpoint: PLUS_TRIAL_COUPON_ENDPOINT,
      campaignId: PLUS_TRIAL_CAMPAIGN_ID,
      accessToken
    });
    return summarizePlusTrialEligibility({ ...snapshot, checkedAt });
  } catch {
    return summarizePlusTrialEligibility({ checkedAt });
  }
}

async function readAuthenticatedSession(context, page = null) {
  const sessionUrl = `${CHATGPT_SESSION}?_=${Date.now()}`;
  try {
    const response = await context.request.get(sessionUrl, {
      headers: {
        accept: "application/json",
        "cache-control": "no-cache, no-store",
        pragma: "no-cache"
      },
      timeout: 10_000
    });
    if (response.ok()) {
      try {
        const session = validAuthenticatedSession(await response.json());
        if (session) return session;
      } catch {
        // The page-origin fallback below can still read a freshly hydrated session.
      }
    }
  } catch {
    // A request-context timeout must not suppress the same-origin browser fallback.
  }
  if (!page || page.isClosed()) return null;
  try {
    const value = await page.evaluate(async (url) => {
      const result = await fetch(url, {
        credentials: "include",
        cache: "no-store",
        headers: { accept: "application/json", "cache-control": "no-cache" }
      });
      return result.ok ? result.json() : null;
    }, sessionUrl);
    return validAuthenticatedSession(value);
  } catch {
    return null;
  }
}

async function accountCreationFailure(page) {
  if (!page || page.isClosed()) return false;
  try {
    const bodyText = String(await page.locator("body").innerText({ timeout: 1_000 }) || "");
    if (/error_code\s*:\s*account_deactivated/i.test(bodyText)
        || /account (?:was |is )?(?:deleted|deactivated)/i.test(bodyText)) {
      return Object.freeze({
        code: "ROXY_ACCOUNT_DEACTIVATED",
        message: "The upstream email-verification page reports that this account is deactivated."
      });
    }
    const lines = bodyText
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    if (lines.some((line) => (
      (/利用規約/i.test(line) && /アカウント/i.test(line) && /作成できません/i.test(line))
      || (/terms(?: of use)?/i.test(line)
        && /account/i.test(line)
        && (/(?:not|failed).{0,32}creat/i.test(line) || /creat.{0,32}(?:not|failed)/i.test(line)))
    ))) {
      return Object.freeze({
        code: "ROXY_ACCOUNT_CREATION_REJECTED",
        message: "The upstream terms check rejected this account-creation submission."
      });
    }
    return null;
  } catch {
    return null;
  }
}

async function accountCreationRejected(page) {
  return Boolean(await accountCreationFailure(page));
}

async function continueOnboardingCompletion(page, reportProgress = async () => {}) {
  if (!page || page.isClosed()) return false;
  let bodyText = "";
  try {
    const current = new URL(page.url());
    if (current.hostname !== "chatgpt.com") return false;
    bodyText = String(await page.locator("body").innerText({ timeout: 1_000 }) || "");
  } catch {
    return false;
  }
  if (!/(?:準備が完了しました|you(?:'|’)re all set|you(?:'|’)re ready|setup (?:is )?complete)/i.test(bodyText)) {
    return false;
  }
  const continueButton = await visibleLocator([
    page.getByRole("button", { name: /^(?:Continue|続行|继续|繼續)$/i }),
    page.locator('button[type="submit"]')
  ]);
  if (!continueButton) return false;
  await continueButton.click();
  await reportProgress("RoxyBrowser accepted the final onboarding screen and is hydrating the authenticated session.", {
    roxyState: "ONBOARDING_CONTINUED"
  });
  return true;
}

async function authenticatedHomeVisible(page) {
  if (!page || page.isClosed()) return false;
  try {
    const current = new URL(page.url());
    if (current.hostname !== "chatgpt.com" || current.pathname !== "/") return false;
    return Boolean(await visibleLocator([
      page.locator('[data-testid="composer-text-input"]'),
      page.locator("#prompt-textarea"),
      page.locator('[contenteditable="true"]')
    ]));
  } catch {
    return false;
  }
}

async function inspectSessionResponseShape(context, page) {
  const summarize = async (response) => {
    const summary = {
      status: Number(response.status()) || 0,
      contentType: String(response.headers()["content-type"] || "").slice(0, 120),
      keys: [],
      hasAccessToken: false
    };
    try {
      const value = await response.json();
      summary.keys = value && typeof value === "object" && !Array.isArray(value)
        ? Object.keys(value).slice(0, 30)
        : [];
      summary.hasAccessToken = Boolean(value && String(value.accessToken || "").trim());
    } catch {
      summary.parse = "non_json";
    }
    return summary;
  };
  let requestContext = null;
  let pageOrigin = null;
  try {
    requestContext = await summarize(await context.request.get(`${CHATGPT_SESSION}?probe=${Date.now()}`, {
      headers: { accept: "application/json", "cache-control": "no-cache, no-store", pragma: "no-cache" },
      timeout: 15_000
    }));
  } catch (error) {
    requestContext = { error: String(error && error.name || "REQUEST_FAILED").slice(0, 80) };
  }
  if (page && !page.isClosed()) {
    try {
      pageOrigin = await page.evaluate(async (url) => {
        try {
          const response = await fetch(url, {
            credentials: "include",
            cache: "no-store",
            headers: { accept: "application/json", "cache-control": "no-cache, no-store" }
          });
          const contentType = String(response.headers.get("content-type") || "").slice(0, 120);
          let value = null;
          try { value = await response.json(); } catch {}
          return {
            status: response.status,
            contentType,
            keys: value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).slice(0, 30) : [],
            hasAccessToken: Boolean(value && String(value.accessToken || "").trim())
          };
        } catch (error) {
          return { error: String(error && error.name || "FETCH_FAILED").slice(0, 80) };
        }
      }, `${CHATGPT_SESSION}?probe=${Date.now()}`);
    } catch (error) {
      pageOrigin = { error: String(error && error.name || "PAGE_EVALUATE_FAILED").slice(0, 80) };
    }
  }
  return Object.freeze({ requestContext, pageOrigin });
}

async function waitForAuthenticatedSession(context, page, timeoutMs = 90_000, signal = null) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    throwIfTerminated(signal);
    const session = await readAuthenticatedSession(context, page).catch(() => null);
    if (session) return session;
    const accountFailure = await accountCreationFailure(page);
    if (accountFailure) {
      let pageState = {};
      try {
        const current = new URL(page.url());
        pageState = {
          pageHost: current.hostname,
          pagePath: current.pathname,
          pageTitle: String(await page.title().catch(() => "")).slice(0, 120)
        };
      } catch {
        pageState = {};
      }
      throw new AppError(
        409,
        accountFailure.code,
        accountFailure.message,
        pageState
      );
    }
    await page.waitForTimeout(500);
  }
  let pageState = {};
  try {
    const current = new URL(page.url());
    pageState = {
      pageHost: current.hostname,
      pagePath: current.pathname,
      pageTitle: String(await page.title().catch(() => "")).slice(0, 120)
    };
  } catch {
    pageState = {};
  }
  throw new AppError(
    504,
    "ROXY_AUTH_SESSION_TIMEOUT",
    "RoxyBrowser completed the form but did not return an authenticated account session in time.",
    pageState
  );
}

class ChatGptRoxyRegistrationClient {
  constructor(options = {}) {
    this.bridge = options.bridge;
    this.chromium = options.chromium || null;
    this.sessionDirectory = path.resolve(options.sessionDirectory || path.join(__dirname, "../../data/sessions"));
    this.diagnosticDirectory = path.resolve(options.diagnosticDirectory || path.join(this.sessionDirectory, "../diagnostics"));
    this.navigationTimeoutMs = Number(options.navigationTimeoutMs) || 90_000;
    this.authDocumentTimeoutMs = Math.min(this.navigationTimeoutMs, Number(options.authDocumentTimeoutMs) || 20_000);
    this.now = options.now || (() => new Date());
  }

  async captureAuthDiagnostic({ taskId, page }) {
    const safeTaskId = /^[0-9a-f-]{16,}$/i.test(String(taskId || ""))
      ? String(taskId)
      : "roxy-registration";
    const stamp = this.now().toISOString().replace(/[^0-9]/g, "").slice(0, 17);
    const base = path.join(this.diagnosticDirectory, `${safeTaskId}-${stamp}`);
    await fs.mkdir(this.diagnosticDirectory, { recursive: true });
    let pageUrl = "";
    let pageTitle = "";
    let pageText = "";
    let controls = [];
    try {
      pageUrl = page.url();
      pageTitle = String(await page.title().catch(() => "")).slice(0, 160);
      pageText = String(await page.locator("body").innerText().catch(() => "")).slice(0, 8_000);
      controls = await page.locator("input, button, [role=alert]").evaluateAll((elements) => elements.slice(0, 80).map((element) => ({
        tag: element.tagName.toLowerCase(),
        type: element.getAttribute("type") || "",
        name: element.getAttribute("name") || "",
        role: element.getAttribute("role") || "",
        placeholder: element.getAttribute("placeholder") || "",
        text: String(element.innerText || "").slice(0, 200),
        disabled: Boolean(element.disabled),
        validationMessage: String(element.validationMessage || "").slice(0, 300)
      })));
    } catch {
      // The screenshot and the fields already collected still provide a useful local trace.
    }
    const screenshotPath = `${base}.png`;
    const jsonPath = `${base}.json`;
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    await fs.writeFile(jsonPath, `${JSON.stringify({
      capturedAt: this.now().toISOString(),
      pageUrl,
      pageTitle,
      pageText,
      controls
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    let pageHost = "";
    let pagePath = "";
    try {
      const parsed = new URL(pageUrl);
      pageHost = parsed.hostname;
      pagePath = parsed.pathname;
    } catch {
      // Keep redacted URL fields empty.
    }
    return Object.freeze({ pageHost, pagePath, pageTitle, screenshotPath, jsonPath });
  }

  describe() {
    return Object.freeze({
      transport: "roxybrowser_webui",
      formAutomation: true,
      accountsPerWindow: 2,
      maxWindows: 15,
      profileProxyConfiguration: "existing_roxy_profile",
      sessionCommit: "storage_state_plus_auth_session"
    });
  }

  async clearChatGptState(browser, context, pages = []) {
    await context.clearCookies().catch(() => {});
    let cdp;
    try {
      cdp = await browser.newBrowserCDPSession();
      await cdp.send("Network.clearBrowserCache").catch(() => {});
      for (const origin of ["https://chatgpt.com", "https://auth.openai.com", "https://auth0.openai.com"]) {
        await cdp.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" }).catch(() => {});
      }
    } finally {
      if (cdp) await cdp.detach().catch(() => {});
    }
    const keeper = pages.find((page) => {
      try {
        return new URL(page.url()).hostname === "127.0.0.1";
      } catch {
        return false;
      }
    }) || pages[0] || null;
    for (const page of pages) {
      if (!page || page.isClosed()) continue;
      if (page === keeper) continue;
      await page.close().catch(() => {});
    }
  }

  async commitSession({ taskId, context, authSession }) {
    const safeTaskId = /^[0-9a-f-]{16,}$/i.test(String(taskId || ""))
      ? String(taskId)
      : `roxy-${Date.now()}`;
    const storagePath = path.join(this.sessionDirectory, `${safeTaskId}.storage.json`);
    const authSessionPath = path.join(this.sessionDirectory, `${safeTaskId}.auth-session.json`);
    const storageTemporary = `${storagePath}.${process.pid}.tmp`;
    const authTemporary = `${authSessionPath}.${process.pid}.tmp`;
    const storageState = await context.storageState();
    await fs.mkdir(this.sessionDirectory, { recursive: true });
    try {
      await fs.writeFile(storageTemporary, JSON.stringify(storageState), { encoding: "utf8", mode: 0o600, flag: "wx" });
      await fs.writeFile(authTemporary, JSON.stringify(authSession), { encoding: "utf8", mode: 0o600, flag: "wx" });
      await fs.rename(storageTemporary, storagePath);
      try {
        await fs.rename(authTemporary, authSessionPath);
      } catch (error) {
        await fs.unlink(storagePath).catch(() => {});
        throw error;
      }
      const [verifiedStorage, verifiedAuth] = await Promise.all([
        fs.readFile(storagePath, "utf8").then(JSON.parse),
        fs.readFile(authSessionPath, "utf8").then(JSON.parse)
      ]);
      if (!verifiedStorage || !Array.isArray(verifiedStorage.cookies)
          || !verifiedAuth || !String(verifiedAuth.accessToken || "").trim()) {
        throw new AppError(502, "ROXY_SESSION_COMMIT_INVALID", "RoxyBrowser account session verification failed after the atomic file commit.");
      }
      const committedAt = this.now().toISOString();
      return Object.freeze({
        kind: "playwright_storage_state",
        path: storagePath,
        authSessionPath,
        authSessionCachedAt: committedAt,
        authSessionExpiresAt: String(verifiedAuth.expires || "") || null,
        registrationMode: "roxybrowser"
      });
    } catch (error) {
      await Promise.allSettled([
        fs.unlink(storageTemporary),
        fs.unlink(authTemporary)
      ]);
      throw error;
    }
  }

  async fillProfile(page, identity, reportProgress, signal = null) {
    const nameInput = await visibleLocator([
      page.locator('input[name="name"]'),
      page.locator('input[autocomplete="name"]'),
      page.getByRole("textbox", { name: /Full name|Name|姓名|全名/i })
    ]);
    if (!nameInput) return false;
    await nameInput.fill(identity.fullName);

    const birthdate = identity.birthdate;
    const dateInput = await visibleLocator([
      page.locator('input[name="birthday"]'),
      page.locator('input[name="birthdate"]'),
      page.locator('input[type="date"]')
    ]);
    if (dateInput) {
      await dateInput.fill(birthdate);
    } else {
      const ageInput = await visibleLocator([
        page.locator('input[name="age"]'),
        page.locator('input[type="number"]'),
        page.getByRole("spinbutton", { name: /Age|年龄/i })
      ]);
      if (ageInput) await ageInput.fill(String(identity.age));
    }

    const submit = await waitForVisible(page, [
      page.getByRole("button", { name: /Create account|Continue|完成帐户创建|完成账户创建|继续/i }),
      page.locator('button[type="submit"]')
    ], {
      timeoutMs: 30_000,
      reportProgress,
      signal,
      code: "ROXY_PROFILE_SUBMIT_MISSING",
      message: "RoxyBrowser profile form submit button was not available."
    });
    await submit.click();
    await reportProgress("RoxyBrowser submitted the generated account profile.", { roxyState: "PROFILE_SUBMITTED" });
    return true;
  }

  async registerInContext({ browser, context, item, slotIndex, windowIndex, profileNumber = null }) {
    const reportProgress = item.reportProgress || (async () => {});
    const identity = normalizeRegistrationIdentity(item.identity);
    await reportProgress(`RoxyBrowser window ${windowIndex + 1}, account slot ${slotIndex + 1}/2 is opening.`, {
      roxyState: "OPENING",
      windowIndex,
      slotIndex,
      profileNumber
    });

    let page = null;
    let mailboxRequester = null;
    const abortPage = () => {
      if (mailboxRequester) mailboxRequester.close().catch(() => {});
      if (page) page.close().catch(() => {});
    };
    try {
      page = context.pages().find((candidate) => candidate && !candidate.isClosed()) || await context.newPage();
      await page.bringToFront().catch(() => {});
      mailboxRequester = createRoxyMailboxRequester(context, {
        signal: item.signal,
        foregroundPage: page
      });
      if (item.signal) item.signal.addEventListener("abort", abortPage, { once: true });
      page.setDefaultTimeout(this.navigationTimeoutMs);
      throwIfTerminated(item.signal);
      await loadMeaningfulDocument(page, {
        url: CHATGPT_TRACE,
        timeoutMs: this.authDocumentTimeoutMs,
        attempts: 2,
        reportProgress,
        signal: item.signal,
        blankCode: "ROXY_PROFILE_TRACE_BLANK",
        blankMessage: "RoxyBrowser JP exit preflight returned an empty document.",
        networkCode: "ROXY_PROFILE_NETWORK_FAILED",
        networkMessage: "RoxyBrowser JP exit preflight did not return within the bounded timeout."
      });
      const trace = parseTrace(await page.locator("body").innerText());
      if (trace.loc !== "JP") {
        throw new AppError(502, "ROXY_REGISTRATION_JP_EXIT_REQUIRED", `RoxyBrowser profile exit check returned ${trace.loc || "unknown"}; JP is required.`);
      }
      await reportProgress("RoxyBrowser profile exit is verified as JP.", { roxyState: "JP_VERIFIED" });

      const authPreflight = await loadMeaningfulDocument(page, {
        url: AUTH_PREFLIGHT,
        timeoutMs: this.authDocumentTimeoutMs,
        attempts: 2,
        reportProgress,
        signal: item.signal,
        blankCode: "ROXY_AUTH_PREFLIGHT_BLANK",
        blankMessage: "RoxyBrowser JP exit reached the authentication host but received an empty document.",
        networkCode: "ROXY_AUTH_PREFLIGHT_FAILED",
        networkMessage: "RoxyBrowser JP exit could not load the authentication host within the bounded timeout."
      });
      await reportProgress("RoxyBrowser authentication host preflight returned a usable document.", {
        roxyState: "AUTH_PREFLIGHT_VERIFIED",
        pageHost: authPreflight.pageHost,
        pagePath: authPreflight.pagePath,
        httpStatus: authPreflight.status
      });

      await loadMeaningfulDocument(page, {
        url: CHATGPT_SIGNUP,
        timeoutMs: this.authDocumentTimeoutMs,
        attempts: 2,
        reportProgress,
        signal: item.signal,
        blankCode: "ROXY_SIGNUP_PAGE_BLANK",
        blankMessage: "RoxyBrowser sign-up navigation returned an empty document.",
        networkCode: "ROXY_SIGNUP_PAGE_NETWORK_FAILED",
        networkMessage: "RoxyBrowser sign-up navigation did not return within the bounded timeout."
      });
      await page.bringToFront().catch(() => {});
      const mailboxBaseline = typeof item.readVerificationSnapshot === "function"
        ? await item.readVerificationSnapshot({
          timeoutMs: 30_000,
          requestText: mailboxRequester.requestText
        }).catch(() => null)
        : null;
      let emailInput = await visibleLocator([
        page.locator('input[type="email"]'),
        page.locator('input[name="email"]'),
        page.getByRole("textbox", { name: /Email address|Email|电子邮件|邮箱/i })
      ]);
      if (!emailInput) {
        const signup = await waitForVisible(page, [
          page.getByRole("button", { name: /Sign up|Sign up for free|免费注册/i }),
          page.locator('[data-testid="signup-button"]')
        ], {
          timeoutMs: this.navigationTimeoutMs,
          reportProgress,
          signal: item.signal,
          code: "ROXY_SIGNUP_ENTRY_TIMEOUT",
          message: "RoxyBrowser did not show the ChatGPT sign-up entry."
        });
        await signup.click();
        emailInput = await waitForVisible(page, [
          page.locator('input[type="email"]'),
          page.locator('input[name="email"]')
        ], { timeoutMs: this.navigationTimeoutMs, reportProgress, signal: item.signal, code: "ROXY_EMAIL_FORM_TIMEOUT" });
      }

      await fillHydratedInput(page, emailInput, item.email, {
        signal: item.signal,
        code: "ROXY_EMAIL_INPUT_UNSTABLE",
        message: "RoxyBrowser registration email input did not remain stable after page hydration."
      });
      let emailSubmit = await waitForVisible(page, [
        page.getByRole("button", { name: /Continue|继续/i }),
        page.locator('button[type="submit"]')
      ], { timeoutMs: 30_000, signal: item.signal, code: "ROXY_EMAIL_SUBMIT_MISSING" });
      const initialEmailUrl = page.url();
      let initialEmailAdvanced = false;
      for (let submitAttempt = 0; submitAttempt < 2 && !initialEmailAdvanced; submitAttempt += 1) {
        await page.bringToFront().catch(() => {});
        if (submitAttempt === 0) await emailSubmit.click();
        else await emailInput.press("Enter");
        initialEmailAdvanced = await waitForStableCondition(page, async () => {
          const earlyCode = await visibleLocator([
            page.locator('input[autocomplete="one-time-code"]'),
            page.locator('input[name="code"]')
          ]);
          if (earlyCode) return true;
          return page.url() !== initialEmailUrl && await meaningfulDocumentVisible(page);
        }, { timeoutMs: 8_000, signal: item.signal });
        if (!initialEmailAdvanced) {
          if (page.url() !== initialEmailUrl) {
            const recovered = await loadMeaningfulDocument(page, {
              url: page.url(),
              timeoutMs: this.authDocumentTimeoutMs,
              attempts: 2,
              reportProgress,
              signal: item.signal,
              blankCode: "ROXY_AUTH_PAGE_BLANK",
              blankMessage: "RoxyBrowser email submission reached an empty authentication document.",
              networkCode: "ROXY_AUTH_PAGE_NETWORK_FAILED"
            });
            initialEmailAdvanced = Boolean(recovered.snapshot.meaningful);
            if (initialEmailAdvanced) break;
          }
          emailInput = await waitForVisible(page, [
            page.locator('input[type="email"]'),
            page.locator('input[name="email"]')
          ], { timeoutMs: 10_000, signal: item.signal, code: "ROXY_EMAIL_FORM_TIMEOUT" });
          await fillHydratedInput(page, emailInput, item.email, {
            signal: item.signal,
            code: "ROXY_EMAIL_INPUT_UNSTABLE"
          });
          emailSubmit = await waitForVisible(page, [
            page.getByRole("button", { name: /Continue|继续/i }),
            page.locator('button[type="submit"]')
          ], { timeoutMs: 10_000, signal: item.signal, code: "ROXY_EMAIL_SUBMIT_MISSING" });
        }
      }
      if (!initialEmailAdvanced) {
        throw new AppError(504, "ROXY_EMAIL_SUBMIT_TIMEOUT", "RoxyBrowser registration email form did not advance after a verified submit.");
      }
      await reportProgress("RoxyBrowser submitted the registration email and is waiting for OTP.", { roxyState: "OTP_REQUESTED" });

      const repeatedEmailDeadline = Date.now() + 10_000;
      while (Date.now() < repeatedEmailDeadline) {
        throwIfTerminated(item.signal);
        let current;
        try { current = new URL(page.url()); } catch { current = null; }
        const repeatedEmail = current && current.pathname === "/auth/login" && current.searchParams.has("email")
          ? await visibleLocator([
            page.locator('input[type="email"]'),
            page.locator('input[name="email"]')
          ])
          : null;
        if (repeatedEmail) {
          let activeEmailInput = repeatedEmail;
          let repeatedComplete = false;
          for (let submitAttempt = 0; submitAttempt < 3 && !repeatedComplete; submitAttempt += 1) {
            await fillHydratedInput(page, activeEmailInput, item.email, {
              signal: item.signal,
              code: "ROXY_EMAIL_RESUBMIT_INPUT_UNSTABLE"
            });
            const repeatedSubmit = await waitForVisible(page, [
              page.getByRole("button", { name: /Continue|続行|继续|繼續/i }),
              page.locator('button[type="submit"]')
            ], { timeoutMs: 10_000, signal: item.signal, code: "ROXY_EMAIL_RESUBMIT_MISSING" });
            const repeatedUrl = page.url();
            await page.bringToFront().catch(() => {});
            if (submitAttempt === 0) await repeatedSubmit.click();
            else await activeEmailInput.press("Enter");
            repeatedComplete = await waitForStableCondition(page, async () => {
              const activeCode = await visibleLocator([
                page.locator('input[autocomplete="one-time-code"]'),
                page.locator('input[name="code"]')
              ]);
              if (activeCode) return true;
              return page.url() !== repeatedUrl && await meaningfulDocumentVisible(page);
            }, { timeoutMs: 8_000, signal: item.signal });
            if (!repeatedComplete && submitAttempt < 2) {
              await reportProgress("RoxyBrowser email confirmation did not advance; performing a bounded document reload before retrying.", {
                roxyState: "EMAIL_CONFIRM_RETRY",
                submitAttempt: submitAttempt + 1
              });
              await loadMeaningfulDocument(page, {
                mode: "reload",
                url: page.url(),
                timeoutMs: this.authDocumentTimeoutMs,
                attempts: 2,
                reportProgress,
                signal: item.signal,
                blankCode: "ROXY_AUTH_PAGE_BLANK",
                blankMessage: "RoxyBrowser email confirmation reload returned an empty authentication document.",
                networkCode: "ROXY_AUTH_PAGE_NETWORK_FAILED"
              });
              activeEmailInput = await waitForVisible(page, [
                page.locator('input[type="email"]'),
                page.locator('input[name="email"]')
              ], { timeoutMs: 15_000, signal: item.signal, code: "ROXY_EMAIL_RESUBMIT_FORM_MISSING" });
            }
          }
          if (!repeatedComplete) {
            throw new AppError(504, "ROXY_EMAIL_RESUBMIT_TIMEOUT", "RoxyBrowser upstream email confirmation did not advance after verified retries.");
          }
          await reportProgress("RoxyBrowser completed the upstream email confirmation step and is waiting for OTP.", {
            roxyState: "EMAIL_CONFIRMED"
          });
          break;
        }
        const earlyCodeInput = await visibleLocator([
          page.locator('input[autocomplete="one-time-code"]'),
          page.locator('input[name="code"]')
        ]);
        if (earlyCodeInput) break;
        await page.waitForTimeout(250);
      }

      let codeInput = await waitForVisible(page, [
        page.locator('input[autocomplete="one-time-code"]'),
        page.locator('input[name="code"]'),
        page.getByRole("textbox", { name: /Verification code|验证码/i })
      ], {
        timeoutMs: Math.min(this.navigationTimeoutMs, 30_000),
        reportProgress,
        signal: item.signal,
        code: "ROXY_CODE_FORM_TIMEOUT",
        message: "RoxyBrowser did not show the email verification-code form."
      });
      const code = await item.waitForVerificationCode({
        timeoutMs: this.navigationTimeoutMs,
        pollIntervalMs: 3_000,
        signal: item.signal,
        requestText: mailboxRequester.requestText,
        ...(mailboxBaseline ? {
          afterMessageCount: mailboxBaseline.messageCount,
          afterLatestMessageAt: mailboxBaseline.latestMessageAt,
          afterVerificationCode: mailboxBaseline.verificationCode || ""
        } : {})
      });
      let otpAdvanced = false;
      let otpAttempts = 0;
      for (let attempt = 0; attempt < 3 && !otpAdvanced; attempt += 1) {
        otpAttempts = attempt + 1;
        await fillHydratedInput(page, codeInput, code, {
          signal: item.signal,
          code: "ROXY_OTP_INPUT_UNSTABLE",
          message: "RoxyBrowser OTP input did not remain stable after hydration."
        });
        const codeSubmit = await waitForVisible(page, [
          page.getByRole("button", { name: /Continue|继续/i }),
          page.locator('button[type="submit"]')
        ], { timeoutMs: 30_000, signal: item.signal, code: "ROXY_CODE_SUBMIT_MISSING" });
        await page.bringToFront().catch(() => {});
        if (attempt === 0) await codeSubmit.click();
        else await codeInput.press("Enter");

        otpAdvanced = await waitForStableCondition(page, async () => {
          const stillOnCodeForm = await visibleLocator([
            page.locator('input[autocomplete="one-time-code"]'),
            page.locator('input[name="code"]'),
            page.getByRole("textbox", { name: /Verification code|验证码/i })
          ]);
          if (stillOnCodeForm) return false;
          return meaningfulDocumentVisible(page);
        }, { timeoutMs: 15_000, signal: item.signal });

        if (!otpAdvanced) {
          const session = await readAuthenticatedSession(context, page).catch(() => null);
          if (session) otpAdvanced = true;
        }
        if (otpAdvanced || attempt >= 2) break;

        await reportProgress(
          `RoxyBrowser OTP submit did not advance; reloading the form for verified retry ${attempt + 2}/3.`,
          { roxyState: "OTP_SUBMIT_RETRY", submitAttempt: attempt + 1 }
        );
        await loadMeaningfulDocument(page, {
          mode: "reload",
          url: page.url(),
          timeoutMs: this.authDocumentTimeoutMs,
          attempts: 2,
          reportProgress,
          signal: item.signal,
          blankCode: "ROXY_AUTH_PAGE_BLANK",
          blankMessage: "RoxyBrowser OTP reload returned an empty authentication document.",
          networkCode: "ROXY_AUTH_PAGE_NETWORK_FAILED"
        });
        const retryFailure = await accountCreationFailure(page);
        if (retryFailure) throw new AppError(409, retryFailure.code, retryFailure.message);
        const retryCodeInput = await visibleLocator([
          page.locator('input[autocomplete="one-time-code"]'),
          page.locator('input[name="code"]'),
          page.getByRole("textbox", { name: /Verification code|验证码/i })
        ]);
        if (!retryCodeInput) {
          otpAdvanced = Boolean(await readAuthenticatedSession(context, page).catch(() => null)
            || await meaningfulDocumentVisible(page));
          break;
        }
        codeInput = retryCodeInput;
      }
      if (!otpAdvanced) {
        throw new AppError(504, "ROXY_OTP_SUBMIT_TIMEOUT", "RoxyBrowser OTP submit did not advance after verified retries.");
      }
      await reportProgress("RoxyBrowser mailbox OTP was accepted and the page advanced.", {
        roxyState: "OTP_SUBMITTED",
        submitAttempts: otpAttempts
      });

      const profileDeadline = Date.now() + this.navigationTimeoutMs;
      let authSession = null;
      let profileSubmitted = false;
      let onboardingContinued = false;
      let authenticatedHomeRefreshed = false;
      while (Date.now() < profileDeadline) {
        throwIfTerminated(item.signal);
        authSession = await readAuthenticatedSession(context, page).catch(() => null);
        if (authSession) break;
        const accountFailure = await accountCreationFailure(page);
        if (accountFailure) {
          throw new AppError(409, accountFailure.code, accountFailure.message);
        }
        if (!onboardingContinued) {
          onboardingContinued = await continueOnboardingCompletion(page, reportProgress);
          if (onboardingContinued) {
            await page.waitForTimeout(500);
            continue;
          }
        }
        if (!authenticatedHomeRefreshed && await authenticatedHomeVisible(page)) {
          authenticatedHomeRefreshed = true;
          const beforeReload = await inspectSessionResponseShape(context, page);
          await reportProgress("RoxyBrowser reached the authenticated home page; refreshing the private AT session once.", {
            roxyState: "AUTH_HOME_REFRESH",
            sessionProbe: beforeReload
          });
          await page.reload({ waitUntil: "domcontentloaded", timeout: this.navigationTimeoutMs });
          await page.waitForTimeout(2_000);
          authSession = await readAuthenticatedSession(context, page).catch(() => null);
          if (authSession) break;
          const afterReload = await inspectSessionResponseShape(context, page);
          throw new AppError(
            502,
            "ROXY_AUTH_TOKEN_MISSING",
            "RoxyBrowser reached an authenticated ChatGPT home page, but the private session response did not contain an AT.",
            { beforeReload, afterReload }
          );
        }
        if (!profileSubmitted) {
          profileSubmitted = await this.fillProfile(page, identity, reportProgress, item.signal);
        }
        if (await challengeVisible(page)) {
          await reportProgress("RoxyBrowser is waiting for the visible human-verification step to finish.", {
            roxyState: "CHALLENGE"
          });
        }
        await page.waitForTimeout(300);
      }
      authSession = authSession || await waitForAuthenticatedSession(context, page, 1, item.signal);
      await reportProgress("Authenticated session detected; committing storage and AT cache before profile cleanup.", {
        roxyState: "AUTH_CAPTURE"
      });
      const plusEligibility = await inspectPlusTrialEligibility(page, authSession, this.now().toISOString());
      await reportProgress(
        plusEligibility.status === "eligible"
          ? "Plus trial precheck found an eligible free-offer signal."
          : plusEligibility.status === "ineligible"
            ? "Plus trial precheck found no eligible free offer for this account."
            : "Plus trial precheck did not return a decisive eligibility signal.",
        {
          roxyState: "PLUS_TRIAL_PRECHECK",
          campaignId: plusEligibility.campaignId,
          eligibilityStatus: plusEligibility.status,
          couponStatus: plusEligibility.couponStatus,
          buttonVisible: plusEligibility.buttonVisible,
          source: plusEligibility.source
        }
      );
      const session = await this.commitSession({ taskId: item.taskId, context, authSession });
      await reportProgress("Storage and AT cache were reopened and verified; the RoxyBrowser slot can now be recycled.", {
        roxyState: "SESSION_COMMITTED"
      });
      return Object.freeze({
        account: maskEmail(item.email),
        mode: "roxybrowser_webui",
        registeredAt: this.now().toISOString(),
        plusEligibility,
        session
      });
    } catch (error) {
      if (item.signal && item.signal.aborted) throw terminationError(item.signal);
      if (error && [
        "ROXY_AUTH_SESSION_TIMEOUT",
        "ROXY_AUTH_TOKEN_MISSING",
        "ROXY_ACCOUNT_CREATION_REJECTED",
        "ROXY_ACCOUNT_DEACTIVATED",
        "ROXY_CODE_FORM_TIMEOUT",
        "ROXY_AUTH_PREFLIGHT_BLANK",
        "ROXY_AUTH_PREFLIGHT_FAILED",
        "ROXY_AUTH_PAGE_BLANK",
        "ROXY_AUTH_PAGE_NETWORK_FAILED",
        "ROXY_SIGNUP_PAGE_BLANK",
        "ROXY_SIGNUP_PAGE_NETWORK_FAILED"
      ].includes(error.code)) {
        const diagnostic = await this.captureAuthDiagnostic({ taskId: item.taskId, page }).catch(() => null);
        if (diagnostic) {
          await reportProgress("RoxyBrowser account-creation diagnostic was captured before profile cleanup.", {
            roxyState: "AUTH_DIAGNOSTIC",
            diagnosticCode: error.code,
            pageHost: diagnostic.pageHost,
            pagePath: diagnostic.pagePath,
            pageTitle: diagnostic.pageTitle,
            screenshotPath: diagnostic.screenshotPath,
            jsonPath: diagnostic.jsonPath
          });
        }
      }
      throw normalizeRoxyRegistrationFailure(error);
    } finally {
      if (item.signal) item.signal.removeEventListener("abort", abortPage);
      if (mailboxRequester) await mailboxRequester.close().catch(() => {});
      if (page && !page.isClosed()) {
        await page.bringToFront().catch(() => {});
      }
    }
  }

  async registerBatch({ items = [] } = {}) {
    if (!this.bridge) {
      throw new AppError(503, "ROXY_BRIDGE_MISSING", "RoxyBrowser registration bridge is not initialized.");
    }
    const entries = Array.isArray(items) ? items : [];
    if (!entries.length) return Object.freeze({ mode: "roxybrowser", windowCount: 0, outcomes: [] });
    if (entries.some((item) => typeof item.waitForVerificationCode !== "function")) {
      throw new AppError(500, "VERIFICATION_READER_MISSING", "RoxyBrowser registration requires a verification-code reader for every account.");
    }

    if (typeof this.bridge.ensureReady === "function") {
      const recovery = await this.bridge.ensureReady();
      if (recovery && recovery.started) {
        await Promise.all(entries.map((item) => (item.reportProgress || (async () => {}))(
          "RoxyBrowser main process was restored and local control is ready.",
          { roxyState: "CONTROL_RESTORED" }
        )));
      }
    }

    const requiredWindows = Math.ceil(entries.length / 2);
    if (requiredWindows > 15) {
      throw new AppError(400, "ROXY_WINDOW_LIMIT_EXCEEDED", "RoxyBrowser registration accepts at most 15 windows and 30 accounts per round.");
    }
    let profiles;
    let opened;
    try {
      profiles = await this.bridge.profiles();
      opened = await this.bridge.openedProfiles();
    } catch (error) {
      if (!isRoxyControlFailure(error) || typeof this.bridge.ensureReady !== "function") throw error;
      await this.bridge.ensureReady();
      profiles = await this.bridge.profiles();
      opened = await this.bridge.openedProfiles();
    }
    const openedSet = new Set(opened);
    const freeProfiles = profiles.filter((profile) => !openedSet.has(profile.dirId));
    if (freeProfiles.length < requiredWindows) {
      throw new AppError(
        409,
        "ROXY_PROFILES_INSUFFICIENT",
        `RoxyBrowser needs ${requiredWindows} free profiles for ${entries.length} accounts, but only ${freeProfiles.length} are available.`
      );
    }
    const available = freeProfiles.filter(hasConfiguredProfileProxy).slice(0, requiredWindows);
    if (available.length < requiredWindows) {
      throw new AppError(
        409,
        "ROXY_PROFILE_PROXY_INSUFFICIENT",
        `RoxyBrowser needs ${requiredWindows} free profiles with an existing proxy, but only ${available.length} are configured.`
      );
    }

    const dirIds = available.map((profile) => profile.dirId);
    const outcomes = new Array(entries.length);
    const chromium = this.chromium || loadChromium();
    const configuredProxyWindows = requiredWindows;
    const proxySource = "existing_roxy_profile";
    try {
      await Promise.all(entries.map((item, index) => (item.reportProgress || (async () => {}))(
        `RoxyBrowser window ${Math.floor(index / 2) + 1} is using its existing profile proxy; the JP exit check will run before email submission.`,
        {
          roxyState: "PROFILE_PROXY_REUSED",
          windowIndex: Math.floor(index / 2),
          proxySource
        }
      )));
      try {
        await this.bridge.launchProfiles(dirIds);
      } catch (error) {
        if (!isRoxyControlFailure(error) || typeof this.bridge.ensureReady !== "function") throw error;
        await this.bridge.ensureReady();
        await this.bridge.launchProfiles(dirIds);
      }
      const windows = await Promise.allSettled(available.map(async (profile, windowIndex) => {
        const endpoint = await this.bridge.waitForDevTools(profile.dirId);
        const browser = await chromium.connectOverCDP(endpoint);
        const context = browser.contexts()[0];
        if (!context) {
          throw new AppError(502, "ROXY_BROWSER_CONTEXT_MISSING", "RoxyBrowser profile did not expose its persistent browser context.");
        }
        const assigned = entries.slice(windowIndex * 2, (windowIndex * 2) + 2);
        try {
          for (let slotIndex = 0; slotIndex < assigned.length; slotIndex += 1) {
            const item = assigned[slotIndex];
            const resultIndex = (windowIndex * 2) + slotIndex;
            await this.clearChatGptState(browser, context, context.pages());
            try {
              outcomes[resultIndex] = Object.freeze({
                status: "fulfilled",
                value: await this.registerInContext({
                  browser,
                  context,
                  item,
                  slotIndex,
                  windowIndex,
                  profileNumber: profile.windowSortNum == null ? null : Number(profile.windowSortNum)
                })
              });
            } catch (reason) {
              outcomes[resultIndex] = Object.freeze({ status: "rejected", reason });
            }
          }
        } finally {
          await this.clearChatGptState(browser, context, context.pages()).catch(() => {});
        }
      }));
      for (let windowIndex = 0; windowIndex < windows.length; windowIndex += 1) {
        const windowResult = windows[windowIndex];
        if (windowResult.status !== "rejected") continue;
        const assigned = entries.slice(windowIndex * 2, (windowIndex * 2) + 2);
        for (let slotIndex = 0; slotIndex < assigned.length; slotIndex += 1) {
          const resultIndex = (windowIndex * 2) + slotIndex;
          if (!outcomes[resultIndex]) {
            outcomes[resultIndex] = Object.freeze({ status: "rejected", reason: windowResult.reason });
          }
        }
      }
    } finally {
      await this.bridge.clearProfiles(dirIds, "all").catch(() => {});
      await this.bridge.closeProfiles(dirIds).catch(() => {});
    }
    return Object.freeze({
      mode: "roxybrowser",
      windowCount: requiredWindows,
      accountsPerWindow: 2,
      configuredProxyWindows,
      proxySource,
      outcomes: Object.freeze(outcomes.map((outcome) => outcome || Object.freeze({
        status: "rejected",
        reason: new AppError(502, "ROXY_REGISTRATION_OUTCOME_MISSING", "RoxyBrowser registration ended without an account outcome.")
      })))
    });
  }

  async register(input = {}) {
    const batch = await this.registerBatch({ items: [input] });
    const outcome = batch.outcomes[0];
    if (outcome.status === "rejected") throw outcome.reason;
    return outcome.value;
  }
}

module.exports = {
  AUTH_PREFLIGHT,
  CHATGPT_HOME,
  CHATGPT_SESSION,
  CHATGPT_SIGNUP,
  CHATGPT_TRACE,
  accountCreationFailure,
  accountCreationRejected,
  authenticatedHomeVisible,
  continueOnboardingCompletion,
  createRoxyMailboxRequester,
  fillHydratedInput,
  hasConfiguredProfileProxy,
  inspectSessionResponseShape,
  inspectPlusTrialEligibility,
  inspectPageDocument,
  isRoxyControlFailure,
  locatorInputValue,
  loadMeaningfulDocument,
  meaningfulDocumentVisible,
  normalizeRoxyRegistrationFailure,
  ChatGptRoxyRegistrationClient,
  parseTrace,
  readAuthenticatedSession,
  summarizePlusTrialEligibility,
  visibleLocator,
  waitForStableCondition,
  waitForAuthenticatedSession,
  waitForMeaningfulDocument,
  waitForVisible
};
