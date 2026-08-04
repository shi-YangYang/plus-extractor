const test = require("node:test");
const assert = require("node:assert/strict");

function createEvent() {
  return {
    listener: null,
    addListener(listener) {
      this.listener = listener;
    }
  };
}

function loadBackgroundHarness() {
  const storage = {};
  const scriptingCalls = [];
  const originalFetch = global.fetch;
  const proxyState = { value: { mode: "system" }, levelOfControl: "controllable_by_this_extension" };
  const events = {
    onMessage: createEvent(),
    onInstalled: createEvent(),
    onAuthRequired: createEvent(),
    onCompleted: createEvent(),
    onErrorOccurred: createEvent(),
    onProxyError: createEvent()
  };

  global.ChatGPTCheckoutCore = require("../core.js");
  global.fetch = async (input) => {
    if (String(input).startsWith("http://127.0.0.1:17898/")) {
      throw new TypeError("Failed to fetch");
    }
    return new Response("ok", { status: 200 });
  };
  global.chrome = {
    runtime: {
      lastError: null,
      onMessage: events.onMessage,
      onInstalled: events.onInstalled
    },
    storage: {
      session: {
        async get(key) {
          return { [key]: storage[key] };
        },
        async set(values) {
          Object.assign(storage, values);
        },
        async remove(key) {
          for (const candidate of Array.isArray(key) ? key : [key]) {
            delete storage[candidate];
          }
        }
      }
    },
    scripting: {
      async executeScript(details) {
        scriptingCalls.push(details);
        return [{ result: { token: "SENTINEL_TEST_TOKEN", telemetry: "[1,42]" } }];
      }
    },
    proxy: {
      onProxyError: events.onProxyError,
      settings: {
        async set(details) {
          proxyState.value = details.value;
        },
        async clear() {
          proxyState.value = { mode: "system" };
        },
        async get() {
          return proxyState;
        }
      }
    },
    webRequest: {
      onAuthRequired: events.onAuthRequired,
      onCompleted: events.onCompleted,
      onErrorOccurred: events.onErrorOccurred
    }
  };

  delete require.cache[require.resolve("../background.js")];
  require("../background.js");

  async function send(message) {
    return new Promise((resolve) => {
      const keepChannelOpen = events.onMessage.listener(
        message,
        { url: "https://chatgpt.com/", tab: { id: 77 } },
        resolve
      );
      assert.equal(keepChannelOpen, true);
    });
  }

  return {
    events,
    proxyState,
    send,
    scriptingCalls,
    storage,
    setFetch(handler) {
      global.fetch = handler;
    },
    restore() {
      global.fetch = originalFetch;
      delete global.chrome;
      delete global.ChatGPTCheckoutCore;
    }
  };
}

test("background applies, reports and clears a phase proxy", async (t) => {
  const harness = loadBackgroundHarness();
  t.after(() => harness.restore());

  const applied = await harness.send({
    type: "checkout-helper:set-proxy",
    phase: "create",
    proxy: "user:pass@proxy.example:1000"
  });
  assert.deepEqual(applied, {
    ok: true,
    active: true,
    phase: "create",
    endpoint: "http://proxy.example:1000",
    transport: "direct",
    relay: null,
    activatedAt: applied.activatedAt
  });
  assert.equal(harness.proxyState.value.mode, "fixed_servers");
  assert.deepEqual(harness.proxyState.value.rules.singleProxy, {
    scheme: "http",
    host: "proxy.example",
    port: 1000
  });

  const status = await harness.send({ type: "checkout-helper:get-proxy-status" });
  assert.equal(status.active, true);
  assert.equal(status.phase, "create");
  assert.equal(status.endpoint, "http://proxy.example:1000");

  const cleared = await harness.send({ type: "checkout-helper:clear-proxy" });
  assert.deepEqual(cleared, { ok: true, active: false });
  assert.equal(harness.proxyState.value.mode, "system");
});

test("background acquires official checkout Sentinel headers in the ChatGPT main world", async (t) => {
  const harness = loadBackgroundHarness();
  t.after(() => harness.restore());

  const result = await harness.send({ type: "checkout-helper:get-sentinel-headers" });
  assert.deepEqual(result, {
    ok: true,
    headers: {
      "OpenAI-Sentinel-Token": "SENTINEL_TEST_TOKEN",
      "OAI-Telemetry": "[1,42]"
    },
    headerNames: ["OpenAI-Sentinel-Token", "OAI-Telemetry"],
    flow: "chatgpt_checkout"
  });
  assert.equal(harness.scriptingCalls.length, 1);
  assert.deepEqual(harness.scriptingCalls[0].target, { tabId: 77 });
  assert.equal(harness.scriptingCalls[0].world, "MAIN");
  assert.deepEqual(harness.scriptingCalls[0].args.slice(0, 2), [
    "chatgpt_checkout",
    "https://chatgpt.com/backend-api/sentinel/sdk.js"
  ]);
});

test("background supplies credentials when the proxy challenger uses a resolved host", async (t) => {
  const harness = loadBackgroundHarness();
  t.after(() => harness.restore());
  await harness.send({
    type: "checkout-helper:set-proxy",
    phase: "apply",
    proxy: "user:pass@proxy.example:1000"
  });

  const credentials = await new Promise((resolve) => {
    harness.events.onAuthRequired.listener({
      requestId: "request-1",
      isProxy: true,
      challenger: { host: "proxy.example", port: 1000 }
    }, resolve);
  });
  assert.deepEqual(credentials, {
    authCredentials: { username: "user", password: "pass" }
  });

  const resolvedHostCredentials = await new Promise((resolve) => {
    harness.events.onAuthRequired.listener({
      requestId: "request-2",
      isProxy: true,
      challenger: { host: "192.0.2.10", port: 1000 }
    }, resolve);
  });
  assert.deepEqual(resolvedHostCredentials, {
    authCredentials: { username: "user", password: "pass" }
  });
});

test("background preflight reports Chrome proxy network errors", async (t) => {
  const harness = loadBackgroundHarness();
  t.after(() => harness.restore());
  await harness.send({
    type: "checkout-helper:set-proxy",
    phase: "create",
    proxy: "user:pass@proxy.example:1000"
  });

  harness.setFetch(async () => {
    harness.events.onErrorOccurred.listener({
      requestId: "preflight-request",
      url: "https://chatgpt.com/cdn-cgi/trace",
      error: "net::ERR_CONNECTION_TIMED_OUT"
    });
    throw new TypeError("Failed to fetch");
  });

  const result = await harness.send({ type: "checkout-helper:test-proxy" });
  assert.equal(result.ok, false);
  assert.match(result.error, /代理网关连接超时/);
  assert.match(result.error, /ERR_CONNECTION_TIMED_OUT/);
});

test("background preflight accepts any HTTP response reached through the proxy", async (t) => {
  const harness = loadBackgroundHarness();
  t.after(() => harness.restore());
  await harness.send({
    type: "checkout-helper:set-proxy",
    phase: "apply",
    proxy: "user:pass@proxy.example:1000"
  });
  harness.setFetch(async () => new Response("forbidden", { status: 403 }));

  const result = await harness.send({ type: "checkout-helper:test-proxy" });
  assert.equal(result.ok, true);
  assert.equal(result.reachable, true);
  assert.equal(result.httpStatus, 403);
  assert.equal(result.phase, "apply");
});

test("background probes exit IP outside the page CSP and parses Cloudflare trace", async (t) => {
  const harness = loadBackgroundHarness();
  t.after(() => harness.restore());
  const requested = [];
  harness.setFetch(async (input) => {
    requested.push(String(input));
    return new Response("ip=198.51.100.10\nloc=US\ncolo=SJC\n", { status: 200 });
  });

  const result = await harness.send({
    type: "checkout-helper:trace-exit",
    probe: "baseline"
  });

  assert.match(requested[0], /^https:\/\/1\.1\.1\.1\/cdn-cgi\/trace\?_=/);
  assert.deepEqual(result, {
    ok: true,
    probe: "baseline",
    exitIp: "198.51.100.10",
    country: "US",
    colo: "SJC",
    httpStatus: 200
  });
});

test("background routes Chrome through the local Mihomo chain relay when available", async (t) => {
  const harness = loadBackgroundHarness();
  t.after(() => harness.restore());
  const relayRequests = [];
  harness.setFetch(async (input, options = {}) => {
    const url = String(input);
    if (url.endsWith("/status")) {
      return new Response(JSON.stringify({
        ok: true,
        ready: true,
        proxyHost: "127.0.0.1",
        proxyPort: 17897
      }), { status: 200 });
    }
    if (url.endsWith("/configure")) {
      relayRequests.push(JSON.parse(options.body));
      return new Response(JSON.stringify({
        ok: true,
        configured: true,
        phase: "create",
        endpoint: "http://proxy.example:1000",
        proxyHost: "127.0.0.1",
        proxyPort: 17897
      }), { status: 200 });
    }
    if (url.endsWith("/clear")) {
      return new Response(JSON.stringify({ ok: true, configured: false }), { status: 200 });
    }
    return new Response("ok", { status: 200 });
  });

  const applied = await harness.send({
    type: "checkout-helper:set-proxy",
    phase: "create",
    proxy: "user:pass@proxy.example:1000"
  });
  assert.equal(applied.transport, "relay");
  assert.equal(applied.relay, "127.0.0.1:17897");
  assert.deepEqual(relayRequests, [{
    phase: "create",
    proxy: "user:pass@proxy.example:1000"
  }]);
  assert.deepEqual(harness.proxyState.value.rules.singleProxy, {
    scheme: "http",
    host: "127.0.0.1",
    port: 17897
  });

  const ignoredAuth = await new Promise((resolve) => {
    harness.events.onAuthRequired.listener({
      requestId: "relay-request",
      isProxy: true,
      challenger: { host: "127.0.0.1", port: 17897 }
    }, resolve);
  });
  assert.deepEqual(ignoredAuth, {});
});

test("background initializes a Stripe hosted payment page from a Checkout Session", async (t) => {
  const harness = loadBackgroundHarness();
  t.after(() => harness.restore());
  let request = null;
  harness.setFetch(async (input, options = {}) => {
    request = { url: String(input), options };
    return new Response(JSON.stringify({
      stripe_hosted_url: "https://checkout.stripe.com/c/pay/cs_test_fixture123#hosted"
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  });

  const result = await harness.send({
    type: "checkout-helper:stripe-init",
    sessionId: "cs_test_fixture123",
    publishableKey: "pk_test_fixture123",
    locale: "en"
  });

  assert.deepEqual(result, {
    ok: true,
    hostedUrl: "https://checkout.stripe.com/c/pay/cs_test_fixture123#hosted",
    httpStatus: 200,
    source: "stripe-init"
  });
  assert.equal(request.url, "https://api.stripe.com/v1/payment_pages/cs_test_fixture123/init");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers.Authorization, "Bearer pk_test_fixture123");
  assert.match(request.options.body, /key=pk_test_fixture123/);
  assert.match(request.options.body, /elements_session_client/);
});

test("background records only sanitized checkout diagnostics through the local relay", async (t) => {
  const harness = loadBackgroundHarness();
  t.after(() => harness.restore());
  let diagnosticRequest = null;
  harness.setFetch(async (input, options = {}) => {
    diagnosticRequest = { url: String(input), body: JSON.parse(options.body) };
    return new Response(JSON.stringify({
      ok: true,
      recorded: true,
      event: "checkout_response"
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  });

  const result = await harness.send({
    type: "checkout-helper:record-diagnostic",
    event: "checkout_response",
    details: {
      shape: "data:object(checkoutSessionId|publishableKey)",
      requestShape: "plan_name,billing_details,promo_campaign",
      message: "Bearer fixture-token",
      raw: { checkout_session_id: "cs_live_private" }
    }
  });

  assert.equal(result.recorded, true);
  assert.equal(diagnosticRequest.url, "http://127.0.0.1:17898/diagnostic");
  assert.deepEqual(diagnosticRequest.body, {
    event: "checkout_response",
    details: {
      shape: "data:object(checkoutSessionId|publishableKey)",
      requestShape: "plan_name,billing_details,promo_campaign",
      message: "Bearer [已脱敏]"
    }
  });
});
