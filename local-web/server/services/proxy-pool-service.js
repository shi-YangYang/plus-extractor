"use strict";

const { AppError } = require("../lib/errors");
const { parsePool, summarizeProxy, probeGateway } = require("../lib/proxy");

class ProxyPoolService {
  constructor(store) {
    this.store = store;
    this.pools = { US: [], TR: [] };
  }

  async init() {
    const stored = await this.store.read();
    this.pools.US = parsePool(stored.US || "", "US");
    this.pools.TR = parsePool(stored.TR || "", "TR");
    return this.summary();
  }

  summary() {
    const summarize = (pool) => pool.map((proxy, index) => summarizeProxy(proxy, index));
    return {
      US: { count: this.pools.US.length, configured: this.pools.US.length > 0, proxies: summarize(this.pools.US) },
      TR: { count: this.pools.TR.length, configured: this.pools.TR.length > 0, proxies: summarize(this.pools.TR) }
    };
  }

  async replace(input = {}) {
    const next = {
      US: parsePool(input.US, "US"),
      TR: parsePool(input.TR, "TR")
    };
    this.pools = next;
    await this.store.write({
      US: next.US.map((proxy) => proxy.raw).join("\n"),
      TR: next.TR.map((proxy) => proxy.raw).join("\n")
    });
    return this.summary();
  }

  requireConfigured() {
    const missing = ["US", "TR"].filter((region) => this.pools[region].length === 0);
    if (missing.length) {
      throw new AppError(409, "PROXY_POOLS_REQUIRED", `请先配置 ${missing.join("、")} 代理池`);
    }
  }

  select(region, cursor = 0) {
    const normalized = String(region || "").toUpperCase();
    const pool = this.pools[normalized];
    if (!pool || pool.length === 0) {
      throw new AppError(409, "PROXY_POOL_EMPTY", `${normalized || "指定地区"} 代理池为空`);
    }
    return pool[Math.abs(Number(cursor) || 0) % pool.length];
  }

  async probe(region, index = 0) {
    const normalized = String(region || "").toUpperCase();
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

module.exports = { ProxyPoolService };
