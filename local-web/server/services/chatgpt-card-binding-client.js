"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { AppError } = require("../lib/errors");
const { createStickyProxySession } = require("./chatgpt-protocol-registration-client");
const {
  CHECKOUT_ENDPOINT,
  CheckoutProtocolRuntime,
  authHeaders,
  normalizeAccountSession
} = require("./chatgpt-checkout-link-client");

const core = require(path.resolve(__dirname, "../../../chatgpt-checkout-helper/core.js"));

const PAYMENT_METHOD_ENDPOINT = "/backend-api/payments/payment_method";
const PAYMENT_METHODS_ENDPOINT = "/backend-api/payments/payment_methods";
const DEFAULT_INTENT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_PUBLISHABLE_KEYS = Object.freeze([
  Object.freeze({
    fragment: "KslHRdbaPg",
    key: "pk_live_51Pj377KslHRdbaPgTJYjThzH3f5dt1N1vK7LUp0qh0yNSarhfZ6nfbG7FFlh8KLxVkvdMWN5o6Mc4Vda6NHaSnaV00C2Sbl8Zs"
  }),
  Object.freeze({
    fragment: "C6h1nxGoI3",
    key: "pk_live_51HOrSwC6h1nxGoI3lTAgRjYVrz4dU3fVOabyCcKR3pbEJguCVAlqCxdxCUvoRh1XWwRacViovU3kLKvpkjh7IqkW00iXQsjo3n"
  })
]);

function nowMilliseconds(now) {
  const value = now();
  const milliseconds = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(milliseconds)) throw new AppError(500, "CARD_BINDING_CLOCK_INVALID", "Card-binding clock returned an invalid value.");
  return milliseconds;
}

function normalizePublishableKeys(input = DEFAULT_PUBLISHABLE_KEYS) {
  const source = Array.isArray(input)
    ? input
    : Object.entries(input || {}).map(([fragment, key]) => ({ fragment, key }));
  const seen = new Set();
  const entries = [];
  for (const item of source) {
    const fragment = String(item && item.fragment || "").trim();
    const key = String(item && item.key || "").trim();
    if (!fragment || !/^pk_(?:live|test)_[A-Za-z0-9]{20,}$/.test(key) || seen.has(key)) continue;
    seen.add(key);
    entries.push(Object.freeze({ fragment, key }));
  }
  if (!entries.length) {
    throw new AppError(500, "STRIPE_PUBLISHABLE_KEYS_MISSING", "No Stripe publishable-key candidates are configured.");
  }
  return Object.freeze(entries);
}

function orderPublishableKeys(clientSecret, entries) {
  const secret = String(clientSecret || "");
  return Object.freeze([
    ...entries.filter((entry) => secret.includes(entry.fragment)),
    ...entries.filter((entry) => !secret.includes(entry.fragment))
  ].map((entry) => entry.key));
}

function extractSetupIntentId(clientSecret) {
  const match = String(clientSecret || "").match(/^(seti_[A-Za-z0-9]{8,})_secret_[A-Za-z0-9]{8,}$/);
  if (!match) {
    throw new AppError(502, "SETUP_INTENT_SECRET_INVALID", "The payment-method endpoint returned an invalid SetupIntent client secret.");
  }
  return match[1];
}

function normalizeCheckoutSeed(payload) {
  const checkoutSessionId = core.extractOpenAICheckoutSessionId(payload)
    || core.extractCheckoutSessionId(payload);
  if (!checkoutSessionId) {
    throw new AppError(502, "CARD_BINDING_CHECKOUT_SEED_INVALID", "The temporary billing Checkout did not return a session identity.");
  }
  const processorEntity = String(payload && (
    payload.processor_entity
    || payload.processorEntity
    || payload.checkout && (payload.checkout.processor_entity || payload.checkout.processorEntity)
  ) || "openai_llc").trim() || "openai_llc";
  return Object.freeze({
    checkout_session_id: checkoutSessionId,
    checkout_url: core.buildCheckoutUrl(checkoutSessionId),
    processor_entity: processorEntity
  });
}

function resolveAccountId(session) {
  const candidates = [
    session && session.account && session.account.id,
    session && session.account && session.account.account_id,
    session && session.account_id,
    session && session.activeAccountId,
    session && session.user && session.user.account_id
  ];
  const accountId = candidates.map((value) => String(value || "").trim()).find(Boolean) || "";
  if (!accountId || accountId.length > 256) {
    throw new AppError(409, "CARD_BINDING_ACCOUNT_ID_MISSING", "The saved session does not include an active account id.");
  }
  return accountId;
}

function normalizeCardProfile(input) {
  const firstName = String(input && input.firstName || "").trim();
  const lastName = String(input && input.lastName || "").trim();
  const postalCode = String(input && input.postalCode || "").trim();
  const fullAddress = String(input && input.fullAddress || "").trim();
  if (!/^[A-Za-z][A-Za-z .'-]{0,79}$/.test(firstName) || !/^[A-Za-z][A-Za-z .'-]{0,79}$/.test(lastName)) {
    throw new AppError(409, "CARD_PROFILE_NAME_INVALID", "Generate a valid cardholder profile before binding a card.");
  }
  if (!/^\d{5}$/.test(postalCode)) {
    throw new AppError(409, "CARD_PROFILE_POSTAL_INVALID", "Generate a five-digit US postal code before binding a card.");
  }
  const addressMatch = fullAddress.match(/^(.{1,120}),\s*([^,]{1,80}),\s*([A-Z]{2})\s+(\d{5}),\s*USA$/);
  if (!addressMatch || addressMatch[4] !== postalCode) {
    throw new AppError(409, "CARD_PROFILE_ADDRESS_INVALID", "Generate a coherent US billing address before binding a card.");
  }
  return Object.freeze({
    name: `${firstName} ${lastName}`,
    address: Object.freeze({
      line1: addressMatch[1].trim(),
      city: addressMatch[2].trim(),
      state: addressMatch[3],
      postal_code: postalCode,
      country: "US"
    })
  });
}

function accountHeaders(accessToken, accountId, route, extra = {}) {
  return authHeaders(accessToken, {
    "chatgpt-account-id": accountId,
    "x-openai-target-path": route,
    "x-openai-target-route": route,
    ...extra
  });
}

function listPaymentMethods(payload) {
  if (Array.isArray(payload && payload.payment_methods)) return payload.payment_methods;
  if (Array.isArray(payload && payload.data)) return payload.data;
  return [];
}

function summarizePaymentMethod(payload, paymentMethodId) {
  const methods = listPaymentMethods(payload);
  const method = methods.find((candidate) => String(candidate && candidate.id || "") === paymentMethodId);
  if (!method) return null;
  const card = method.card || {};
  const brand = String(card.brand || method.type || "card").trim().toLowerCase();
  const last4 = String(card.last4 || "").trim();
  const expMonth = Number(card.exp_month);
  const expYear = Number(card.exp_year);
  if (!/^[a-z0-9 _-]{2,30}$/.test(brand) || !/^\d{4}$/.test(last4)
      || !Number.isInteger(expMonth) || expMonth < 1 || expMonth > 12
      || !Number.isInteger(expYear) || expYear < 2000 || expYear > 9999) {
    throw new AppError(502, "CARD_BINDING_RESULT_INVALID", "The payment-method list returned an incomplete card summary.");
  }
  return Object.freeze({
    status: "succeeded",
    brand,
    last4,
    expMonth,
    expYear,
    default: String(payload && payload.default_payment_method_id || "") === paymentMethodId || method.default === true
  });
}

function tokenDigest(token) {
  return crypto.createHash("sha256").update(String(token || ""), "utf8").digest();
}

function tokenMatches(token, digest) {
  const candidate = tokenDigest(token);
  return Buffer.isBuffer(digest) && candidate.length === digest.length && crypto.timingSafeEqual(candidate, digest);
}

function canReusePreparedExitProof(record, expectedRegion, nowMs) {
  const expected = String(expectedRegion || "").toUpperCase();
  return Boolean(record
    && record.exitProof
    && record.exitProof.region === expected
    && Number.isFinite(record.exitProof.verifiedAtMs)
    && record.exitProof.verifiedAtMs <= nowMs
    && nowMs < record.expiresAtMs);
}

class ChatGptCardBindingClient {
  constructor(options = {}) {
    this.runtimeFactory = options.runtimeFactory || (() => new CheckoutProtocolRuntime(options));
    this.publishableKeys = normalizePublishableKeys(options.publishableKeys || DEFAULT_PUBLISHABLE_KEYS);
    this.intentTtlMs = Math.max(60_000, Number(options.intentTtlMs) || DEFAULT_INTENT_TTL_MS);
    this.now = options.now || Date.now;
    this.sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.proxySessionId = options.proxySessionId || "";
    this.pending = new Map();
  }

  cleanupExpired() {
    const now = nowMilliseconds(this.now);
    for (const [taskId, record] of this.pending.entries()) {
      if (record.expiresAtMs <= now) this.pending.delete(taskId);
    }
  }

  requirePending(taskId, token) {
    this.cleanupExpired();
    const record = this.pending.get(String(taskId || ""));
    if (!record || !tokenMatches(token, record.tokenDigest)) {
      throw new AppError(409, "CARD_BINDING_PREPARATION_MISSING", "Prepare a fresh hosted card form before completing card binding.");
    }
    return record;
  }

  async prepare({ taskId, accountSession, proxy, cardProfile, reportProgress = async () => {} } = {}) {
    const id = String(taskId || "").trim();
    if (!id) throw new AppError(400, "CARD_BINDING_TASK_ID_REQUIRED", "A task id is required.");
    const session = normalizeAccountSession(accountSession);
    const billing = normalizeCardProfile(cardProfile);
    const sessionId = this.proxySessionId || crypto.randomBytes(4).toString("hex");
    const stickyProxy = createStickyProxySession(proxy, { sessionId });
    const runtime = this.runtimeFactory();
    this.pending.delete(id);
    try {
      await reportProgress("正在通过 US 代理准备支付方式绑定会话");
      await runtime.open({ accountSession: session, proxy: stickyProxy });
      const verifiedExit = await runtime.verifyExit("US");
      const authenticated = await runtime.readSession();
      const accountId = resolveAccountId(authenticated.session);
      await reportProgress("正在创建 US/USD 临时账单并初始化支付环境");
      const checkoutSeed = normalizeCheckoutSeed(await runtime.requestJson(CHECKOUT_ENDPOINT, {
        method: "POST",
        headers: accountHeaders(authenticated.accessToken, accountId, CHECKOUT_ENDPOINT, {
          "Content-Type": "application/json"
        }),
        body: core.buildBaselineCheckoutPayload(),
        stage: "Isolated card-flow checkout seed"
      }));
      await reportProgress("临时账单身份已保存，正在读取 AT 并创建 SetupIntent");
      const createSetupIntent = () => runtime.requestJson(PAYMENT_METHOD_ENDPOINT, {
        method: "POST",
        headers: accountHeaders(authenticated.accessToken, accountId, PAYMENT_METHOD_ENDPOINT, {
          "Content-Type": "application/json"
        }),
        body: { account_id: accountId },
        stage: "Payment-method SetupIntent"
      });
      let intent;
      try {
        intent = await createSetupIntent();
      } catch (error) {
        if (!error || error.code !== "CHECKOUT_PAYMENT_ACCOUNT_MISSING") throw error;
        await reportProgress("临时账单已建立，支付账户仍在初始化；正在重试 SetupIntent");
        intent = await createSetupIntent();
      }
      const clientSecret = String(intent && (intent.client_secret || intent.clientSecret) || "").trim();
      const setupIntentId = extractSetupIntentId(clientSecret);
      const token = crypto.randomBytes(24).toString("base64url");
      const preparedAtMs = nowMilliseconds(this.now);
      const expiresAtMs = preparedAtMs + this.intentTtlMs;
      this.pending.set(id, Object.freeze({
        accountId,
        setupIntentId,
        clientSecret,
        tokenDigest: tokenDigest(token),
        proxySessionId: sessionId,
        checkoutSeed,
        stickyProxy,
        exitProof: Object.freeze({
          region: String(verifiedExit && verifiedExit.region || "US").toUpperCase(),
          colo: String(verifiedExit && verifiedExit.colo || "").slice(0, 24),
          verifiedAtMs: preparedAtMs
        }),
        expiresAtMs
      }));
      await reportProgress("一次性卡输入会话已就绪；卡号、有效期和 CVC 将由 Stripe 托管输入框直接收集");
      return Object.freeze({
        token,
        clientSecret,
        publishableKeys: orderPublishableKeys(clientSecret, this.publishableKeys),
        billing,
        expiresAt: new Date(expiresAtMs).toISOString()
      });
    } catch (error) {
      this.pending.delete(id);
      if (error instanceof AppError) throw error;
      throw new AppError(502, "CARD_BINDING_PREPARE_FAILED", error && error.message || "Card-binding preparation failed.");
    } finally {
      await runtime.close().catch(() => {});
    }
  }

  async complete({
    taskId,
    token,
    setupIntentId,
    paymentMethodId,
    accountSession,
    reportProgress = async () => {}
  } = {}) {
    const id = String(taskId || "").trim();
    const prepared = this.requirePending(id, token);
    const submittedIntentId = String(setupIntentId || "").trim();
    const submittedMethodId = String(paymentMethodId || "").trim();
    if (submittedIntentId !== prepared.setupIntentId) {
      throw new AppError(409, "SETUP_INTENT_MISMATCH", "The confirmed SetupIntent does not match the prepared card form.");
    }
    if (!/^pm_[A-Za-z0-9]{8,255}$/.test(submittedMethodId)) {
      throw new AppError(400, "PAYMENT_METHOD_ID_INVALID", "Stripe did not return a valid payment-method id.");
    }
    const session = normalizeAccountSession(accountSession);
    const runtime = this.runtimeFactory();
    try {
      await reportProgress("Stripe 已确认 SetupIntent，正在通过 US 会话核验支付方式列表");
      await runtime.open({ accountSession: session, proxy: prepared.stickyProxy });
      let proxyVerificationSource = "live";
      try {
        await runtime.verifyExit("US");
      } catch (error) {
        const nowMs = nowMilliseconds(this.now);
        if (!(error instanceof AppError)
            || error.code !== "CHECKOUT_PROXY_TRACE_FAILED"
            || !canReusePreparedExitProof(prepared, "US", nowMs)) {
          throw error;
        }
        proxyVerificationSource = "prepared";
        await reportProgress("US 出口实时探针暂时未返回；复用本次 SetupIntent 准备阶段的 US 核验结果并继续复核");
      }
      const authenticated = await runtime.readSession();
      const accountId = resolveAccountId(authenticated.session);
      if (accountId !== prepared.accountId) {
        throw new AppError(409, "CARD_BINDING_ACCOUNT_MISMATCH", "The active account changed after the card form was prepared.");
      }
      const query = new URLSearchParams({ account_id: accountId });
      let summary = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const payload = await runtime.requestJson(`${PAYMENT_METHODS_ENDPOINT}?${query}`, {
          headers: accountHeaders(authenticated.accessToken, accountId, PAYMENT_METHODS_ENDPOINT),
          stage: "Payment-method verification"
        });
        summary = summarizePaymentMethod(payload, submittedMethodId);
        if (summary) break;
        if (attempt < 2) await this.sleep(400 * (attempt + 1));
      }
      if (!summary) {
        throw new AppError(409, "CARD_BINDING_NOT_VERIFIED", "The confirmed payment method is not visible in the account yet; prepare and confirm a fresh card form.");
      }
      if (typeof runtime.saveSession === "function") await runtime.saveSession(session.path);
      this.pending.delete(id);
      await reportProgress("支付方式已核验，任务仅保存品牌、尾号和有效期");
      return Object.freeze({
        ...summary,
        checkoutSeed: prepared.checkoutSeed,
        proxyRegion: "US",
        proxyVerificationSource,
        flowSessionId: prepared.proxySessionId,
        boundAt: new Date(nowMilliseconds(this.now)).toISOString()
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(502, "CARD_BINDING_VERIFY_FAILED", error && error.message || "Card-binding verification failed.");
    } finally {
      await runtime.close().catch(() => {});
    }
  }

  async cancel({ taskId, token } = {}) {
    const id = String(taskId || "").trim();
    this.cleanupExpired();
    const record = this.pending.get(id);
    const cancelled = Boolean(record && tokenMatches(token, record.tokenDigest));
    if (cancelled) this.pending.delete(id);
    return Object.freeze({ cancelled });
  }

  async discard({ taskId } = {}) {
    const id = String(taskId || "").trim();
    this.cleanupExpired();
    return Object.freeze({ discarded: this.pending.delete(id) });
  }
}

module.exports = {
  DEFAULT_INTENT_TTL_MS,
  DEFAULT_PUBLISHABLE_KEYS,
  PAYMENT_METHOD_ENDPOINT,
  PAYMENT_METHODS_ENDPOINT,
  ChatGptCardBindingClient,
  canReusePreparedExitProof,
  extractSetupIntentId,
  normalizeCheckoutSeed,
  normalizeCardProfile,
  normalizePublishableKeys,
  orderPublishableKeys,
  resolveAccountId,
  summarizePaymentMethod
};
