"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
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
    this.sessionDirectory = options.sessionDirectory ? path.resolve(options.sessionDirectory) : null;
    this.now = options.now || (() => Date.now());
  }

  cachePathFor(taskId, accountSession = {}) {
    const explicit = String(accountSession.authSessionPath || "").trim();
    const storagePath = String(accountSession.path || "").trim();
    const derived = storagePath.toLowerCase().endsWith(".storage.json")
      ? storagePath.slice(0, -".storage.json".length) + ".auth-session.json"
      : this.sessionDirectory && taskId
        ? path.join(this.sessionDirectory, `${taskId}.auth-session.json`)
        : "";
    if (!explicit && !derived) return null;
    const candidate = path.resolve(explicit || derived);
    if (!candidate.toLowerCase().endsWith(".auth-session.json")) return null;
    if (this.sessionDirectory) {
      const relative = path.relative(this.sessionDirectory, candidate);
      if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
    }
    return candidate;
  }

  usableAuthSession(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    if (!String(value.accessToken || "").trim()) return false;
    const expiresAt = Date.parse(String(value.expires || ""));
    return !Number.isFinite(expiresAt) || expiresAt > this.now() + 30_000;
  }

  async readCachedAuthSession(taskId, accountSession) {
    const cachePath = this.cachePathFor(taskId, accountSession);
    if (!cachePath) return null;
    try {
      const stats = await fs.stat(cachePath);
      if (!stats.isFile() || stats.size < 2 || stats.size > 2 * 1024 * 1024) return null;
      const cached = JSON.parse(await fs.readFile(cachePath, "utf8"));
      return this.usableAuthSession(cached) ? cached : null;
    } catch {
      return null;
    }
  }

  async writeCachedAuthSession(taskId, accountSession, authSession) {
    const cachePath = this.cachePathFor(taskId, accountSession);
    if (!cachePath || !this.usableAuthSession(authSession)) return null;
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, JSON.stringify(authSession), { encoding: "utf8", mode: 0o600 });
    return cachePath;
  }

  async readAuthSession({ taskId, accountSession, proxy } = {}) {
    const cached = await this.readCachedAuthSession(taskId, accountSession);
    if (cached) return cached;
    const session = normalizeAccountSession(accountSession);
    const sessionId = this.proxySessionId || crypto.randomBytes(4).toString("hex");
    const stickyProxy = createStickyProxySession(proxy, { sessionId });
    const runtime = this.runtimeFactory();
    try {
      await runtime.open({ accountSession: session, proxy: stickyProxy });
      await runtime.verifyExit("US");
      const authenticated = await runtime.readSession();
      const authSession = authenticated && authenticated.session;
      const accessToken = String(authSession && authSession.accessToken || "").trim();
      if (!accessToken) {
        throw new AppError(401, "ACCOUNT_EXPORT_SESSION_EXPIRED", "The saved account session did not return a complete authenticated session JSON document.");
      }
      if (!authSession || typeof authSession !== "object" || Array.isArray(authSession)) {
        throw new AppError(502, "ACCOUNT_EXPORT_SESSION_INVALID", "The session endpoint returned an invalid JSON document.");
      }
      await this.writeCachedAuthSession(taskId, accountSession, authSession);
      return authSession;
    } finally {
      await runtime.close().catch(() => {});
    }
  }
}

module.exports = { AccountExportService };
