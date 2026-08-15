"use strict";

const { AppError } = require("../lib/errors");
const { parsePool, summarizeProxy, probeGateway } = require("../lib/proxy");
const REGISTRATION_PROXY_REGION = "REGISTRATION";
const LEGACY_REGISTRATION_PROXY_REGION = "JP";
const PROXY_REGIONS = Object.freeze([REGISTRATION_PROXY_REGION, "US", "TR"]);

function normalizeProxyRegion(region) {
  const normalized = String(region || "").trim().toUpperCase();
  return normalized === LEGACY_REGISTRATION_PROXY_REGION ? REGISTRATION_PROXY_REGION : normalized;
}

class ProxyPoolService {
  constructor(store) {
    this.store = store;
    this.pools = Object.fromEntries(PROXY_REGIONS.map((region) => [region, []]));
  }

  async init() {
    const stored = await this.store.read() || {};
    const hasRegistrationPool = Object.hasOwn(stored, REGISTRATION_PROXY_REGION);
    for (const region of PROXY_REGIONS) {
      const raw = region === REGISTRATION_PROXY_REGION && !hasRegistrationPool
        ? stored[LEGACY_REGISTRATION_PROXY_REGION]
        : stored[region];
      this.pools[region] = parsePool(raw || "", region);
    }
    if (!hasRegistrationPool && Object.hasOwn(stored, LEGACY_REGISTRATION_PROXY_REGION)) {
      await this.persist();
    }
    return this.summary();
  }

  async persist() {
    await this.store.write(Object.fromEntries(PROXY_REGIONS.map((region) => [
      region,
      this.pools[region].map((proxy) => proxy.raw).join("\n")
    ])));
  }

  summary() {
    const summarize = (pool) => pool.map((proxy, index) => summarizeProxy(proxy, index));
    return Object.fromEntries(PROXY_REGIONS.map((region) => [region, {
      count: this.pools[region].length,
      configured: this.pools[region].length > 0,
      proxies: summarize(this.pools[region])
    }]));
  }

  async replace(input = {}) {
    const next = Object.fromEntries(PROXY_REGIONS.map((region) => [
      region,
      region === REGISTRATION_PROXY_REGION && !Object.hasOwn(input, region) && Object.hasOwn(input, LEGACY_REGISTRATION_PROXY_REGION)
        ? parsePool(input[LEGACY_REGISTRATION_PROXY_REGION], region)
        : Object.hasOwn(input, region) ? parsePool(input[region], region) : this.pools[region]
    ]));
    this.pools = next;
    await this.persist();
    return this.summary();
  }

  requireConfigured(regions = PROXY_REGIONS) {
    const required = [...new Set((Array.isArray(regions) ? regions : [regions])
      .map(normalizeProxyRegion)
      .filter((region) => PROXY_REGIONS.includes(region)))];
    const missing = required.filter((region) => this.pools[region].length === 0);
    if (missing.length) {
      throw new AppError(409, "PROXY_POOLS_REQUIRED", `请先配置 ${missing.join("、")} 代理池`);
    }
  }

  select(region, cursor = 0) {
    const normalized = normalizeProxyRegion(region);
    const pool = this.pools[normalized];
    if (!pool || pool.length === 0) {
      throw new AppError(409, "PROXY_POOL_EMPTY", `${normalized || "指定地区"} 代理池为空`);
    }
    return pool[Math.abs(Number(cursor) || 0) % pool.length];
  }

  async probe(region, index = 0) {
    const normalized = normalizeProxyRegion(region);
    const proxy = this.select(normalized, index);
    const result = await probeGateway(proxy);
    return {
      ok: true,
      region: normalized,
      proxy: summarizeProxy(proxy, Number(index) || 0),
      ...result,
      check: "gateway_tcp"
    };
  }
}

module.exports = {
  LEGACY_REGISTRATION_PROXY_REGION,
  PROXY_REGIONS,
  REGISTRATION_PROXY_REGION,
  ProxyPoolService,
  normalizeProxyRegion
};
