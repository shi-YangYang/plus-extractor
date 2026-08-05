"use strict";

const { AppError } = require("../lib/errors");

class TrialPaymentAdapter {
  constructor(options = {}) {
    this.trialPaymentClient = options.trialPaymentClient || null;
  }

  isReady() {
    return Boolean(this.trialPaymentClient && typeof this.trialPaymentClient.subscribe === "function");
  }

  describe() {
    const ready = this.isReady();
    return {
      key: "trial_payment",
      label: "US 账单与一键订阅",
      status: ready ? "protocol_ready" : "subscription_client_missing",
      ready,
      proxyRegion: "US",
      transport: "chatgpt_checkout_api_and_stripe_js",
      requiresExplicitConfirmation: true
    };
  }

  async execute(input) {
    if (!this.isReady()) {
      throw new AppError(503, "TRIAL_SUBSCRIPTION_CLIENT_MISSING", "The trial-subscription client is not initialized.");
    }
    return this.trialPaymentClient.subscribe(input);
  }
}

module.exports = { TrialPaymentAdapter };
