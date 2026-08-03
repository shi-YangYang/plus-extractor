(function initializeCheckoutCore(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.ChatGPTCheckoutCore = api;
})(typeof globalThis === "object" ? globalThis : this, function createCheckoutCore() {
  "use strict";

  const CHECKOUT_CONFIG = Object.freeze({
    planLabel: "ChatGPT Plus",
    planName: "chatgptplusplan",
    countryCode: "PH",
    countryLabel: "Philippines",
    currency: "PHP",
    campaignId: "plus-1-month-free",
    entryPoint: "all_plans_pricing_modal",
    checkoutUiMode: "custom"
  });

  function buildCheckoutPayload() {
    return {
      entry_point: CHECKOUT_CONFIG.entryPoint,
      plan_name: CHECKOUT_CONFIG.planName,
      billing_details: {
        country: CHECKOUT_CONFIG.countryCode,
        currency: CHECKOUT_CONFIG.currency
      },
      promo_campaign: {
        promo_campaign_id: CHECKOUT_CONFIG.campaignId,
        is_coupon_from_query_param: false
      },
      checkout_ui_mode: CHECKOUT_CONFIG.checkoutUiMode
    };
  }

  function buildCheckoutUrl(sessionId) {
    if (typeof sessionId !== "string" || sessionId.trim() === "") {
      throw new TypeError("Missing checkout session id");
    }

    return `https://chatgpt.com/checkout/openai_llc/${encodeURIComponent(sessionId.trim())}`;
  }

  function parseResponseText(text) {
    if (!text) {
      return {};
    }

    try {
      return JSON.parse(text);
    } catch {
      return { detail: text.slice(0, 500) };
    }
  }

  function formatApiError(payload, status) {
    const prefix = status ? `请求失败（HTTP ${status}）` : "请求失败";

    if (!payload || typeof payload !== "object") {
      return prefix;
    }

    if (typeof payload.detail === "string" && payload.detail.trim()) {
      return `${prefix}：${payload.detail.trim()}`;
    }

    if (payload.detail && typeof payload.detail === "object") {
      return `${prefix}：${JSON.stringify(payload.detail)}`;
    }

    if (typeof payload.message === "string" && payload.message.trim()) {
      return `${prefix}：${payload.message.trim()}`;
    }

    return prefix;
  }

  return Object.freeze({
    CHECKOUT_CONFIG,
    buildCheckoutPayload,
    buildCheckoutUrl,
    parseResponseText,
    formatApiError
  });
});
