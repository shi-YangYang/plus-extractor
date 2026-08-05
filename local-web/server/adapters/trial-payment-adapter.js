"use strict";

const { AppError } = require("../lib/errors");

class TrialPaymentAdapter {
  constructor(options = {}) {
    this.trialPaymentClient = options.trialPaymentClient || null;
  }

  isReady() {
    return Boolean(this.trialPaymentClient && typeof this.trialPaymentClient.subscribe === "function");
  }

  supportsSynchronizedBatch() {
    return Boolean(
      this.trialPaymentClient
      && typeof this.trialPaymentClient.prepare === "function"
      && typeof this.trialPaymentClient.armPrepared === "function"
      && typeof this.trialPaymentClient.confirmPrepared === "function"
      && typeof this.trialPaymentClient.verifyPrepared === "function"
      && typeof this.trialPaymentClient.closePrepared === "function"
    );
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
      requiresExplicitConfirmation: true,
      synchronizedBatch: this.supportsSynchronizedBatch(),
      maxBatchSize: 10
    };
  }

  async execute(input) {
    if (!this.isReady()) {
      throw new AppError(503, "TRIAL_SUBSCRIPTION_CLIENT_MISSING", "The trial-subscription client is not initialized.");
    }
    return this.trialPaymentClient.subscribe(input);
  }

  async prepare(input) {
    if (!this.supportsSynchronizedBatch()) {
      throw new AppError(503, "TRIAL_SYNCHRONIZED_BATCH_UNAVAILABLE", "The synchronized subscription client is not initialized.");
    }
    return this.trialPaymentClient.prepare(input);
  }

  async arm(prepared) {
    return this.trialPaymentClient.armPrepared(prepared);
  }

  async confirm(prepared) {
    return this.trialPaymentClient.confirmPrepared(prepared);
  }

  async verify(prepared, confirmation) {
    return this.trialPaymentClient.verifyPrepared(prepared, confirmation);
  }

  async close(prepared) {
    return this.trialPaymentClient.closePrepared(prepared);
  }
}

module.exports = { TrialPaymentAdapter };
