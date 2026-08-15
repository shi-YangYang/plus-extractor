"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { AppError } = require("../lib/errors");
const { createStickyProxySession } = require("./chatgpt-protocol-registration-client");
const {
  CheckoutProtocolRuntime,
  authHeaders,
  normalizeAccountSession
} = require("./chatgpt-checkout-link-client");
const {
  normalizeCardProfile,
  resolveAccountId,
  summarizePaymentMethod
} = require("./chatgpt-card-binding-client");
const {
  BANGKA_CHECKOUT_CONFIG,
  CHECKOUT_TAXES_ENDPOINT,
  buildTaxesBody,
  parseTaxesContext
} = require("./chatgpt-bangka-protocol");

const CHECKOUT_SNAPSHOT_ENDPOINT = "/backend-api/payments/checkout/snapshot";
const CHECKOUT_CONFIRM_ENDPOINT = "/backend-api/payments/checkout/confirm";
const ACCOUNT_CONTEXT_ENDPOINT = "/backend-api/accounts/check/v4-2023-04-27";
const PAYMENT_METHODS_ENDPOINT = "/backend-api/payments/payment_methods";
const CHECKOUT_APPROVAL_FLOW = "checkout_session_approval";
const PREPARED_SUBSCRIPTION = Symbol("prepared-subscription");

function extractCheckoutReference(checkoutUrl) {
  let parsed;
  try {
    parsed = new URL(String(checkoutUrl || ""));
  } catch {
    throw new AppError(409, "TRIAL_CHECKOUT_URL_INVALID", "A valid ChatGPT checkout URL is required.");
  }
  const match = parsed.pathname.match(/^\/checkout\/(openai_(?:llc|ie))\/((?:oaics|cs_(?:live|test))_[A-Za-z0-9_-]{8,255})\/?$/i);
  if (parsed.origin !== "https://chatgpt.com" || !match || parsed.username || parsed.password) {
    throw new AppError(409, "TRIAL_CHECKOUT_URL_INVALID", "A valid ChatGPT checkout URL is required.");
  }
  const checkoutSessionId = match[2];
  return Object.freeze({
    url: parsed.href,
    processorEntity: match[1].toLowerCase(),
    checkoutSessionId,
    sessionKind: /^oaics_/i.test(checkoutSessionId) ? "oaics" : "standard"
  });
}

function normalizeCheckoutPromotionEvidence(evidence, reference) {
  if (!evidence) return null;
  let evidenceReference;
  try {
    evidenceReference = extractCheckoutReference(evidence.checkoutUrl);
  } catch {
    throw new AppError(409, "TRIAL_CHECKOUT_EVIDENCE_MISMATCH", "The saved promotion evidence does not reference this Checkout.");
  }
  if (evidenceReference.processorEntity !== reference.processorEntity
      || evidenceReference.checkoutSessionId !== reference.checkoutSessionId) {
    throw new AppError(409, "TRIAL_CHECKOUT_EVIDENCE_MISMATCH", "The saved promotion evidence does not reference this Checkout.");
  }
  const discountPercent = Number(evidence.discountPercent);
  const dueTodayMinorUnits = Number(evidence.dueTodayMinorUnits);
  const promotionVerification = String(evidence.promotionVerification || "").trim();
  const campaignId = String(evidence.campaignId || "").trim();
  const verificationAccepted = ["tr_official_pricing_ui", "us_checkout_detail", "stripe_custom_checkout"].includes(promotionVerification);
  const zeroAmountVerified = evidence.zeroAmountVerified === true
    || (evidence.fullDiscountVerified === true && dueTodayMinorUnits === 0);
  const explicitPercentageRequired = promotionVerification !== "stripe_custom_checkout";
  if (!zeroAmountVerified
      || evidence.promotionApplied !== true
      || !Number.isFinite(dueTodayMinorUnits)
      || dueTodayMinorUnits !== 0
      || (explicitPercentageRequired && (!Number.isFinite(discountPercent) || discountPercent < 100))
      || !verificationAccepted
      || !/^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/.test(campaignId)) {
    throw new AppError(409, "TRIAL_PROMOTION_NOT_APPLIED", "The saved Checkout evidence does not verify a 100% first-month promotion.");
  }
  return Object.freeze({
    campaignId,
    discountPercent,
    dueTodayMinorUnits,
    zeroAmountVerified,
    promotionVerification
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

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function percentageFromLabel(label) {
  let maximum = 0;
  for (const match of String(label || "").matchAll(/(\d+(?:\.\d+)?)\s*%/g)) {
    maximum = Math.max(maximum, Number(match[1]) || 0);
  }
  return maximum;
}

function summarizeCheckout(payload) {
  const state = payload && payload.checkout_state || {};
  const billing = state.billingAddress || state.billing_address || {};
  const address = billing.address || {};
  const topLevelTaxAmounts = Array.isArray(state.taxAmounts) ? state.taxAmounts : null;
  const taxAmounts = topLevelTaxAmounts || (Array.isArray(state.lineItems) ? state.lineItems.flatMap((item) => (
    Array.isArray(item && item.taxAmounts) ? item.taxAmounts : []
  )) : []);
  const discounts = Array.isArray(state.discountAmounts) ? state.discountAmounts : [];
  const taxLabels = [...new Set(taxAmounts.map((item) => String(item && item.displayName || "").trim()).filter(Boolean))];
  const paymentMethodTypes = Array.isArray(payload && payload.payment_method_types)
    ? payload.payment_method_types.map((value) => String(value || "").toLowerCase())
    : [];
  return Object.freeze({
    status: String(payload && payload.status || "").toLowerCase(),
    paymentStatus: String(payload && payload.payment_status || "").toLowerCase(),
    promotionId: String(payload && payload.promo_campaign && payload.promo_campaign.promo_campaign_id || ""),
    discountPercent: discounts.reduce((maximum, item) => Math.max(maximum, numberOrZero(item && item.percentOff)), 0),
    dueTodayMinorUnits: numberOrNull(state && state.total && state.total.total && state.total.total.minorUnitsAmount),
    taxMinorUnits: taxAmounts.reduce((sum, item) => sum + numberOrZero(item && item.minorUnitsAmount), 0),
    taxRatePercent: taxLabels.reduce((maximum, label) => Math.max(maximum, percentageFromLabel(label)), 0),
    taxLabels: Object.freeze(taxLabels),
    canConfirm: state.canConfirm === true,
    requiresManualApproval: payload && payload.requires_manual_approval === true,
    paymentMethodTypes: Object.freeze(paymentMethodTypes),
    billing: Object.freeze({
      name: String(billing.name || "").trim(),
      address: Object.freeze({
        line1: String(address.line1 || "").trim(),
        city: String(address.city || "").trim(),
        state: String(address.state || "").trim().toUpperCase(),
        postal_code: String(address.postal_code || address.postalCode || "").trim(),
        country: String(address.country || "").trim().toUpperCase()
      })
    })
  });
}

function summarizeCheckoutWithEvidence(payload, promotionEvidence) {
  void promotionEvidence;
  return summarizeCheckout(payload);
}

function defaultPaymentMethod(payload, cardBinding) {
  const methods = Array.isArray(payload && payload.payment_methods)
    ? payload.payment_methods
    : Array.isArray(payload && payload.data) ? payload.data : [];
  const defaultId = String(payload && (
    payload.default_payment_method_id || payload.defaultPaymentMethodId
  ) || methods.find((method) => method && (method.default === true || method.is_default === true))?.id || "").trim();
  if (!/^pm_[A-Za-z0-9_-]{8,255}$/.test(defaultId)) {
    throw new AppError(409, "TRIAL_DEFAULT_CARD_REQUIRED", "The account payment-method list does not contain a default card.");
  }
  const summary = summarizePaymentMethod(payload, defaultId);
  const sameCard = summary
    && summary.default === true
    && summary.brand === String(cardBinding && cardBinding.brand || "").trim().toLowerCase()
    && summary.last4 === String(cardBinding && cardBinding.last4 || "").trim()
    && summary.expMonth === Number(cardBinding && cardBinding.expMonth)
    && summary.expYear === Number(cardBinding && cardBinding.expYear);
  if (!sameCard) {
    throw new AppError(409, "TRIAL_DEFAULT_CARD_MISMATCH", "The account default payment method no longer matches the verified bound card.");
  }
  return defaultId;
}

function customCheckoutSummary(live, campaignId) {
  return Object.freeze({
    status: String(live && live.status || "open").toLowerCase(),
    paymentStatus: "unpaid",
    promotionId: String(campaignId || ""),
    discountPercent: Number(live && live.discountPercent) || 0,
    dueTodayMinorUnits: live && live.dueTodayMinorUnits == null ? null : Number(live.dueTodayMinorUnits),
    taxMinorUnits: Number(live && live.taxMinorUnits) || 0,
    taxRatePercent: Number(live && live.taxRatePercent) || 0,
    taxLabels: Object.freeze(Array.isArray(live && live.taxLabels) ? [...live.taxLabels] : []),
    canConfirm: live && live.canConfirm === true,
    requiresManualApproval: false,
    paymentMethodTypes: Object.freeze(["card"]),
    billing: live && live.billing || Object.freeze({
      name: "",
      address: Object.freeze({ line1: "", city: "", state: "", postal_code: "", country: "" })
    })
  });
}

function assertTrialCheckout(summary, { manualApprovalConfirmed = false } = {}) {
  if (!summary.promotionId || summary.dueTodayMinorUnits !== 0) {
    throw new AppError(409, "TRIAL_PROMOTION_NOT_APPLIED", "The live Checkout amount due today is not zero.");
  }
  if (summary.requiresManualApproval && !manualApprovalConfirmed) {
    throw new AppError(409, "TRIAL_SUBSCRIPTION_ACTION_REQUIRED", "The checkout requires manual approval.");
  }
  if (summary.paymentMethodTypes.length && !summary.paymentMethodTypes.includes("card")) {
    throw new AppError(409, "TRIAL_CARD_PAYMENT_UNAVAILABLE", "The checkout does not currently accept the bound card.");
  }
  if (summary.status && !["open", "complete"].includes(summary.status)) {
    throw new AppError(409, "TRIAL_CHECKOUT_NOT_OPEN", `The checkout is ${summary.status}.`);
  }
}

function billingMatches(actual, expected) {
  const left = actual && actual.address || {};
  const right = expected && expected.address || {};
  return String(actual && actual.name || "").trim() === String(expected && expected.name || "").trim()
    && String(left.line1 || "").trim() === String(right.line1 || "").trim()
    && String(left.city || "").trim().toLowerCase() === String(right.city || "").trim().toLowerCase()
    && String(left.state || "").trim().toUpperCase() === String(right.state || "").trim().toUpperCase()
    && String(left.postal_code || "").trim() === String(right.postal_code || "").trim()
    && String(left.country || "").trim().toUpperCase() === "US";
}

function assertUsZeroTax(summary, billing, { billingSnapshotAccepted = false } = {}) {
  if (!billingSnapshotAccepted && !billingMatches(summary.billing, billing)) {
    throw new AppError(409, "TRIAL_BILLING_NOT_UPDATED", "The checkout did not retain the generated US billing name and address.");
  }
  if (summary.taxMinorUnits !== 0 || summary.taxRatePercent > 0) {
    throw new AppError(409, "TRIAL_TAX_NOT_ZERO", "The checkout still contains a non-zero tax amount or rate.");
  }
}

function requireBoundDefaultCard(cardBinding) {
  if (!cardBinding || cardBinding.status !== "succeeded" || cardBinding.default !== true
      || String(cardBinding.proxyRegion || "").toUpperCase() !== "US") {
    throw new AppError(409, "TRIAL_DEFAULT_CARD_REQUIRED", "A US-verified default payment method must be bound before subscribing.");
  }
}

function accountRecord(payload, accountId) {
  const accounts = payload && payload.accounts;
  if (!accounts || typeof accounts !== "object") return null;
  if (accounts[accountId]) return accounts[accountId];
  for (const candidate of Object.values(accounts)) {
    if (String(candidate && candidate.account && candidate.account.account_id || "") === accountId) return candidate;
  }
  return accounts.default || null;
}

function summarizeEntitlement(payload, accountId) {
  const record = accountRecord(payload, accountId);
  const entitlement = record && record.entitlement || {};
  const account = record && record.account || {};
  const plan = String(entitlement.subscription_plan || account.plan_type || "").toLowerCase();
  const active = entitlement.has_active_subscription === true && /plus/.test(plan);
  return Object.freeze({
    active,
    plan: plan || "",
    trial: entitlement.trial != null,
    expiresAt: entitlement.expires_at || null,
    renewsAt: entitlement.renews_at || null,
    cancelsAt: entitlement.cancels_at || null
  });
}

function confirmFailure(payload) {
  const status = String(payload && payload.status || "").toLowerCase();
  const code = String(payload && payload.error && payload.error.code || payload && payload.code || "").toLowerCase();
  return ["blocked", "error", "expired", "failed"].includes(status)
    || /blocked|expired|failed|invalid/.test(code);
}

function confirmFailureSummary(payload) {
  const error = payload && payload.error || {};
  return Object.freeze({
    status: String(payload && payload.status || "").slice(0, 80),
    code: String(error.code || payload && payload.code || "").slice(0, 120),
    type: String(payload && payload.type || "").slice(0, 80),
    errorType: String(error.type || "").slice(0, 80),
    declineCode: String(error.decline_code || "").slice(0, 80)
  });
}

function clientSecretFrom(payload) {
  const secret = String(payload && (payload.client_secret || payload.clientSecret) || "").trim();
  return /^(?:pi|seti)_[A-Za-z0-9_-]+_secret_[A-Za-z0-9_-]+$/.test(secret) ? secret : "";
}

function nowIso(now) {
  const value = now();
  const milliseconds = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(milliseconds)) throw new AppError(500, "TRIAL_SUBSCRIPTION_CLOCK_INVALID", "Subscription clock returned an invalid value.");
  return new Date(milliseconds).toISOString();
}

class ChatGptTrialSubscriptionClient {
  constructor(options = {}) {
    this.runtimeFactory = options.runtimeFactory || (() => new CheckoutProtocolRuntime(options));
    this.proxySessionId = options.proxySessionId || "";
    this.sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.now = options.now || Date.now;
    this.billingAttempts = Math.max(1, Number(options.billingAttempts) || 5);
    this.entitlementAttempts = Math.max(1, Number(options.entitlementAttempts) || 10);
    this.pollDelayMs = Math.max(0, Number(options.pollDelayMs) || 1_000);
    this.paymentElementAttempts = Math.max(1, Number(options.paymentElementAttempts) || 5);
    this.paymentElementWaitMs = Math.max(1_000, Number(options.paymentElementWaitMs) || 60_000);
    this.paymentElementRefreshDelayMs = Math.max(0, Number(options.paymentElementRefreshDelayMs) || 60_000);
    this.postConfirmObservationMs = Math.max(1_000, Number(options.postConfirmObservationMs) || 60_000);
    this.diagnosticDirectory = String(options.diagnosticDirectory || process.env.LOCAL_WEB_CHECKOUT_DIAGNOSTIC_DIR || "").trim();
  }

  checkoutRoute(reference) {
    return `/backend-api/payments/checkout/${encodeURIComponent(reference.processorEntity)}/${encodeURIComponent(reference.checkoutSessionId)}`;
  }

  async readCheckout(runtime, authenticated, accountId, reference) {
    const route = this.checkoutRoute(reference);
    return runtime.requestJson(route, {
      headers: accountHeaders(authenticated.accessToken, accountId, route),
      stage: "Checkout detail"
    });
  }

  async readEntitlement(runtime, authenticated, accountId) {
    const query = new URLSearchParams({ timezone_offset_min: "0" });
    const payload = await runtime.requestJson(`${ACCOUNT_CONTEXT_ENDPOINT}?${query}`, {
      headers: accountHeaders(authenticated.accessToken, accountId, ACCOUNT_CONTEXT_ENDPOINT),
      stage: "Subscription entitlement"
    });
    return summarizeEntitlement(payload, accountId);
  }

  buildResult({ entitlement, checkout, promotionId, recovered = false }) {
    return Object.freeze({
      status: "active",
      plan: entitlement.plan || "plus",
      promotionId: promotionId || "",
      billingCountry: checkout ? checkout.billing.address.country : "",
      taxRatePercent: checkout ? checkout.taxRatePercent : null,
      taxMinorUnits: checkout ? checkout.taxMinorUnits : null,
      dueTodayMinorUnits: checkout ? checkout.dueTodayMinorUnits : null,
      trial: entitlement.trial || Boolean(promotionId),
      expiresAt: entitlement.expiresAt,
      renewsAt: entitlement.renewsAt,
      cancelsAt: entitlement.cancelsAt,
      proxyRegion: "US",
      recovered,
      subscribedAt: nowIso(this.now)
    });
  }

  async postConfirm(runtime, authenticated, accountId, body, preparedSentinelHeaders = null) {
    const sentinelHeaders = preparedSentinelHeaders === false
      ? {}
      : preparedSentinelHeaders || await runtime.acquireSentinelHeaders(CHECKOUT_APPROVAL_FLOW);
    return runtime.requestJson(CHECKOUT_CONFIRM_ENDPOINT, {
      method: "POST",
      headers: accountHeaders(authenticated.accessToken, accountId, CHECKOUT_CONFIRM_ENDPOINT, {
        ...sentinelHeaders,
        "Content-Type": "application/json"
      }),
      body,
      stage: "Checkout confirmation"
    });
  }

  async observeRejectedCheckout(runtime, taskId, reportProgress) {
    const uiObservation = typeof runtime.observeCheckoutPaymentError === "function"
      ? await runtime.observeCheckoutPaymentError(this.postConfirmObservationMs)
      : Object.freeze({ found: false, label: "", red: false, nearPaymentElement: false, elapsedMs: 0 });
    let screenshotPath = "";
    if (this.diagnosticDirectory && typeof runtime.captureCheckoutScreenshot === "function") {
      const safeTaskId = String(taskId || "task").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "task";
      screenshotPath = await runtime.captureCheckoutScreenshot(path.join(
        this.diagnosticDirectory,
        `checkout-payment-error-${safeTaskId}-${Date.now()}.png`
      )).catch(() => "");
    }
    await reportProgress(
      uiObservation.found
        ? `Checkout 页面支付方式附近出现红色提示：${uiObservation.label}`
        : `Confirm 返回 blocked 后保留页面 ${Math.ceil(this.postConfirmObservationMs / 1_000)} 秒，未观察到 payment not approved 标签`,
      {
        uiPaymentErrorFound: uiObservation.found === true,
        uiPaymentErrorLabel: uiObservation.label || "",
        uiPaymentErrorRed: uiObservation.red === true,
        uiPaymentErrorNearPaymentElement: uiObservation.nearPaymentElement === true,
        screenshotPath
      }
    );
    return Object.freeze({ ...uiObservation, screenshotPath });
  }

  assertPrepared(prepared) {
    if (!prepared || prepared[PREPARED_SUBSCRIPTION] !== this) {
      throw new AppError(409, "TRIAL_SUBSCRIPTION_PREPARATION_INVALID", "The prepared subscription handle is invalid.");
    }
    if (prepared.closed) {
      throw new AppError(409, "TRIAL_SUBSCRIPTION_PREPARATION_CLOSED", "The prepared subscription handle is already closed.");
    }
    return prepared;
  }

  async prepare({
    taskId,
    registration,
    accountSession,
    checkoutUrl,
    checkoutEvidence,
    cardProfile,
    cardBinding,
    proxy,
    confirmed,
    reportProgress = async () => {}
  } = {}) {
    if (confirmed !== true) {
      throw new AppError(409, "TRIAL_SUBSCRIPTION_CONFIRMATION_REQUIRED", "Confirm the subscription and renewal terms before continuing.");
    }
    requireBoundDefaultCard(cardBinding);
    const session = normalizeAccountSession(accountSession);
    const reference = extractCheckoutReference(checkoutUrl);
    const bangKaProtocol = reference.sessionKind === "oaics"
      && checkoutEvidence && checkoutEvidence.protocolMode === "bangka_oaics";
    const promotionEvidence = bangKaProtocol ? null : normalizeCheckoutPromotionEvidence(checkoutEvidence, reference);
    const billing = normalizeCardProfile(cardProfile);
    const stickyProxy = createStickyProxySession(proxy, {
      sessionId: this.proxySessionId || crypto.randomBytes(4).toString("hex")
    });
    const runtime = this.runtimeFactory();
    let verifiedCheckout = null;
    try {
      await reportProgress("Restoring the account session through the US proxy and verifying the exit.");
      await runtime.open({ accountSession: session, proxy: stickyProxy });
      await runtime.verifyExit("US");
      const authenticated = await runtime.readSession();
      const accountId = resolveAccountId(authenticated.session);

      try {
        const existing = await this.readEntitlement(runtime, authenticated, accountId);
        if (existing.active) {
          await reportProgress("An active Plus subscription already exists; restoring the successful state.");
          if (typeof runtime.saveSession === "function") await runtime.saveSession(session.path);
          return {
            [PREPARED_SUBSCRIPTION]: this,
            runtime,
            taskId,
            session,
            reportProgress,
            recoveredResult: this.buildResult({ entitlement: existing, checkout: null, promotionId: "", recovered: true }),
            requiresConfirmation: false,
            armed: true,
            closed: false
          };
        }
      } catch (error) {
        if (error && error.code === "CHECKOUT_SESSION_EXPIRED") throw error;
      }

      if (bangKaProtocol) {
        const paymentMethodRoute = `${PAYMENT_METHODS_ENDPOINT}?${new URLSearchParams({ account_id: accountId })}`;
        const methodsPayload = await runtime.requestJson(paymentMethodRoute, {
          headers: accountHeaders(authenticated.accessToken, accountId, PAYMENT_METHODS_ENDPOINT),
          stage: "Default payment-method verification"
        });
        const paymentMethodId = defaultPaymentMethod(methodsPayload, cardBinding);
        const publishableKey = String(checkoutEvidence && checkoutEvidence.stripePublishableKey || "").trim();
        if (!/^pk_(?:live|test)_[A-Za-z0-9]+$/.test(publishableKey)) {
          throw new AppError(409, "TRIAL_STRIPE_KEY_REQUIRED", "The extracted Checkout is missing its Stripe publishable key.");
        }
        const checkoutEmail = String(registration && registration.email
          || authenticated.session && authenticated.session.user && authenticated.session.user.email
          || "").trim();
        if (!checkoutEmail || !checkoutEmail.includes("@")) {
          throw new AppError(409, "TRIAL_CHECKOUT_EMAIL_REQUIRED", "The account email is required for Checkout taxes.");
        }
        const currency = String(checkoutEvidence.currency || BANGKA_CHECKOUT_CONFIG.currency).trim().toLowerCase();
        await reportProgress("默认卡已复查，正在通过 US 写入 Taxes 并验证实时金额为 0");
        const taxesPayload = await runtime.requestJson(CHECKOUT_TAXES_ENDPOINT, {
          method: "POST",
          headers: accountHeaders(authenticated.accessToken, accountId, CHECKOUT_TAXES_ENDPOINT, {
            "Content-Type": "application/json",
            Referer: reference.url
          }),
          body: buildTaxesBody({
            checkoutSessionId: reference.checkoutSessionId,
            checkoutEmail,
            processorEntity: reference.processorEntity,
            currency,
            billing
          }),
          stage: "US checkout taxes"
        });
        const taxes = parseTaxesContext(taxesPayload, currency);
        verifiedCheckout = Object.freeze({
          status: "open",
          paymentStatus: "unpaid",
          promotionId: String(checkoutEvidence.campaignId || BANGKA_CHECKOUT_CONFIG.campaignId),
          discountPercent: 100,
          dueTodayMinorUnits: 0,
          taxMinorUnits: 0,
          taxRatePercent: 0,
          taxLabels: Object.freeze([]),
          canConfirm: true,
          requiresManualApproval: false,
          paymentMethodTypes: taxes.paymentMethodTypes,
          billing
        });
        await runtime.installCheckoutStripeBridge();
        await runtime.navigateCheckout(reference.url);
        const confirmation = await runtime.createBangKaConfirmationToken({
          publishableKey,
          customerSessionClientSecret: taxes.customerSessionClientSecret,
          amount: taxes.amount,
          currency: taxes.currency,
          paymentMethodTypes: taxes.paymentMethodTypes,
          paymentMethodId,
          email: checkoutEmail
        });
        await reportProgress("Taxes 实时金额 0 与 Stripe.js ConfirmationToken 已就绪，等待同步释放", {
          protocolMode: "bangka_oaics",
          amountSource: taxes.amountSource,
          paymentMethodTypes: taxes.paymentMethodTypes,
          customPaymentMethodCount: taxes.customPaymentMethodCount
        });
        return {
          [PREPARED_SUBSCRIPTION]: this,
          runtime,
          taskId,
          session,
          authenticated,
          accountId,
          reference,
          verifiedCheckout,
          billing,
          paymentMethodId,
          stripePublishableKey: publishableKey,
          confirmationMode: "bangka_oaics",
          confirmation,
          reportProgress,
          recoveredResult: null,
          requiresConfirmation: true,
          sentinelHeaders: null,
          armed: false,
          closed: false
        };
      }

      await runtime.installCheckoutStripeBridge();
      await runtime.navigateCheckout(reference.url);
      if (reference.sessionKind === "standard") {
        if (typeof runtime.waitForCheckoutCustomSession !== "function"
            || typeof runtime.updateCustomCheckoutBilling !== "function"
            || typeof runtime.confirmCustomCheckout !== "function") {
          throw new AppError(503, "CHECKOUT_CUSTOM_RUNTIME_UNAVAILABLE", "Stripe Custom Checkout support is not initialized.");
        }
        const initialLive = await runtime.waitForCheckoutCustomSession(this.paymentElementWaitMs);
        const campaignId = promotionEvidence && promotionEvidence.campaignId || "";
        const initial = customCheckoutSummary(initialLive, campaignId);
        assertTrialCheckout(initial, { manualApprovalConfirmed: confirmed === true });
        await reportProgress("Stripe Custom Checkout has verified zero due today; applying the US billing address.", {
          promotionId: campaignId,
          promotionVerification: "stripe_custom_checkout",
          discountPercent: initial.discountPercent,
          dueTodayMinorUnits: initial.dueTodayMinorUnits
        });

        const billedLive = await runtime.updateCustomCheckoutBilling(billing);
        const billed = customCheckoutSummary(billedLive, campaignId);
        assertTrialCheckout(billed, { manualApprovalConfirmed: confirmed === true });
        assertUsZeroTax(billed, billing);

        const methodsRoute = `${PAYMENT_METHODS_ENDPOINT}?${new URLSearchParams({ account_id: accountId })}`;
        const methodsPayload = await runtime.requestJson(methodsRoute, {
          headers: accountHeaders(authenticated.accessToken, accountId, PAYMENT_METHODS_ENDPOINT),
          stage: "Default payment-method verification"
        });
        const paymentMethodId = defaultPaymentMethod(methodsPayload, cardBinding);
        verifiedCheckout = billed;
        await reportProgress("The live Checkout remains zero due after US billing, and the verified default card is ready for synchronized release.");
        return {
          [PREPARED_SUBSCRIPTION]: this,
          runtime,
          taskId,
          session,
          authenticated,
          accountId,
          reference,
          verifiedCheckout,
          billing,
          paymentMethodId,
          confirmationMode: "stripe_custom_checkout",
          confirmation: null,
          reportProgress,
          recoveredResult: null,
          requiresConfirmation: true,
          sentinelHeaders: null,
          armed: false,
          closed: false
        };
      }
      const initialPayload = await this.readCheckout(runtime, authenticated, accountId, reference);
      const initial = summarizeCheckoutWithEvidence(initialPayload, promotionEvidence);
      assertTrialCheckout(initial, { manualApprovalConfirmed: confirmed === true });
      await reportProgress("The promoted Checkout and default card are confirmed; writing the US billing snapshot.", {
        promotionId: initial.promotionId,
        promotionVerification: promotionEvidence && promotionEvidence.promotionVerification || "checkout_detail"
      });

      await runtime.requestJson(CHECKOUT_SNAPSHOT_ENDPOINT, {
        method: "POST",
        headers: accountHeaders(authenticated.accessToken, accountId, CHECKOUT_SNAPSHOT_ENDPOINT, {
          "Content-Type": "application/json"
        }),
        body: {
          snapshot: {
            billing_address: {
              name: billing.name,
              address: billing.address
            }
          }
        },
        stage: "US billing snapshot"
      });

      let lastBillingError = null;
      for (let attempt = 0; attempt < this.billingAttempts; attempt += 1) {
        if (attempt > 0 && this.pollDelayMs) await this.sleep(this.pollDelayMs * attempt);
        const payload = await this.readCheckout(runtime, authenticated, accountId, reference);
        const summary = summarizeCheckoutWithEvidence(payload, promotionEvidence);
        try {
          assertTrialCheckout(summary, { manualApprovalConfirmed: confirmed === true });
          assertUsZeroTax(summary, billing, { billingSnapshotAccepted: true });
          verifiedCheckout = Object.freeze({ ...summary, billing });
          break;
        } catch (error) {
          lastBillingError = error;
        }
      }
      if (!verifiedCheckout) throw lastBillingError || new AppError(409, "TRIAL_BILLING_NOT_UPDATED", "US billing verification did not complete.");
      await reportProgress("The US billing snapshot was accepted and verified with zero tax.");

      await runtime.navigateCheckout(reference.url);
      let paymentElementError = null;
      let confirmation = null;
      for (let attempt = 0; attempt < this.paymentElementAttempts; attempt += 1) {
        try {
          if (attempt > 0) {
            await reportProgress(`Checkout resources are still loading; wait ${Math.ceil(this.paymentElementRefreshDelayMs / 1_000)} seconds and refresh only the extracted page (${attempt + 1}/${this.paymentElementAttempts}).`);
            if (this.paymentElementRefreshDelayMs) await this.sleep(this.paymentElementRefreshDelayMs);
            if (typeof runtime.refreshCheckout === "function") await runtime.refreshCheckout(reference.url);
            else await runtime.navigateCheckout(reference.url);
          }
          await runtime.waitForCheckoutPaymentElement(this.paymentElementWaitMs);
          confirmation = await runtime.createCheckoutConfirmationToken(billing);
          paymentElementError = null;
          break;
        } catch (error) {
          paymentElementError = error;
          const reloadable = error && (
            error.code === "CHECKOUT_PAYMENT_ELEMENT_NOT_READY"
            || error.code === "CHECKOUT_PAGE_REFRESH_FAILED"
            || (error.code === "CHECKOUT_CONFIRMATION_TOKEN_FAILED"
              && /mounted element|payment element.*ready|not ready|timed out|card number is incomplete/i.test(String(error.message || "")))
          );
          if (!reloadable) throw error;
        }
      }
      if (paymentElementError) throw paymentElementError;
      if (!confirmation) throw new AppError(502, "CHECKOUT_CONFIRMATION_TOKEN_FAILED", "Stripe confirmation token was not created.");
      await reportProgress("The Stripe confirmation token is ready; Checkout is fully loaded at the batch barrier.");

      return {
        [PREPARED_SUBSCRIPTION]: this,
        runtime,
        taskId,
        session,
        authenticated,
        accountId,
        reference,
        verifiedCheckout,
        billing,
        confirmationMode: "oaics",
        confirmation,
        reportProgress,
        recoveredResult: null,
        requiresConfirmation: true,
        sentinelHeaders: null,
        armed: false,
        closed: false
      };
    } catch (error) {
      await runtime.close().catch(() => {});
      if (error instanceof AppError) throw error;
      throw new AppError(502, "TRIAL_SUBSCRIPTION_FAILED", error && error.message || "Trial subscription failed.");
    }
  }

  async armPrepared(prepared) {
    const handle = this.assertPrepared(prepared);
    if (!handle.requiresConfirmation || handle.armed) return handle;
    if (["stripe_custom_checkout", "bangka_oaics"].includes(handle.confirmationMode)) {
      handle.armed = true;
      await handle.reportProgress(handle.confirmationMode === "bangka_oaics"
        ? "Taxes、默认卡和 ConfirmationToken 已就绪，等待同步释放。"
        : "Stripe Custom Checkout is armed with the verified default card and waiting for synchronized release.");
      return handle;
    }
    handle.sentinelHeaders = await handle.runtime.acquireSentinelHeaders(CHECKOUT_APPROVAL_FLOW);
    handle.armed = true;
    await handle.reportProgress("The Sentinel approval headers are armed and waiting for synchronized confirm release.");
    return handle;
  }

  async confirmPrepared(prepared) {
    const handle = this.assertPrepared(prepared);
    if (handle.recoveredResult) return { recoveredResult: handle.recoveredResult };
    if (!handle.armed || (!["stripe_custom_checkout", "bangka_oaics"].includes(handle.confirmationMode) && !handle.sentinelHeaders)) {
      throw new AppError(409, "TRIAL_SUBSCRIPTION_NOT_ARMED", "The prepared subscription is not armed for synchronized confirmation.");
    }
    const {
      runtime,
      authenticated,
      accountId,
      reference,
      confirmation,
      taskId,
      reportProgress
    } = handle;
    try {
      if (handle.confirmationMode === "stripe_custom_checkout") {
        const customConfirmation = await runtime.confirmCustomCheckout({
          paymentMethodId: handle.paymentMethodId,
          billing: handle.billing
        });
        return { customConfirmation };
      }
      let confirmedCheckout = await this.postConfirm(runtime, authenticated, accountId, {
        checkout_session_id: reference.checkoutSessionId,
        confirm_token: confirmation.token,
        selected_payment_method_type: confirmation.selectedPaymentMethodType
      }, handle.confirmationMode === "bangka_oaics" ? false : handle.sentinelHeaders);
      if (confirmFailure(confirmedCheckout)) {
        const uiObservation = await this.observeRejectedCheckout(runtime, taskId, reportProgress);
        throw new AppError(
          409,
          "TRIAL_SUBSCRIPTION_REJECTED",
          `The checkout confirmation was rejected: ${JSON.stringify(confirmFailureSummary(confirmedCheckout))}`,
          { provider: confirmFailureSummary(confirmedCheckout), uiObservation }
        );
      }

      if (handle.confirmationMode !== "bangka_oaics"
          && confirmedCheckout && confirmedCheckout.conditional_offer_preflight === true
          && String(confirmedCheckout.type || "").toLowerCase() === "setup_intent") {
        const preflightSecret = clientSecretFrom(confirmedCheckout);
        if (!preflightSecret) {
          throw new AppError(502, "TRIAL_PREFLIGHT_SECRET_MISSING", "The conditional-offer preflight did not return a valid client secret.");
        }
        await runtime.handleStripeNextAction(preflightSecret);
        confirmedCheckout = await this.postConfirm(runtime, authenticated, accountId, {
          checkout_session_id: reference.checkoutSessionId
        });
        if (confirmFailure(confirmedCheckout)) {
          const uiObservation = await this.observeRejectedCheckout(runtime, taskId, reportProgress);
          throw new AppError(
            409,
            "TRIAL_SUBSCRIPTION_REJECTED",
            `The conditional-offer continuation was rejected: ${JSON.stringify(confirmFailureSummary(confirmedCheckout))}`,
            { provider: confirmFailureSummary(confirmedCheckout), uiObservation }
          );
        }
      }
      let stripeConfirmation = null;
      if (handle.confirmationMode === "bangka_oaics") {
        const confirmationSecret = clientSecretFrom(confirmedCheckout);
        if (!confirmationSecret) {
          throw new AppError(502, "TRIAL_CONFIRM_SECRET_MISSING", "Checkout confirmation did not return a valid client secret.");
        }
        const stripeInput = {
          type: confirmedCheckout.type,
          clientSecret: confirmationSecret,
          confirmationToken: confirmation.token,
          publishableKey: handle.stripePublishableKey,
          checkoutSessionId: reference.checkoutSessionId,
          processorEntity: reference.processorEntity,
          paymentMethodId: handle.paymentMethodId,
          planType: "plus"
        };
        stripeConfirmation = typeof runtime.confirmBangKaStripeIntent === "function"
          ? await runtime.confirmBangKaStripeIntent(stripeInput)
          : await runtime.confirmStripeIntent(stripeInput);
        await reportProgress("同步释放已连续完成 ChatGPT confirm 与 Stripe intent confirm。", {
          protocolMode: "bangka_oaics",
          stripeStatus: stripeConfirmation.status
        });
      }
      return { confirmedCheckout, stripeConfirmation };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(502, "TRIAL_SUBSCRIPTION_CONFIRM_FAILED", error && error.message || "Trial subscription confirmation failed.");
    }
  }

  async verifyPrepared(prepared, confirmationResult = {}) {
    const handle = this.assertPrepared(prepared);
    if (confirmationResult.recoveredResult || handle.recoveredResult) {
      return confirmationResult.recoveredResult || handle.recoveredResult;
    }
    const {
      runtime,
      authenticated,
      accountId,
      session,
      confirmation,
      verifiedCheckout,
      reportProgress
    } = handle;
    const confirmedCheckout = confirmationResult.confirmedCheckout;
    const customConfirmation = confirmationResult.customConfirmation;
    if (!confirmedCheckout && !customConfirmation) {
      throw new AppError(502, "TRIAL_SUBSCRIPTION_CONFIRM_RESULT_MISSING", "The synchronized confirmation did not return a checkout result.");
    }
    try {
      const confirmationSecret = confirmedCheckout && clientSecretFrom(confirmedCheckout);
      if (confirmationSecret && handle.confirmationMode !== "bangka_oaics") {
        await runtime.confirmStripeIntent({
          type: confirmedCheckout.type,
          clientSecret: confirmationSecret,
          confirmationToken: confirmation.token
        });
      }
      if (typeof runtime.saveSession === "function") await runtime.saveSession(session.path);

      await reportProgress("The subscription confirmation was submitted; polling Plus entitlement.");
      let entitlement = null;
      for (let attempt = 0; attempt < this.entitlementAttempts; attempt += 1) {
        if (attempt > 0 && this.pollDelayMs) await this.sleep(this.pollDelayMs);
        entitlement = await this.readEntitlement(runtime, authenticated, accountId);
        if (entitlement.active) break;
      }
      if (!entitlement || !entitlement.active) {
        throw new AppError(409, "TRIAL_SUBSCRIPTION_NOT_VERIFIED", "The confirmation completed, but the Plus entitlement is not active yet.");
      }
      await reportProgress("Plus entitlement is active; subscription is complete.");
      return this.buildResult({
        entitlement,
        checkout: verifiedCheckout,
        promotionId: verifiedCheckout.promotionId
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(502, "TRIAL_SUBSCRIPTION_FAILED", error && error.message || "Trial subscription failed.");
    }
  }

  async closePrepared(prepared) {
    if (!prepared || prepared[PREPARED_SUBSCRIPTION] !== this || prepared.closed) return;
    prepared.closed = true;
    await prepared.runtime.close().catch(() => {});
  }

  async subscribe(input = {}) {
    let prepared = null;
    try {
      prepared = await this.prepare(input);
      await this.armPrepared(prepared);
      const confirmation = await this.confirmPrepared(prepared);
      return await this.verifyPrepared(prepared, confirmation);
    } finally {
      await this.closePrepared(prepared);
    }
  }
}

module.exports = {
  ACCOUNT_CONTEXT_ENDPOINT,
  CHECKOUT_CONFIRM_ENDPOINT,
  CHECKOUT_SNAPSHOT_ENDPOINT,
  ChatGptTrialSubscriptionClient,
  assertTrialCheckout,
  assertUsZeroTax,
  extractCheckoutReference,
  normalizeCheckoutPromotionEvidence,
  summarizeCheckout,
  summarizeCheckoutWithEvidence,
  summarizeEntitlement
};
