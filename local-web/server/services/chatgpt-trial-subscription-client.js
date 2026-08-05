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
  resolveAccountId
} = require("./chatgpt-card-binding-client");

const CHECKOUT_SNAPSHOT_ENDPOINT = "/backend-api/payments/checkout/snapshot";
const CHECKOUT_CONFIRM_ENDPOINT = "/backend-api/payments/checkout/confirm";
const ACCOUNT_CONTEXT_ENDPOINT = "/backend-api/accounts/check/v4-2023-04-27";
const CHECKOUT_APPROVAL_FLOW = "checkout_session_approval";

function extractCheckoutReference(checkoutUrl) {
  let parsed;
  try {
    parsed = new URL(String(checkoutUrl || ""));
  } catch {
    throw new AppError(409, "TRIAL_CHECKOUT_URL_INVALID", "A valid ChatGPT checkout URL is required.");
  }
  const match = parsed.pathname.match(/^\/checkout\/(openai_(?:llc|ie))\/(oaics_[A-Za-z0-9_-]{8,255})\/?$/i);
  if (parsed.origin !== "https://chatgpt.com" || !match || parsed.username || parsed.password) {
    throw new AppError(409, "TRIAL_CHECKOUT_URL_INVALID", "A valid ChatGPT OAICS checkout URL is required.");
  }
  return Object.freeze({
    url: parsed.href,
    processorEntity: match[1].toLowerCase(),
    checkoutSessionId: match[2]
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
    dueTodayMinorUnits: numberOrZero(state && state.total && state.total.total && state.total.total.minorUnitsAmount),
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

function assertTrialCheckout(summary, { manualApprovalConfirmed = false } = {}) {
  if (!summary.promotionId || summary.discountPercent < 100 || summary.dueTodayMinorUnits !== 0) {
    throw new AppError(409, "TRIAL_PROMOTION_NOT_APPLIED", "The checkout no longer contains a 100% first-month promotion.");
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

  async postConfirm(runtime, authenticated, accountId, body) {
    const sentinelHeaders = await runtime.acquireSentinelHeaders(CHECKOUT_APPROVAL_FLOW);
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

  async subscribe({
    taskId,
    accountSession,
    checkoutUrl,
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
    const billing = normalizeCardProfile(cardProfile);
    const stickyProxy = createStickyProxySession(proxy, {
      sessionId: this.proxySessionId || crypto.randomBytes(4).toString("hex")
    });
    const runtime = this.runtimeFactory();
    let verifiedCheckout = null;
    try {
      await reportProgress("正在通过 US 代理恢复账号会话并核验出口");
      await runtime.open({ accountSession: session, proxy: stickyProxy });
      await runtime.verifyExit("US");
      const authenticated = await runtime.readSession();
      const accountId = resolveAccountId(authenticated.session);

      try {
        const existing = await this.readEntitlement(runtime, authenticated, accountId);
        if (existing.active) {
          await reportProgress("账号已存在有效 Plus 订阅，已直接恢复成功状态");
          if (typeof runtime.saveSession === "function") await runtime.saveSession(session.path);
          return this.buildResult({ entitlement: existing, checkout: null, promotionId: "", recovered: true });
        }
      } catch (error) {
        if (error && error.code === "CHECKOUT_SESSION_EXPIRED") throw error;
      }

      await runtime.installCheckoutStripeBridge();
      await runtime.navigateCheckout(reference.url);
      const initialPayload = await this.readCheckout(runtime, authenticated, accountId, reference);
      const initial = summarizeCheckout(initialPayload);
      assertTrialCheckout(initial, { manualApprovalConfirmed: confirmed === true });
      await reportProgress("活动 Checkout 与默认卡已确认，正在写入 US 账单快照", {
        promotionId: initial.promotionId
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
        const summary = summarizeCheckout(payload);
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
      await reportProgress("US 账单快照已由官方接口接受并复核：税额与税率均为 0");

      await runtime.navigateCheckout(reference.url);
      let paymentElementError = null;
      let confirmation = null;
      for (let attempt = 0; attempt < this.paymentElementAttempts; attempt += 1) {
        try {
          if (attempt > 0) {
            await reportProgress(`结账资源仍在加载，继续等待 ${Math.ceil(this.paymentElementRefreshDelayMs / 1_000)} 秒后刷新提链页面（${attempt + 1}/${this.paymentElementAttempts}）`);
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
      await reportProgress("Stripe 已使用默认卡生成一次性确认令牌，正在提交订阅接口");

      let confirmedCheckout = await this.postConfirm(runtime, authenticated, accountId, {
        checkout_session_id: reference.checkoutSessionId,
        confirm_token: confirmation.token,
        selected_payment_method_type: confirmation.selectedPaymentMethodType
      });
      if (confirmFailure(confirmedCheckout)) {
        const uiObservation = await this.observeRejectedCheckout(runtime, taskId, reportProgress);
        throw new AppError(
          409,
          "TRIAL_SUBSCRIPTION_REJECTED",
          `The checkout confirmation was rejected: ${JSON.stringify(confirmFailureSummary(confirmedCheckout))}`,
          { provider: confirmFailureSummary(confirmedCheckout), uiObservation }
        );
      }

      if (confirmedCheckout && confirmedCheckout.conditional_offer_preflight === true
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

      const confirmationSecret = clientSecretFrom(confirmedCheckout);
      if (confirmationSecret) {
        await runtime.confirmStripeIntent({
          type: confirmedCheckout.type,
          clientSecret: confirmationSecret,
          confirmationToken: confirmation.token
        });
      }
      if (typeof runtime.saveSession === "function") await runtime.saveSession(session.path);

      await reportProgress("订阅确认已提交，正在轮询账号 Plus entitlement");
      let entitlement = null;
      for (let attempt = 0; attempt < this.entitlementAttempts; attempt += 1) {
        if (attempt > 0 && this.pollDelayMs) await this.sleep(this.pollDelayMs);
        entitlement = await this.readEntitlement(runtime, authenticated, accountId);
        if (entitlement.active) break;
      }
      if (!entitlement || !entitlement.active) {
        throw new AppError(409, "TRIAL_SUBSCRIPTION_NOT_VERIFIED", "The confirmation completed, but the Plus entitlement is not active yet.");
      }
      await reportProgress("Plus entitlement 已激活，一键订阅完成");
      return this.buildResult({
        entitlement,
        checkout: verifiedCheckout,
        promotionId: verifiedCheckout.promotionId
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(502, "TRIAL_SUBSCRIPTION_FAILED", error && error.message || "Trial subscription failed.");
    } finally {
      await runtime.close().catch(() => {});
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
  summarizeCheckout,
  summarizeEntitlement
};
