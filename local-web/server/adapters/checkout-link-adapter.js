"use strict";

const path = require("node:path");
const { AppError } = require("../lib/errors");

const core = require(path.resolve(__dirname, "../../../chatgpt-checkout-helper/core.js"));

class CheckoutLinkAdapter {
  constructor(options = {}) {
    this.checkoutClient = options.checkoutClient || null;
  }

  describe() {
    return {
      key: "checkout_link",
      label: "自动提取结账链接",
      status: this.checkoutClient ? "ready" : "client_missing",
      ready: Boolean(this.checkoutClient),
      migrationPending: false,
      proxyRegion: "US_TO_TR",
      capabilities: {
        savedSessionValidation: true,
        proxyRegionVerification: true,
        promotionApplication: true,
        publicCheckoutLink: true
      }
    };
  }

  templates() {
    return {
      baseline: core.buildBaselineCheckoutPayload(),
      promotion: core.buildPromotionUpdatePayload({
        checkoutSessionId: "oaics_PLACEHOLDER_SESSION",
        processorEntity: "openai_llc",
        campaignId: core.CHECKOUT_CONFIG.campaignId
      })
    };
  }

  async execute(context = {}) {
    if (!context.accountSession) {
      throw new AppError(409, "ACCOUNT_SESSION_REQUIRED", "提链阶段需要注册阶段保存的登录会话。");
    }
    if (!this.checkoutClient) {
      throw new AppError(503, "CHECKOUT_CLIENT_MISSING", "本地提链客户端尚未初始化。");
    }
    return this.checkoutClient.extract({
      taskId: context.taskId,
      accountSession: context.accountSession,
      proxies: context.proxies,
      proxySessionId: context.proxySessionId,
      checkoutSeed: context.checkoutSeed,
      reportProgress: context.reportProgress
    });
  }
}

module.exports = { CheckoutLinkAdapter };
