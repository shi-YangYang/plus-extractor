"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AppError } = require("../lib/errors");
const { sanitizeText } = require("../lib/sanitize");
const { requestTextThroughProxy } = require("../lib/proxy-request");
const {
  CheckoutProtocolRuntime,
  normalizeAccountSession
} = require("./chatgpt-checkout-link-client");

const core = require(path.resolve(__dirname, "../../../chatgpt-checkout-helper/core.js"));

const CHATGPT_ORIGIN = "https://chatgpt.com";
const SESSION_ENDPOINT = "/api/auth/session";
const ACCOUNT_CONTEXT_ENDPOINT = "/backend-api/accounts/check/v4-2023-04-27";
const MAX_PLUS_VERIFY_ITEMS = 500;
const MAX_PLUS_VERIFY_CONCURRENCY = 10;
const MAX_PLUS_BROWSER_CONCURRENCY = 2;
const MAX_PLUS_BROWSER_PROXY_ATTEMPTS = 2;

function normalizeRawAccessToken(value) {
  let token = String(value || "").trim();
  for (let pass = 0; pass < 3; pass += 1) {
    const before = token;
    const assignment = token.match(/^(?:access[_-]?token|at)\s*[:=]\s*(.+)$/i);
    if (assignment) token = assignment[1].trim();
    token = token.replace(/^Bearer[ \t]+/i, "").trim();
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
      try {
        const parsed = JSON.parse(token);
        if (typeof parsed === "string") token = parsed.trim();
      } catch {
        if (token.startsWith("'") && token.endsWith("'")) token = token.slice(1, -1).trim();
      }
    }
    if (token === before) break;
  }
  if (token.length < 20 || token.length > 20_000) return "";
  return /^[A-Za-z0-9._~+\/-]+=*$/.test(token) ? token : "";
}

function decodeAccessTokenClaims(accessToken) {
  const token = normalizeRawAccessToken(accessToken);
  if (!token) return Object.freeze({});
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload
      : Object.freeze({});
  } catch {
    return Object.freeze({});
  }
}

function isCloudflareChallengeResponse(response) {
  const contentType = String(response && response.headers && response.headers["content-type"] || "").toLowerCase();
  const body = String(response && response.text || "").slice(0, 4_000);
  return Number(response && response.status) === 403
    && (/text\/html/.test(contentType) || /^\s*<html/i.test(body))
    && Boolean(response && response.headers && response.headers["cf-ray"] || /cloudflare|challenge-platform|just a moment/i.test(body));
}

function entitlementHeaders(normalized, includeNavigationHeaders = false) {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${normalized.accessToken}`,
    ...(normalized.accountId ? { "chatgpt-account-id": normalized.accountId } : {}),
    "x-openai-target-path": ACCOUNT_CONTEXT_ENDPOINT,
    "x-openai-target-route": ACCOUNT_CONTEXT_ENDPOINT,
    ...(includeNavigationHeaders ? {
      Origin: CHATGPT_ORIGIN,
      Referer: `${CHATGPT_ORIGIN}/`
    } : {})
  };
}

function parseSessionInput(input) {
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // Raw access tokens are accepted below.
    }
    const accessToken = normalizeRawAccessToken(input);
    if (accessToken) return Object.freeze({ accessToken });
    throw new AppError(400, "PLUS_SESSION_OR_TOKEN_INVALID", "The imported item is neither a complete Session JSON object nor a valid access token.");
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AppError(400, "PLUS_SESSION_OR_TOKEN_INVALID", "Each imported item must be one complete Session JSON object or access token.");
  }
  return input;
}

function normalizeSessionInput(input) {
  const session = parseSessionInput(input);
  const accessToken = normalizeRawAccessToken(
    session.accessToken || session.access_token || session.at || session.token
  );
  if (!accessToken) {
    throw new AppError(400, "PLUS_ACCESS_TOKEN_INVALID", "The Session JSON does not contain a valid accessToken.");
  }
  const claims = decodeAccessTokenClaims(accessToken);
  const authClaims = claims["https://api.openai.com/auth"] || {};
  const profileClaims = claims["https://api.openai.com/profile"] || {};
  const accountId = core.getSessionAccountId(session)
    || String(authClaims.chatgpt_account_id || "").trim();
  const email = String(session.user && session.user.email
    || session.email
    || profileClaims.email
    || "").trim().toLowerCase();
  let expiresAt = String(session.expires || "").trim();
  if (!expiresAt && Number.isFinite(claims.exp) && claims.exp > 0) {
    const expiresMs = claims.exp * 1000;
    if (Number.isFinite(expiresMs)) expiresAt = new Date(expiresMs).toISOString();
  }
  return Object.freeze({ accessToken, accountId, email, expiresAt });
}

function selectAccountRecord(payload, preferredAccountId = "") {
  const accounts = payload && payload.accounts && typeof payload.accounts === "object"
    ? payload.accounts
    : {};
  const ordering = payload && Array.isArray(payload.account_ordering)
    ? payload.account_ordering.filter((value) => typeof value === "string")
    : [];
  const keys = [...ordering, ...Object.keys(accounts).filter((key) => !ordering.includes(key))];
  const entries = keys.map((key) => ({ key, value: accounts[key] })).filter((entry) => (
    entry.value && typeof entry.value === "object"
  ));
  return entries.find((entry) => (
    preferredAccountId
      && (entry.key === preferredAccountId || entry.value.account && entry.value.account.account_id === preferredAccountId)
  )) || entries.find((entry) => entry.value.can_access_with_session !== false) || entries[0] || null;
}

function resolveAccountIdentity(payload, preferredAccountId = "", fallbackEmail = "") {
  const selected = selectAccountRecord(payload, preferredAccountId);
  if (!selected) {
    throw new AppError(502, "PLUS_ACCOUNT_CONTEXT_MISSING", "The account context did not contain an accessible account.");
  }
  const record = selected.value;
  const account = record.account && typeof record.account === "object" ? record.account : {};
  const selectedKey = String(selected.key || "").trim();
  const accountId = String(
    account.account_id
    || account.id
    || (selectedKey && selectedKey !== "default" ? selectedKey : "")
    || preferredAccountId
    || ""
  ).trim();
  if (!accountId || accountId.length > 256) {
    throw new AppError(502, "PLUS_ACCOUNT_ID_MISSING", "The account context did not include an active account id.");
  }
  const email = String(
    fallbackEmail
    || account.email
    || record.email
    || record.profile && record.profile.email
    || ""
  ).trim().toLowerCase();
  return Object.freeze({ selected, record, account, accountId, email });
}

function summarizePlusEntitlement(payload, preferredAccountId = "") {
  const identity = resolveAccountIdentity(payload, preferredAccountId);
  const { selected, record, account, accountId } = identity;
  const entitlement = record.entitlement && typeof record.entitlement === "object" ? record.entitlement : {};
  const plan = String(entitlement.subscription_plan || account.plan_type || "").trim().toLowerCase();
  const hasActiveSubscription = entitlement.has_active_subscription === true;
  const hasPlus = hasActiveSubscription && /plus/.test(plan);
  return Object.freeze({
    hasPlus,
    hasActiveSubscription,
    plan: plan || "free",
    trial: entitlement.trial != null,
    expiresAt: entitlement.expires_at || null,
    renewsAt: entitlement.renews_at || null,
    cancelsAt: entitlement.cancels_at || null,
    accountMatched: !preferredAccountId || accountId === preferredAccountId
  });
}

async function mapWithConcurrency(items, limit, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return output;
}

class PlusEntitlementVerifier {
  constructor({
    proxyPools,
    request = requestTextThroughProxy,
    browserRuntimeFactory = () => new CheckoutProtocolRuntime({ headless: false }),
    savedSessionResolver = null,
    now = () => new Date(),
    browserConcurrency = MAX_PLUS_BROWSER_CONCURRENCY
  } = {}) {
    this.proxyPools = proxyPools;
    this.request = request;
    this.browserRuntimeFactory = browserRuntimeFactory;
    this.savedSessionResolver = savedSessionResolver;
    this.now = now;
    this.browserConcurrency = Number.isInteger(browserConcurrency)
      ? Math.max(1, Math.min(browserConcurrency, MAX_PLUS_BROWSER_CONCURRENCY))
      : MAX_PLUS_BROWSER_CONCURRENCY;
    this.activeBrowsers = 0;
    this.browserWaiters = [];
  }

  async withBrowserSlot(worker) {
    if (this.activeBrowsers >= this.browserConcurrency) {
      await new Promise((resolve) => this.browserWaiters.push(resolve));
    }
    this.activeBrowsers += 1;
    try {
      return await worker();
    } finally {
      this.activeBrowsers -= 1;
      const next = this.browserWaiters.shift();
      if (next) next();
    }
  }

  async resolveSavedBrowserSession(normalized) {
    if (typeof this.savedSessionResolver !== "function") return null;
    try {
      const resolved = await this.savedSessionResolver(normalized);
      const candidate = resolved && (resolved.accountSession || resolved);
      if (!candidate) return null;
      return normalizeAccountSession({
        kind: candidate.kind,
        path: candidate.path
      });
    } catch {
      return null;
    }
  }

  normalizeBrowserVerificationError(error) {
    if (error && error.code === "CHECKOUT_SESSION_EXPIRED") {
      return new AppError(
        401,
        "PLUS_ACCESS_TOKEN_EXPIRED",
        "The access token was rejected as expired and no saved cookie session authenticated the account.",
        error
      );
    }
    return error;
  }

  async requestWithBrowser(normalized, proxy, savedBrowserSession = null) {
    return this.withBrowserSlot(async () => {
      let temporarySessionPath = "";
      const accountSession = savedBrowserSession || (() => {
        temporarySessionPath = path.join(os.tmpdir(), `plus-at-${process.pid}-${crypto.randomUUID()}.json`);
        fs.writeFileSync(temporarySessionPath, JSON.stringify({ cookies: [], origins: [] }), { encoding: "utf8", mode: 0o600 });
        return { kind: "playwright_storage_state", path: temporarySessionPath };
      })();
      const runtime = this.browserRuntimeFactory();
      const query = new URLSearchParams({ timezone_offset_min: "0" });
      const route = `${ACCOUNT_CONTEXT_ENDPOINT}?${query}`;
      try {
        await runtime.open({
          accountSession,
          proxy
        });
        if (typeof runtime.ensureChatGptPage === "function") {
          await runtime.ensureChatGptPage();
        }
        if (savedBrowserSession) {
          try {
            const browserSession = await runtime.requestJson(`${SESSION_ENDPOINT}?_=${Date.now()}`, {
              headers: { Accept: "application/json", "Cache-Control": "no-store" },
              stage: "Plus saved-cookie identity verification"
            });
            const browserIdentity = normalizeSessionInput(browserSession);
            if (
              normalized.accountId
              && browserIdentity.accountId
              && browserIdentity.accountId !== normalized.accountId
            ) {
              throw new AppError(409, "PLUS_ACCOUNT_MISMATCH", "The saved browser session resolved a different ChatGPT account.");
            }
            if (
              normalized.email
              && browserIdentity.email
              && browserIdentity.email !== normalized.email
            ) {
              throw new AppError(409, "PLUS_ACCOUNT_MISMATCH", "The saved browser session resolved a different ChatGPT account.");
            }
            return await runtime.requestJson(route, {
              headers: { Accept: "application/json" },
              stage: "Plus saved-cookie entitlement verification"
            });
          } catch (error) {
            if (!error || ![
              "CHECKOUT_SESSION_EXPIRED",
              "PLUS_ACCESS_TOKEN_INVALID",
              "PLUS_SESSION_OR_TOKEN_INVALID"
            ].includes(error.code)) throw error;
          }
        }
        try {
          return await runtime.requestJson(route, {
            headers: entitlementHeaders(normalized),
            stage: "Plus browser entitlement verification"
          });
        } catch (error) {
          throw this.normalizeBrowserVerificationError(error);
        }
      } finally {
        await runtime.close().catch(() => {});
        if (temporarySessionPath) fs.rmSync(temporarySessionPath, { force: true });
      }
    });
  }

  proxyAttemptCount() {
    try {
      const count = Number(this.proxyPools.summary().US.count);
      return Number.isInteger(count) && count > 0 ? Math.min(count, 10) : 1;
    } catch {
      return 1;
    }
  }

  async fetchAccountContextThroughProxy(normalized, proxy) {
    const query = new URLSearchParams({ timezone_offset_min: "0" });
    const route = `${ACCOUNT_CONTEXT_ENDPOINT}?${query}`;
    const response = await this.request(`${CHATGPT_ORIGIN}${route}`, proxy, {
      timeoutMs: 30_000,
      maxBytes: 1024 * 1024,
      maxRedirects: 0,
      headers: entitlementHeaders(normalized, true)
    });
    if (isCloudflareChallengeResponse(response)) {
      throw new AppError(403, "PLUS_VERIFY_BROWSER_REQUIRED", "The entitlement endpoint requires browser verification.");
    }
    if ([401, 403].includes(response.status)) {
      throw new AppError(401, "PLUS_ACCESS_TOKEN_REJECTED", `The entitlement endpoint returned HTTP ${response.status}.`);
    }
    if (response.status === 429) {
      throw new AppError(429, "PLUS_VERIFY_RATE_LIMITED", "The entitlement endpoint returned HTTP 429.");
    }
    if (response.status < 200 || response.status >= 300) {
      throw new AppError(502, "PLUS_VERIFY_UPSTREAM_FAILED", `The entitlement endpoint returned HTTP ${response.status}.`);
    }
    try {
      return JSON.parse(response.text);
    } catch {
      throw new AppError(502, "PLUS_VERIFY_RESPONSE_INVALID", "The entitlement endpoint did not return valid JSON.");
    }
  }

  async fetchAccountContext(normalized, index = 0) {
    const savedBrowserSession = await this.resolveSavedBrowserSession(normalized);
    const attempts = this.proxyAttemptCount();
    const proxies = Array.from({ length: attempts }, (_unused, offset) => (
      this.proxyPools.select("US", index + offset)
    ));
    let lastError;

    // A locally saved browser session is the strongest credential available:
    // it remains valid even when the copied AT has been revoked server-side.
    // Keep this path bounded so a batch never launches one browser per proxy.
    if (savedBrowserSession) {
      for (const proxy of proxies.slice(0, MAX_PLUS_BROWSER_PROXY_ATTEMPTS)) {
        try {
          return await this.requestWithBrowser(normalized, proxy, savedBrowserSession);
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError || new AppError(502, "PLUS_VERIFY_UPSTREAM_FAILED", "No Plus verification proxy returned an account context.");
    }

    const browserCandidates = [];
    for (const proxy of proxies) {
      try {
        return await this.fetchAccountContextThroughProxy(normalized, proxy);
      } catch (error) {
        lastError = error;
        if (error && error.code === "PLUS_VERIFY_BROWSER_REQUIRED") browserCandidates.push(proxy);
      }
    }

    for (const proxy of browserCandidates.slice(0, MAX_PLUS_BROWSER_PROXY_ATTEMPTS)) {
      try {
        return await this.requestWithBrowser(normalized, proxy);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new AppError(502, "PLUS_VERIFY_UPSTREAM_FAILED", "No Plus verification proxy returned an account context.");
  }

  async inspectNormalizedAccount(normalized, index = 0) {
    const expiresMs = Date.parse(normalized.expiresAt);
    if (Number.isFinite(expiresMs) && expiresMs <= this.now().getTime()) {
      throw new AppError(401, "PLUS_SESSION_EXPIRED", "The imported Session JSON has expired.");
    }
    const payload = await this.fetchAccountContext(normalized, index);
    const identity = resolveAccountIdentity(payload, normalized.accountId, normalized.email);
    if (normalized.accountId && identity.accountId !== normalized.accountId) {
      throw new AppError(409, "PLUS_ACCOUNT_MISMATCH", "The saved browser session resolved a different ChatGPT account.");
    }
    const entitlement = summarizePlusEntitlement(payload, identity.accountId);
    return Object.freeze({ normalized, identity, entitlement });
  }

  async inspectAccount(input, index = 0) {
    return this.inspectNormalizedAccount(normalizeSessionInput(input), index);
  }

  async resolveImportSession(input, index = 0) {
    const inspected = await this.inspectAccount(input, index);
    const { normalized, identity } = inspected;
    const authSession = Object.freeze({
      accessToken: normalized.accessToken,
      ...(normalized.expiresAt ? { expires: normalized.expiresAt } : {}),
      user: Object.freeze({ ...(identity.email ? { email: identity.email } : {}) }),
      account: Object.freeze({ id: identity.accountId, account_id: identity.accountId })
    });
    return Object.freeze({
      accountId: identity.accountId,
      email: identity.email,
      expiresAt: normalized.expiresAt || null,
      authSession,
      entitlement: inspected.entitlement
    });
  }

  async verifyOne(input, index) {
    let normalized;
    let inspected;
    try {
      normalized = normalizeSessionInput(input);
      inspected = await this.inspectNormalizedAccount(normalized, index);
      const { entitlement } = inspected;
      return Object.freeze({
        index,
        email: normalized.email,
        ok: true,
        status: entitlement.hasPlus ? "PLUS_ACTIVE" : "NO_PLUS",
        ...entitlement
      });
    } catch (error) {
      return Object.freeze({
        index,
        email: normalized && normalized.email || "",
        ok: false,
        status: "VERIFY_FAILED",
        hasPlus: false,
        code: String(error && error.code || "PLUS_VERIFY_FAILED").slice(0, 120),
        message: sanitizeText(error && error.message || "Plus verification failed.", 240)
      });
    }
  }

  async verifyBatch(input = {}) {
    const sessions = Array.isArray(input.sessions) ? input.sessions : [];
    if (!sessions.length) {
      throw new AppError(400, "PLUS_VERIFY_INPUT_REQUIRED", "Import at least one Session JSON object.");
    }
    if (sessions.length > MAX_PLUS_VERIFY_ITEMS) {
      throw new AppError(400, "PLUS_VERIFY_BATCH_TOO_LARGE", `A batch can contain at most ${MAX_PLUS_VERIFY_ITEMS} Session JSON objects.`);
    }
    this.proxyPools.requireConfigured(["US"]);
    const results = await mapWithConcurrency(sessions, MAX_PLUS_VERIFY_CONCURRENCY, (session, index) => (
      this.verifyOne(session, index)
    ));
    return Object.freeze({
      requested: sessions.length,
      completed: results.filter((result) => result.ok).length,
      plusActive: results.filter((result) => result.hasPlus).length,
      noPlus: results.filter((result) => result.ok && !result.hasPlus).length,
      failed: results.filter((result) => !result.ok).length,
      concurrency: MAX_PLUS_VERIFY_CONCURRENCY,
      verifiedAt: this.now().toISOString(),
      results
    });
  }
}

module.exports = {
  ACCOUNT_CONTEXT_ENDPOINT,
  MAX_PLUS_BROWSER_CONCURRENCY,
  MAX_PLUS_BROWSER_PROXY_ATTEMPTS,
  MAX_PLUS_VERIFY_CONCURRENCY,
  MAX_PLUS_VERIFY_ITEMS,
  PlusEntitlementVerifier,
  decodeAccessTokenClaims,
  entitlementHeaders,
  isCloudflareChallengeResponse,
  normalizeRawAccessToken,
  normalizeSessionInput,
  resolveAccountIdentity,
  summarizePlusEntitlement
};
