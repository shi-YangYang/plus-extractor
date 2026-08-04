const test = require("node:test");
const assert = require("node:assert/strict");

class FakeClassList {
  constructor(node) {
    this.node = node;
  }

  add(name) {
    const names = new Set(this.node.className.split(/\s+/).filter(Boolean));
    names.add(name);
    this.node.className = [...names].join(" ");
  }

  remove(name) {
    this.node.className = this.node.className
      .split(/\s+/)
      .filter((candidate) => candidate && candidate !== name)
      .join(" ");
  }
}

class FakeNode {
  constructor(tagName = "div") {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.className = "";
    this.classList = new FakeClassList(this);
    this.textContent = "";
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = "";
    this.style = {};
  }

  append(...nodes) {
    for (const node of nodes) {
      node.parentNode = this;
      this.children.push(node);
    }
  }

  attachShadow() {
    this.shadowRoot = new FakeNode("shadow-root");
    return this.shadowRoot;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  addEventListener(type, listener) {
    this.listeners[type] = listener;
  }

  querySelector(selector) {
    const matcher = selector.startsWith(".")
      ? (node) => node.className.split(/\s+/).includes(selector.slice(1))
      : (node) => node.tagName.toLowerCase() === selector.toLowerCase();
    const queue = [...this.children];
    while (queue.length) {
      const node = queue.shift();
      if (matcher(node)) return node;
      queue.push(...node.children);
    }
    return null;
  }

  focus() {}
}

function collect(root, predicate) {
  const output = [];
  const queue = [root];
  while (queue.length) {
    const node = queue.shift();
    if (predicate(node)) output.push(node);
    queue.push(...node.children);
  }
  return output;
}

test("content script mounts the two proxy pools and keeps submit disabled initially", (t) => {
  const html = new FakeNode("html");
  global.ChatGPTCheckoutCore = require("../core.js");
  global.document = {
    documentElement: html,
    createElement: (tagName) => new FakeNode(tagName),
    getElementById: () => null,
    addEventListener: () => undefined
  };
  global.window = {
    open: () => undefined,
    location: { assign: () => undefined }
  };
  global.fetch = async () => new Response(JSON.stringify({ accessToken: "TEST_ACCESS_TOKEN" }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });

  t.after(() => {
    delete global.document;
    delete global.window;
    delete global.fetch;
    delete global.ChatGPTCheckoutCore;
  });

  delete require.cache[require.resolve("../content.js")];
  require("../content.js");

  assert.equal(html.children.length, 1);
  const host = html.children[0];
  assert.equal(host.id, "chatgpt-checkout-helper-root");
  assert.ok(host.shadowRoot);

  const panelStyles = collect(host.shadowRoot, (node) => node.tagName === "STYLE")[0];
  assert.match(panelStyles.textContent, /max-width:\s*760px/);

  const textareas = collect(host.shadowRoot, (node) => node.tagName === "TEXTAREA");
  assert.equal(textareas.length, 2);
  assert.deepEqual(textareas.map((node) => node.id), [
    "checkout-helper-proxy-create",
    "checkout-helper-proxy-apply"
  ]);

  const submit = collect(host.shadowRoot, (node) => node.tagName === "BUTTON")
    .find((node) => node.textContent === "开始提取");
  const manualUsProxy = collect(host.shadowRoot, (node) => node.tagName === "BUTTON")
    .find((node) => node.textContent === "当前页面使用 US 代理");
  assert.ok(submit);
  assert.ok(manualUsProxy);
  assert.equal(manualUsProxy.disabled, true);
  assert.equal(submit.disabled, true);
});

test("content script manually applies a US proxy from pool 1 to the current page", async (t) => {
  const html = new FakeNode("html");
  const runtimeMessages = [];
  const nativeSetTimeout = global.setTimeout;

  global.ChatGPTCheckoutCore = require("../core.js");
  global.document = {
    documentElement: html,
    createElement: (tagName) => new FakeNode(tagName),
    getElementById: () => null,
    addEventListener: () => undefined
  };
  global.window = {
    open: () => undefined,
    location: { assign: () => undefined }
  };
  global.chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        runtimeMessages.push(message);
        if (message.type === "checkout-helper:set-proxy") {
          const proxy = global.ChatGPTCheckoutCore.parseProxyLine(message.proxy);
          callback({
            ok: true,
            active: true,
            phase: message.phase,
            endpoint: global.ChatGPTCheckoutCore.formatProxyEndpoint(proxy),
            transport: "direct"
          });
          return;
        }
        if (message.type === "checkout-helper:trace-exit") {
          callback({
            ok: true,
            probe: "baseline",
            exitIp: "198.51.100.10",
            country: "CN",
            colo: "HKG"
          });
          return;
        }
        if (message.type === "checkout-helper:test-proxy") {
          callback({
            ok: true,
            reachable: true,
            active: true,
            exitIp: "203.0.113.20",
            country: "US",
            colo: "SJC"
          });
          return;
        }
        callback({ ok: true, active: false });
      }
    }
  };
  global.setTimeout = (callback, delay, ...args) => (
    delay < 1000 ? nativeSetTimeout(callback, 0, ...args) : nativeSetTimeout(callback, delay, ...args)
  );

  t.after(() => {
    global.setTimeout = nativeSetTimeout;
    delete global.document;
    delete global.window;
    delete global.chrome;
    delete global.ChatGPTCheckoutCore;
  });

  delete require.cache[require.resolve("../content.js")];
  require("../content.js");

  const nodes = collect(html.children[0].shadowRoot, () => true);
  const createProxyInput = nodes.find((node) => node.id === "checkout-helper-proxy-create");
  const manualUsProxy = nodes.find((node) => node.tagName === "BUTTON" && node.textContent === "当前页面使用 US 代理");
  const status = nodes.find((node) => node.className === "status");

  createProxyInput.value = "us-user:us-pass@us.example:1000";
  createProxyInput.listeners.input();
  assert.equal(manualUsProxy.disabled, false);

  manualUsProxy.listeners.click();
  for (let index = 0; index < 10 && !status.textContent.includes("US 代理已启用"); index += 1) {
    await new Promise((resolve) => nativeSetTimeout(resolve, 5));
  }

  assert.deepEqual(
    runtimeMessages
      .filter((message) => ["checkout-helper:trace-exit", "checkout-helper:set-proxy", "checkout-helper:test-proxy"].includes(message.type))
      .map((message) => message.type === "checkout-helper:set-proxy" ? `set:${message.phase}` : message.type),
    ["checkout-helper:trace-exit", "set:create", "checkout-helper:test-proxy"]
  );
  assert.equal(runtimeMessages.find((message) => message.type === "checkout-helper:set-proxy").proxy, "us-user:us-pass@us.example:1000");
  assert.match(status.textContent, /US 代理已启用/);
  assert.match(status.textContent, /198\.51\.100\.10 → 203\.0\.113\.20/);
});

test("content script creates a US baseline, applies the promotion through TR, and opens only oaics", async (t) => {
  const html = new FakeNode("html");
  const runtimeMessages = [];
  const requestPaths = [];
  const checkoutPayloads = [];
  const checkoutUpdatePayloads = [];
  const checkoutHeaders = [];
  let checkoutRequestCount = 0;
  let assignedUrl = null;
  const nativeSetTimeout = global.setTimeout;

  global.ChatGPTCheckoutCore = require("../core.js");
  global.document = {
    documentElement: html,
    createElement: (tagName) => new FakeNode(tagName),
    getElementById: () => null,
    addEventListener: () => undefined
  };
  global.window = {
    open: () => undefined,
    location: { assign: (url) => { assignedUrl = url; } }
  };
  global.chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        runtimeMessages.push(message);
        if (message.type === "checkout-helper:get-proxy-status") {
          callback({ ok: true, active: false });
          return;
        }
        if (message.type === "checkout-helper:set-proxy") {
          const proxy = global.ChatGPTCheckoutCore.parseProxyLine(message.proxy);
          callback({
            ok: true,
            active: true,
            phase: message.phase,
            endpoint: global.ChatGPTCheckoutCore.formatProxyEndpoint(proxy),
            transport: "relay",
            relay: "127.0.0.1:17897"
          });
          return;
        }
        if (message.type === "checkout-helper:test-proxy") {
          callback({ ok: true, reachable: true, active: true });
          return;
        }
        if (message.type === "checkout-helper:get-sentinel-headers") {
          callback({
            ok: true,
            headers: {
              "OpenAI-Sentinel-Token": "SENTINEL_TEST_TOKEN",
              "OAI-Telemetry": "[1,42]"
            },
            headerNames: ["OpenAI-Sentinel-Token", "OAI-Telemetry"],
            flow: "chatgpt_checkout"
          });
          return;
        }
        if (message.type === "checkout-helper:stripe-init") {
          callback({
            ok: true,
            hostedUrl: "https://checkout.stripe.com/c/pay/cs_test_fixture123#hosted",
            httpStatus: 200,
            source: "stripe-init"
          });
          return;
        }
        callback({ ok: true, active: false });
      }
    }
  };
  global.fetch = async (input, options = {}) => {
    const url = new URL(input, "https://chatgpt.com");
    requestPaths.push(url.pathname);
    if (url.pathname === "/backend-api/payments/checkout") {
      checkoutPayloads.push(JSON.parse(options.body));
      checkoutHeaders.push(options.headers);
      checkoutRequestCount += 1;
    } else if (url.pathname === "/backend-api/payments/checkout/update") {
      checkoutUpdatePayloads.push(JSON.parse(options.body));
    }
    let body = { accessToken: "TEST_ACCESS_TOKEN", account: { id: "account-fixture" } };
    if (url.pathname === "/backend-api/payments/checkout") {
      body = {
        tag: "custom_checkout_session",
        checkout_session_id: "oaics_de70069a4d164634a4868109425dbf82",
        processor_entity: "openai_llc",
        checkout_state: {
          discountAmounts: [],
          total: { discount: { minorUnitsAmount: 0 }, total: { minorUnitsAmount: 98214 } }
        }
      };
    } else if (url.pathname === "/backend-api/payments/checkout/update") {
      body = {
        checkout_session: {
          id: "oaics_de70069a4d164634a4868109425dbf82",
          processor_entity: "openai_llc",
          promo_campaign: { promo_campaign_id: "plus-1-month-50-pct-off" },
          checkout_state: {
            discountAmounts: [{ percentOff: 50, minorUnitsAmount: 49107 }],
            total: { discount: { minorUnitsAmount: 49107 }, total: { minorUnitsAmount: 49107 } }
          }
        }
      };
    } else if (url.pathname === "/backend-api/accounts/check/v4-2023-04-27") {
      body = {
        account_ordering: ["account-fixture"],
        accounts: {
          "account-fixture": {
            account: {
              account_id: "account-fixture",
              plan_type: "free",
              has_previously_paid_subscription: false
            },
            entitlement: { has_active_subscription: false, billing_currency: "PHP" },
            eligible_promo_campaigns: { plus: { id: "plus-1-month-50-pct-off" } }
          }
        }
      };
    } else if (url.pathname === "/backend-api/payments/payment_methods") {
      body = { one_click_trial_eligible: true, payment_methods: [{ id: "pm_fixture", type: "card" }] };
    } else if (url.pathname.endsWith("/promo_campaign/check_coupon")) {
      body = {
        coupon: url.searchParams.get("coupon"),
        state: url.searchParams.get("coupon") === "plus-1-month-50-pct-off" ? "eligible" : "not_eligible",
        redemption: null
      };
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  global.setTimeout = (callback, delay, ...args) => (
    delay < 1000 ? nativeSetTimeout(callback, 0, ...args) : nativeSetTimeout(callback, delay, ...args)
  );

  t.after(() => {
    global.setTimeout = nativeSetTimeout;
    delete global.document;
    delete global.window;
    delete global.chrome;
    delete global.fetch;
    delete global.ChatGPTCheckoutCore;
  });

  delete require.cache[require.resolve("../content.js")];
  require("../content.js");
  const nodes = collect(html.children[0].shadowRoot, () => true);
  const launcher = nodes.find((node) => node.tagName === "BUTTON" && node.attributes["aria-haspopup"] === "dialog");
  const textareas = nodes.filter((node) => node.tagName === "TEXTAREA");
  const checkboxes = nodes.filter((node) => node.tagName === "INPUT" && node.type === "checkbox");
  const submit = nodes.find((node) => node.tagName === "BUTTON" && node.textContent === "开始提取");

  launcher.listeners.click();
  await new Promise((resolve) => nativeSetTimeout(resolve, 0));
  textareas[0].value = "create-user:create-pass@create.example:1000";
  textareas[0].listeners.input();
  textareas[1].value = "apply-user:apply-pass@apply.example:2000";
  textareas[1].listeners.input();
  checkboxes[1].checked = true;
  checkboxes[1].listeners.change();
  assert.equal(submit.disabled, false);

  submit.listeners.click();
  for (let index = 0; index < 20 && !assignedUrl; index += 1) {
    await new Promise((resolve) => nativeSetTimeout(resolve, 5));
  }

  assert.deepEqual(
    runtimeMessages.filter((message) => message.type === "checkout-helper:set-proxy")
      .map((message) => message.phase),
    ["create", "apply"]
  );
  assert.deepEqual(
    runtimeMessages
      .filter((message) => ["checkout-helper:set-proxy", "checkout-helper:test-proxy", "checkout-helper:stripe-init"].includes(message.type))
      .map((message) => message.type === "checkout-helper:set-proxy" ? `set:${message.phase}` : (message.type === "checkout-helper:stripe-init" ? "stripe-init" : "test")),
    ["set:create", "test", "set:apply", "test"]
  );
  assert.deepEqual(requestPaths.slice(-5), [
    "/backend-api/payments/checkout",
    "/api/auth/session",
    "/backend-api/accounts/check/v4-2023-04-27",
    "/backend-api/payments/payment_methods",
    "/backend-api/payments/checkout/update"
  ]);
  assert.deepEqual(checkoutPayloads, [global.ChatGPTCheckoutCore.buildBaselineCheckoutPayload()]);
  assert.deepEqual(checkoutUpdatePayloads, [global.ChatGPTCheckoutCore.buildPromotionUpdatePayload({
    checkoutSessionId: "oaics_de70069a4d164634a4868109425dbf82",
    processorEntity: "openai_llc",
    campaignId: "plus-1-month-50-pct-off"
  })]);
  assert.equal("promo_campaign" in checkoutPayloads[0], false);
  assert.equal(checkoutUpdatePayloads[0].promo_campaign.promo_campaign_id, "plus-1-month-50-pct-off");
  assert.equal(runtimeMessages.some((message) => message.type === "checkout-helper:get-sentinel-headers"), false);
  assert.equal(assignedUrl, "https://chatgpt.com/checkout/openai_llc/oaics_de70069a4d164634a4868109425dbf82");
});

test("content script restores and saves proxy pools with chrome.storage.local", async (t) => {
  const html = new FakeNode("html");
  const writes = [];
  const cache = {
    plusExtractorProxyPoolsV1: {
      create: "cached-us:pass-US@us.example:1000",
      apply: "cached-tr:pass-TR@tr.example:1000"
    }
  };

  global.ChatGPTCheckoutCore = require("../core.js");
  global.document = {
    documentElement: html,
    createElement: (tagName) => new FakeNode(tagName),
    getElementById: () => null,
    addEventListener: () => undefined
  };
  global.window = {
    open: () => undefined,
    location: { assign: () => undefined }
  };
  global.chrome = {
    runtime: { lastError: null },
    storage: {
      local: {
        get(key, callback) {
          callback({ [key]: cache[key] });
        },
        set(items, callback) {
          writes.push(items);
          Object.assign(cache, items);
          callback();
        }
      }
    }
  };

  t.after(() => {
    delete global.document;
    delete global.window;
    delete global.chrome;
    delete global.ChatGPTCheckoutCore;
  });

  delete require.cache[require.resolve("../content.js")];
  require("../content.js");
  await Promise.resolve();
  await Promise.resolve();

  const textareas = collect(html.children[0].shadowRoot, (node) => node.tagName === "TEXTAREA");
  assert.deepEqual(textareas.map((node) => node.value), [
    "cached-us:pass-US@us.example:1000",
    "cached-tr:pass-TR@tr.example:1000"
  ]);

  textareas[0].value = "new-us:pass-US@new-us.example:1000";
  textareas[0].listeners.input();
  textareas[1].value = "new-tr:pass-TR@new-tr.example:1000";
  textareas[1].listeners.input();
  await new Promise((resolve) => setTimeout(resolve, 320));

  assert.deepEqual(writes.at(-1), {
    plusExtractorProxyPoolsV1: {
      create: "new-us:pass-US@new-us.example:1000",
      apply: "new-tr:pass-TR@new-tr.example:1000"
    }
  });
});
