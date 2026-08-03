const test = require("node:test");
const assert = require("node:assert/strict");

const core = require("../core.js");

test("buildCheckoutPayload returns the expected request body", () => {
  assert.deepEqual(core.buildCheckoutPayload(), {
    entry_point: "all_plans_pricing_modal",
    plan_name: "chatgptplusplan",
    billing_details: {
      country: "PH",
      currency: "PHP"
    },
    promo_campaign: {
      promo_campaign_id: "plus-1-month-free",
      is_coupon_from_query_param: false
    },
    checkout_ui_mode: "custom"
  });
});

test("buildCheckoutPayload returns a fresh nested object", () => {
  const first = core.buildCheckoutPayload();
  first.billing_details.country = "XX";

  assert.equal(core.buildCheckoutPayload().billing_details.country, "PH");
});

test("buildCheckoutUrl validates and encodes the session id", () => {
  assert.equal(
    core.buildCheckoutUrl(" session/123 "),
    "https://chatgpt.com/checkout/openai_llc/session%2F123"
  );
  assert.throws(() => core.buildCheckoutUrl(""), /Missing checkout session id/);
});

test("parseResponseText handles JSON, text and empty responses", () => {
  assert.deepEqual(core.parseResponseText('{"ok":true}'), { ok: true });
  assert.deepEqual(core.parseResponseText("gateway unavailable"), {
    detail: "gateway unavailable"
  });
  assert.deepEqual(core.parseResponseText(""), {});
});

test("formatApiError supports string and structured details", () => {
  assert.equal(
    core.formatApiError({ detail: "Not eligible" }, 403),
    "请求失败（HTTP 403）：Not eligible"
  );
  assert.equal(
    core.formatApiError({ detail: { code: "invalid" } }, 400),
    '请求失败（HTTP 400）：{"code":"invalid"}'
  );
});
