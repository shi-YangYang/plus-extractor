"use strict";

const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { AppError } = require("./errors");
const { openProxySocket } = require("./proxy-request");

const legacyCore = require(path.resolve(__dirname, "../../../chatgpt-checkout-helper/core.js"));

function parsePool(value, region) {
  const text = Array.isArray(value) ? value.join("\n") : String(value || "");
  if (!text.trim()) return [];
  try {
    return legacyCore.parseProxyPool(text);
  } catch (error) {
    throw new AppError(400, "INVALID_PROXY_POOL", `${region} proxy pool: ${error.message}`);
  }
}

function summarizeProxy(proxy, index) {
  return Object.freeze({
    index,
    scheme: proxy.scheme,
    endpoint: legacyCore.formatProxyEndpoint(proxy),
    authenticated: Boolean(proxy.username)
  });
}

async function probeGateway(proxy, timeoutMs = 5_000, options = {}) {
  const startedAt = performance.now();
  let opened;
  try {
    opened = await openProxySocket(proxy, { ...options, timeoutMs });
    return {
      reachable: true,
      latencyMs: Math.max(1, Math.round(performance.now() - startedAt)),
      route: opened.route,
      firstHop: opened.firstHop
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      502,
      "PROXY_GATEWAY_UNREACHABLE",
      `Proxy gateway connection failed: ${error.code || error.message}`
    );
  } finally {
    if (opened && opened.socket && !opened.socket.destroyed) opened.socket.destroy();
  }
}

module.exports = { legacyCore, parsePool, summarizeProxy, probeGateway };
