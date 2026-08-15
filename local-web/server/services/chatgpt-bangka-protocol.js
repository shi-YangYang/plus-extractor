"use strict";

const { AppError } = require("../lib/errors");

const BANGKA_CHECKOUT_CONFIG = Object.freeze({
  country: "PH",
  currency: "PHP",
  campaignId: "plus-1-month-free",
  planName: "chatgptplusplan",
  checkoutUiMode: "custom"
});

const CHECKOUT_TAXES_ENDPOINT = "/backend-api/payments/checkout/taxes";

function visit(value, callback, seen = new Set()) {
  if (value == null) return "";
  if (typeof value === "string") return callback(value) || "";
  if (typeof value !== "object" || seen.has(value)) return "";
  seen.add(value);
  const direct = callback(value);
  if (direct) return direct;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = visit(child, callback, seen);
    if (found) return found;
  }
  return "";
}

function extractCheckoutSessionId(payload) {
  return visit(payload, (value) => {
    if (typeof value === "string") {
      return value.match(/(?:oaics_|cs_(?:live|test)_|cs_)[A-Za-z0-9_-]+/)?.[0] || "";
    }
    for (const key of ["checkout_session_id", "checkoutSessionId", "session_id", "id"]) {
      const candidate = String(value && value[key] || "").trim();
      if (/^(?:oaics_|cs_)/.test(candidate)) return candidate;
    }
    return "";
  });
}

function extractProcessorEntity(payload, country = "") {
  const found = visit(payload, (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return "";
    return String(value.processor_entity || value.processorEntity || "").trim();
  });
  if (found) return found;
  return ["US", "AU"].includes(String(country || "").toUpperCase()) ? "openai_llc" : "openai_ie";
}

function extractStripePublishableKey(payload) {
  return visit(payload, (value) => {
    if (typeof value === "string") return value.match(/pk_(?:live|test)_[A-Za-z0-9]+/)?.[0] || "";
    if (!value || typeof value !== "object" || Array.isArray(value)) return "";
    for (const key of ["stripe_publishable_key", "publishable_key", "publishableKey", "stripePublishableKey", "key"]) {
      const candidate = String(value[key] || "").trim();
      if (/^pk_(?:live|test)_[A-Za-z0-9]+$/.test(candidate)) return candidate;
    }
    return "";
  });
}

function extractCheckoutAmount(payload) {
  const candidates = [];
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    candidates.push(payload);
    for (const child of Object.values(payload)) {
      if (child && typeof child === "object" && !Array.isArray(child)) candidates.push(child);
    }
  }
  for (const candidate of candidates) {
    const totalSummary = candidate.total_summary;
    if (totalSummary && typeof totalSummary === "object") {
      for (const key of ["due", "total"]) {
        if (totalSummary[key] == null || totalSummary[key] === "") continue;
        const amount = Number(totalSummary[key]);
        if (Number.isFinite(amount)) return Object.freeze({ amount, source: `total_summary.${key}` });
      }
    }
    const invoice = candidate.invoice;
    if (invoice && typeof invoice === "object" && invoice.amount_due != null) {
      const amount = Number(invoice.amount_due);
      if (Number.isFinite(amount)) return Object.freeze({ amount, source: "invoice.amount_due" });
    }
    for (const key of ["amount_due", "amount_total", "total"]) {
      if (candidate[key] == null || candidate[key] === "" || typeof candidate[key] === "object") continue;
      const amount = Number(candidate[key]);
      if (Number.isFinite(amount)) return Object.freeze({ amount, source: key });
    }
  }
  return Object.freeze({ amount: null, source: "" });
}

function buildCheckoutCreateBody(config = BANGKA_CHECKOUT_CONFIG) {
  return Object.freeze({
    entry_point: "all_plans_pricing_modal",
    plan_name: config.planName,
    billing_details: Object.freeze({ country: config.country, currency: config.currency }),
    checkout_ui_mode: config.checkoutUiMode,
    promo_campaign: Object.freeze({
      promo_campaign_id: config.campaignId,
      is_coupon_from_query_param: false
    })
  });
}

function buildCheckoutUpdateBody({ checkoutSessionId, processorEntity, config = BANGKA_CHECKOUT_CONFIG }) {
  return Object.freeze({
    checkout_session_id: checkoutSessionId,
    processor_entity: processorEntity,
    plan_name: config.planName,
    price_interval: "month",
    seat_quantity: 1,
    billing_details: Object.freeze({ country: config.country, currency: config.currency }),
    promo_campaign: Object.freeze({
      promo_campaign_id: config.campaignId,
      is_coupon_from_query_param: false
    }),
    checkout_ui_mode: config.checkoutUiMode
  });
}

function buildTaxesBody({ checkoutSessionId, checkoutEmail, processorEntity, currency, billing }) {
  const address = billing && billing.address || {};
  return Object.freeze({
    checkout_session_id: checkoutSessionId,
    checkout_email: String(checkoutEmail || "").trim(),
    billing_country: String(address.country || "").trim().toUpperCase(),
    billing_name: String(billing && billing.name || "").trim(),
    currency: String(currency || "").trim().toLowerCase(),
    processor_entity: processorEntity,
    billing_address: Object.freeze({
      line1: String(address.line1 || "").trim(),
      city: String(address.city || "").trim(),
      country: String(address.country || "").trim().toUpperCase(),
      postal_code: String(address.postal_code || "").trim(),
      state: String(address.state || "").trim()
    })
  });
}

function parseTaxesContext(payload, fallbackCurrency = "php") {
  const amount = extractCheckoutAmount(payload);
  if (!amount.source) {
    throw new AppError(409, "TRIAL_TAXES_AMOUNT_MISSING", "Checkout taxes did not return a verifiable amount.");
  }
  if (amount.amount !== 0) {
    throw new AppError(409, "TRIAL_CHECKOUT_NOT_ZERO", `Checkout taxes returned a non-zero amount (${amount.amount}).`);
  }
  const session = payload && payload.checkout_session && typeof payload.checkout_session === "object"
    ? payload.checkout_session
    : {};
  const customerId = String(session.customer || "").trim();
  const customerSessionClientSecret = String(session.customer_session_client_secret || "").trim();
  if (!/^cus_[A-Za-z0-9]+$/.test(customerId)) {
    throw new AppError(502, "TRIAL_STRIPE_CUSTOMER_MISSING", "Checkout taxes did not return a Stripe customer.");
  }
  if (!customerSessionClientSecret) {
    throw new AppError(502, "TRIAL_CUSTOMER_SESSION_MISSING", "Checkout taxes did not return a customer-session client secret.");
  }
  const paymentMethodTypes = Array.isArray(session.payment_method_types)
    ? session.payment_method_types.map((value) => String(value || "").trim()).filter(Boolean)
    : [];
  const customPaymentMethodCount = Array.isArray(session.custom_payment_methods)
    ? session.custom_payment_methods.filter((item) => /^cpmt_/.test(String(item && item.id || ""))).length
    : 0;
  return Object.freeze({
    amount: 0,
    amountSource: amount.source,
    currency: String(session.currency || fallbackCurrency).trim().toLowerCase(),
    customerId,
    customerSessionClientSecret,
    paymentMethodTypes: Object.freeze(paymentMethodTypes.length ? paymentMethodTypes : ["card", "link"]),
    customPaymentMethodCount
  });
}

module.exports = {
  BANGKA_CHECKOUT_CONFIG,
  CHECKOUT_TAXES_ENDPOINT,
  buildCheckoutCreateBody,
  buildCheckoutUpdateBody,
  buildTaxesBody,
  extractCheckoutAmount,
  extractCheckoutSessionId,
  extractProcessorEntity,
  extractStripePublishableKey,
  parseTaxesContext
};
