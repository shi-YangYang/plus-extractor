"use strict";

const { AppError } = require("../lib/errors");

class CardBindingAdapter {
  constructor(options = {}) {
    this.cardBindingClient = options.cardBindingClient || null;
  }

  isReady() {
    return Boolean(
      this.cardBindingClient
      && typeof this.cardBindingClient.prepare === "function"
      && typeof this.cardBindingClient.complete === "function"
    );
  }

  describe() {
    const ready = this.isReady();
    return {
      key: "card_binding",
      label: "自动绑卡",
      status: ready ? "hosted_elements_ready" : "binding_client_missing",
      ready,
      proxyRegion: "US",
      cardDataTransport: "stripe_hosted_element",
      storesCardData: false
    };
  }

  requireClient() {
    if (!this.isReady()) {
      throw new AppError(503, "CARD_BINDING_CLIENT_MISSING", "The hosted card-binding client is not initialized.");
    }
    return this.cardBindingClient;
  }

  async prepare(input) {
    return this.requireClient().prepare(input);
  }

  async complete(input) {
    return this.requireClient().complete(input);
  }

  async cancel(input) {
    const client = this.requireClient();
    if (typeof client.cancel !== "function") return Object.freeze({ cancelled: false });
    return client.cancel(input);
  }

  async discard(input) {
    const client = this.cardBindingClient;
    if (!client || typeof client.discard !== "function") {
      return Object.freeze({ discarded: false });
    }
    return client.discard(input);
  }

  async execute() {
    throw new AppError(
      409,
      "CARD_BINDING_HOSTED_INPUT_REQUIRED",
      "Use the hosted card form to complete the card-binding stage."
    );
  }
}

module.exports = { CardBindingAdapter };
