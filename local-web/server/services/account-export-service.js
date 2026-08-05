"use strict";

const crypto = require("node:crypto");
const { AppError } = require("../lib/errors");
const {
  CheckoutProtocolRuntime,
  normalizeAccountSession
} = require("./chatgpt-checkout-link-client");
const { createStickyProxySession } = require("./chatgpt-protocol-registration-client");

class AccountExportService {
  constructor(options = {}) {
    this.runtimeFactory = options.runtimeFactory || (() => new CheckoutProtocolRuntime(options));
    this.proxySessionId = options.proxySessionId || "";
  }

  async readAccessToken({ accountSession, proxy } = {}) {
    const session = normalizeAccountSession(accountSession);
    const sessionId = this.proxySessionId || crypto.randomBytes(4).toString("hex");
    const stickyProxy = createStickyProxySession(proxy, { sessionId });
    const runtime = this.runtimeFactory();
    try {
      await runtime.open({ accountSession: session, proxy: stickyProxy });
      await runtime.verifyExit("US");
      const authenticated = await runtime.readSession();
      const accessToken = String(authenticated && authenticated.accessToken || "").trim();
      if (!accessToken) {
        throw new AppError(401, "ACCOUNT_EXPORT_SESSION_EXPIRED", "The saved account session did not return an access token.");
      }
      return accessToken;
    } finally {
      await runtime.close().catch(() => {});
    }
  }
}

module.exports = { AccountExportService };
