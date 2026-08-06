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
    cancel_url: "https://chatgpt.com/?promo_campaign=plus-1-month-free#pricing",
    promo_campaign: {
      promo_campaign_id: "plus-1-month-free",
      is_coupon_from_query_param: false
    },
    one_click_trial: true,
    checkout_ui_mode: "custom",
    locale: "zh-CN"
  });
});

test("checkout payload builders separate the US baseline from the TR promotion", () => {
  const baseline = core.buildBaselineCheckoutPayload();
  const promotion = core.buildPromotionCheckoutPayload({ oneClickTrial: true });
  assert.equal(baseline.entry_point, "all_plans_pricing_modal");
  assert.deepEqual(baseline.billing_details, { country: "US", currency: "USD" });
  assert.equal("promo_campaign" in baseline, false);
  assert.equal("one_click_trial" in baseline, false);
  assert.equal(promotion.promo_campaign.promo_campaign_id, "plus-1-month-free");
  assert.equal(promotion.one_click_trial, true);
  assert.deepEqual(promotion.billing_details, { country: "TR", currency: "USD" });
});

test("promotion payload accepts the campaign selected from account status", () => {
  const promotion = core.buildPromotionCheckoutPayload({
    campaignId: "plus-1-month-50-pct-off",
    oneClickTrial: false
  });
  assert.equal(promotion.promo_campaign.promo_campaign_id, "plus-1-month-50-pct-off");
  assert.equal(promotion.one_click_trial, false);
  assert.match(promotion.cancel_url, /promo_campaign=plus-1-month-50-pct-off/);
});

test("short promotion payload matches the TR request country", () => {
  assert.deepEqual(core.buildShortPromotionPayload({ campaignId: "plus-1-month-free" }), {
    entry_point: "all_plans_pricing_modal",
    plan_name: "chatgptplusplan",
    billing_details: { country: "TR", currency: "USD" },
    promo_campaign: {
      promo_campaign_id: "plus-1-month-free",
      is_coupon_from_query_param: false
    }
  });
});

test("promotion update payload applies the campaign to an existing OAICS session", () => {
  assert.deepEqual(core.buildPromotionUpdatePayload({
    checkoutSessionId: "oaics_de70069a4d164634a4868109425dbf82",
    processorEntity: "openai_llc",
    campaignId: "plus-1-month-free"
  }), {
    checkout_session_id: "oaics_de70069a4d164634a4868109425dbf82",
    processor_entity: "openai_llc",
    plan_name: "chatgptplusplan",
    price_interval: "month",
    seat_quantity: 1,
    promo_campaign: {
      promo_campaign_id: "plus-1-month-free",
      is_coupon_from_query_param: false
    }
  });
  assert.throws(() => core.buildPromotionUpdatePayload({
    checkoutSessionId: "cs_live_fixture",
    processorEntity: "openai_llc"
  }), /oaics/);
});

test("account promotion context follows account ordering and exposes only safe eligibility fields", () => {
  const context = core.resolveAccountPromotionContext({
    account_ordering: ["account-fixture"],
    accounts: {
      "account-fixture": {
        account: {
          account_id: "account-fixture",
          plan_type: "free",
          has_previously_paid_subscription: false,
          processor: { a001: { has_customer_object: true } }
        },
        entitlement: {
          has_active_subscription: false,
          billing_currency: "PHP"
        },
        eligible_promo_campaigns: {
          plus: { id: "plus-1-month-50-pct-off" }
        }
      }
    }
  });
  assert.equal(context.accountId, "account-fixture");
  assert.deepEqual(context.eligibleCampaignIds, ["plus-1-month-50-pct-off"]);
  assert.equal(core.selectPlusPromotionCampaign(context), "plus-1-month-50-pct-off");
  const summary = core.summarizeAccountPromotionContext(context);
  assert.match(summary, /plus-1-month-50-pct-off/);
  assert.doesNotMatch(summary, /account-fixture/);
});

test("payment method preflight keeps eligibility and method types without identifiers", () => {
  assert.deepEqual(core.summarizePaymentMethodsPreflight({
    one_click_trial_eligible: true,
    payment_methods: [
      { id: "pm_private_1", type: "card" },
      { id: "pm_private_2", type: "card" },
      { id: "pm_private_3", type: "paypal" }
    ]
  }), {
    oneClickTrialEligible: true,
    paymentMethodCount: 3,
    paymentMethodTypes: ["card", "paypal"]
  });
});

test("promotion detection distinguishes the verified PH_SHORT discount from a zero-discount checkout", () => {
  const discounted = {
    checkout_state: {
      discountAmounts: [{ percentOff: 100, minorUnitsAmount: 98214 }],
      total: { discount: { minorUnitsAmount: 98214 }, total: { minorUnitsAmount: 0 } }
    },
    promo_campaign: { promo_campaign_id: "plus-1-month-free" }
  };
  const fullPrice = {
    checkout_state: {
      discountAmounts: [],
      total: { discount: { minorUnitsAmount: 0 }, total: { minorUnitsAmount: 110000 } }
    },
    promo_campaign: null
  };
  assert.equal(core.hasAppliedPromotion(discounted), true);
  assert.equal(core.hasAppliedPromotion(fullPrice), false);
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

test("resolveHostedCheckoutUrl accepts official processor URLs and rejects unsafe fallbacks", () => {
  assert.equal(
    core.resolveHostedCheckoutUrl({ url: "https://pay.openai.com/session/123" }),
    "https://pay.openai.com/session/123"
  );
  assert.equal(
    core.resolveHostedCheckoutUrl({ stripe_hosted_url: "https://checkout.stripe.com/c/pay/test" }),
    "https://checkout.stripe.com/c/pay/test"
  );
  assert.throws(
    () => core.resolveHostedCheckoutUrl({ checkout_session_id: "custom-only" }),
    /没有返回 Hosted Checkout URL/
  );
  assert.throws(
    () => core.resolveHostedCheckoutUrl({ url: "https://checkout.example/session" }),
    /未识别的 Checkout 域名/
  );
});

test("checkout session helpers support Stripe init and two safe fallbacks", () => {
  const payload = {
    checkout_session_id: "cs_test_fixture123",
    publishable_key: "pk_test_fixture123",
    client_secret: "cs_test_fixture123_secret_fragmentABC123",
    processor_entity: "openai_llc"
  };
  assert.deepEqual(core.getStripeInitContext(payload), {
    sessionId: "cs_test_fixture123",
    publishableKey: "pk_test_fixture123",
    locale: "en",
    stripeCompatible: true
  });
  assert.equal(
    core.buildClientSecretCheckoutUrl(payload),
    "https://pay.openai.com/c/pay/cs_test_fixture123#fragmentABC123"
  );
  assert.equal(
    core.buildInternalCheckoutUrl(payload),
    "https://chatgpt.com/checkout/openai_llc/cs_test_fixture123"
  );
  assert.equal(core.extractCheckoutSessionId({ url: "https://checkout.stripe.com/c/pay/cs_live_ABC123" }), "cs_live_ABC123");
});

test("checkout session helpers accept opaque and nested OpenAI session identifiers", () => {
  const payload = {
    data: {
      checkoutSessionId: "checkout_01JFIXTURE_opaque-session",
      publishableKey: "pk_live_nestedFixture123",
      processorEntity: "openai_llc"
    }
  };
  assert.deepEqual(core.getStripeInitContext(payload), {
    sessionId: "checkout_01JFIXTURE_opaque-session",
    publishableKey: "pk_live_nestedFixture123",
    locale: "en",
    stripeCompatible: false
  });
  assert.equal(
    core.buildInternalCheckoutUrl(payload),
    "https://chatgpt.com/checkout/openai_llc/checkout_01JFIXTURE_opaque-session"
  );
  assert.match(core.describeCheckoutResponseShape(payload), /data:object\(checkoutSessionId\|publishableKey\|processorEntity\)/);
});

test("oaics identifiers are preferred for ChatGPT internal checkout links", () => {
  const payload = {
    checkout_session_id: "cs_live_fixture123456",
    custom_checkout: { id: "oaics_de70069a4d164634a4868109425dbf82" },
    processor_entity: "openai_llc"
  };
  assert.equal(core.extractOpenAICheckoutSessionId(payload), "oaics_de70069a4d164634a4868109425dbf82");
  assert.match(core.describeCheckoutIdentifiers(payload), /stripe\(21\).*oaics\(38\)/);
  assert.equal(
    core.buildInternalCheckoutUrl(payload),
    "https://chatgpt.com/checkout/openai_llc/oaics_de70069a4d164634a4868109425dbf82"
  );
});

test("requireOpenAICheckoutSession rejects Stripe provider responses", () => {
  assert.equal(
    core.requireOpenAICheckoutSession({ checkout_session_id: "oaics_de70069a4d164634a4868109425dbf82" }),
    "oaics_de70069a4d164634a4868109425dbf82"
  );
  assert.throws(
    () => core.requireOpenAICheckoutSession({ checkout_session_id: "cs_live_fixture123456" }),
    /目标必须是 oaics_\*/
  );
});

test("promotion summary preserves eligibility decisions without session identifiers", () => {
  const summary = core.summarizePromotionState({
    tag: "checkout_fixture",
    checkout_session_id: "cs_live_private_fixture",
    checkout_ui_mode: "hosted",
    promo_campaign: { campaign_id: "plus-1-month-free", eligible: false, reason: "region" },
    promo_credit_grant: { amount: 20, currency: "USD", customer_email: "private@example.test" }
  });
  assert.match(summary, /plus-1-month-free/);
  assert.match(summary, /"eligible":false/);
  assert.match(summary, /"amount":20/);
  assert.doesNotMatch(summary, /cs_live_private_fixture|private@example\.test/);
});

test("parseProxyLine supports authenticated HTTP and SOCKS proxies", () => {
  assert.deepEqual(core.parseProxyLine("user:pass@proxy.example:1000"), {
    raw: "user:pass@proxy.example:1000",
    scheme: "http",
    host: "proxy.example",
    port: 1000,
    username: "user",
    password: "pass",
    hasCredentials: true
  });
  assert.equal(
    core.formatProxyEndpoint(core.parseProxyLine("socks5://proxy.example:1080")),
    "socks5://proxy.example:1080"
  );
});

test("parseProxyPool validates line numbers, limits and rotates by cursor", () => {
  const pool = core.parseProxyPool("first:pass@one.example:1000\nsecond:pass@two.example:2000");
  assert.equal(pool.length, 2);
  assert.equal(core.selectProxyFromPool(pool, 0).host, "one.example");
  assert.equal(core.selectProxyFromPool(pool, 3).host, "two.example");
  assert.throws(() => core.parseProxyPool("valid.example:80\nbad host:81"), /第 2 行/);
  assert.throws(() => core.parseProxyPool("one.example:80\ntwo.example:80", 1), /最多支持 1 条/);
});

test("formatProxyEndpoint never exposes credentials", () => {
  const output = core.formatProxyEndpoint(core.parseProxyLine("secret-user:secret-pass@proxy.example:1000"));
  assert.equal(output, "http://proxy.example:1000");
  assert.doesNotMatch(output, /secret/);
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

test("sanitizeDiagnosticText removes common sensitive values", () => {
  const source = {
    accessToken: "eyJhbGciOiJIUzI1NiJ9.payload.signature",
    authorization: "Bearer secret-token-value",
    email: "person@example.com",
    proxy: "user:password@proxy.example.com:1000",
    checkout_session_id: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890"
  };
  const output = core.sanitizeDiagnosticText(source, 500);

  assert.doesNotMatch(output, /secret-token-value|person@example\.com|user:password|abcdefghijklmnopqrstuvwxyz/);
  assert.match(output, /已脱敏/);
});

test("classifyDiagnostic distinguishes authentication, eligibility and rate limits", () => {
  assert.equal(core.classifyDiagnostic({ status: 401 }), "authentication");
  assert.equal(
    core.classifyDiagnostic({ status: 403, payload: { detail: "Not eligible in this region" } }),
    "eligibility"
  );
  assert.equal(core.classifyDiagnostic({ status: 429 }), "rate_limit");
});

test("createDiagnosticRecord never includes checkout session identifiers", () => {
  const record = core.createDiagnosticRecord({
    stage: "checkout",
    status: 400,
    payload: {
      detail: {
        checkout_session_id: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890",
        message: "Invalid campaign"
      }
    }
  });
  const output = core.formatDiagnosticRecord(record);

  assert.doesNotMatch(output, /abcdefghijklmnopqrstuvwxyz/);
  assert.match(output, /结账会话创建/);
});

test("validateOfficialActivityUrl accepts only official HTTPS hosts", () => {
  assert.deepEqual(
    core.validateOfficialActivityUrl("https://chatgpt.com/promo#details"),
    { ok: true, url: "https://chatgpt.com/promo" }
  );
  assert.equal(core.validateOfficialActivityUrl("http://chatgpt.com/promo").ok, false);
  assert.equal(core.validateOfficialActivityUrl("https://openai.com.evil.example/promo").ok, false);
  assert.equal(core.validateOfficialActivityUrl("https://user:pass@openai.com/promo").ok, false);
});

test("response errors receive a dedicated diagnostic category", () => {
  assert.equal(
    core.classifyDiagnostic({ status: 200, error: { name: "ResponseError" } }),
    "response"
  );
});
