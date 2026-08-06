(function initializeCheckoutCore(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  root.ChatGPTCheckoutCore = api;
})(typeof globalThis === "object" ? globalThis : this, function createCheckoutCore() {
  "use strict";

  const CHECKOUT_CONFIG = Object.freeze({
    planLabel: "ChatGPT Plus",
    planName: "chatgptplusplan",
    countryCode: "PH",
    countryLabel: "Philippines",
    currency: "PHP",
    campaignId: "plus-1-month-free",
    entryPoint: "all_plans_pricing_modal",
    checkoutUiMode: "custom",
    cancelUrl: "https://chatgpt.com/?promo_campaign=plus-1-month-free#pricing",
    locale: "zh-CN"
  });

  const PLUS_PROMO_CAMPAIGN_PRIORITY = Object.freeze([
    "plus-1-month-free",
    "plus-1-month-50-pct-off",
    "plus-2-months-50-pct-off",
    "plus-3-months-50-pct-off",
    "plus-1-month-free-for-go"
  ]);

  const PROXY_FLOW_CONFIG = Object.freeze({
    createPhase: Object.freeze({ key: "create", expectedRegion: "US", label: "创建 Checkout" }),
    applyPhase: Object.freeze({ key: "apply", expectedRegion: "TR", label: "加载结账页并应用优惠" }),
    maxPoolSize: 500
  });

  const DIAGNOSTIC_STAGE_LABELS = Object.freeze({
    session_check: "登录状态检测",
    session_refresh: "登录凭证刷新",
    checkout: "结账会话创建",
    stripe_init: "Hosted Checkout 初始化",
    proxy_create: "代理池 1（创建阶段）",
    proxy_apply: "代理池 2（优惠阶段）",
    proxy_restore: "代理设置恢复",
    official_link: "官方活动链接"
  });

  const DIAGNOSTIC_CATEGORY_LABELS = Object.freeze({
    success: "成功",
    authentication: "登录或凭证失效",
    eligibility: "活动资格不适用",
    access: "请求被拒绝",
    validation: "请求参数未通过校验",
    rate_limit: "请求过于频繁",
    server: "服务端异常",
    timeout: "请求超时",
    network: "网络异常",
    response: "响应格式异常",
    unknown: "未分类错误"
  });

  function buildCheckoutPayload({
    promotion = true,
    oneClickTrial = true,
    campaignId = CHECKOUT_CONFIG.campaignId,
    country = CHECKOUT_CONFIG.countryCode,
    currency = CHECKOUT_CONFIG.currency
  } = {}) {
    const normalizedCampaignId = typeof campaignId === "string" && campaignId.trim()
      ? campaignId.trim()
      : CHECKOUT_CONFIG.campaignId;
    const normalizedCountry = /^[A-Z]{2}$/.test(String(country || "").trim().toUpperCase())
      ? String(country).trim().toUpperCase()
      : CHECKOUT_CONFIG.countryCode;
    const normalizedCurrency = /^[A-Z]{3}$/.test(String(currency || "").trim().toUpperCase())
      ? String(currency).trim().toUpperCase()
      : CHECKOUT_CONFIG.currency;
    const payload = {
      entry_point: CHECKOUT_CONFIG.entryPoint,
      plan_name: CHECKOUT_CONFIG.planName,
      billing_details: {
        country: normalizedCountry,
        currency: normalizedCurrency
      },
      cancel_url: promotion
        ? `https://chatgpt.com/?promo_campaign=${encodeURIComponent(normalizedCampaignId)}#pricing`
        : CHECKOUT_CONFIG.cancelUrl,
      checkout_ui_mode: CHECKOUT_CONFIG.checkoutUiMode,
      locale: CHECKOUT_CONFIG.locale
    };
    if (promotion) {
      payload.promo_campaign = {
        promo_campaign_id: normalizedCampaignId,
        is_coupon_from_query_param: false
      };
      payload.one_click_trial = Boolean(oneClickTrial);
    }
    return payload;
  }

  function buildBaselineCheckoutPayload() {
    return buildCheckoutPayload({
      promotion: false,
      oneClickTrial: false,
      country: "US",
      currency: "USD"
    });
  }

  function buildPromotionCheckoutPayload({
    oneClickTrial = true,
    campaignId = CHECKOUT_CONFIG.campaignId
  } = {}) {
    return buildCheckoutPayload({
      promotion: true,
      oneClickTrial,
      campaignId,
      country: "TR",
      currency: "USD"
    });
  }

  function buildShortPromotionPayload({ campaignId = CHECKOUT_CONFIG.campaignId } = {}) {
    const normalizedCampaignId = typeof campaignId === "string" && campaignId.trim()
      ? campaignId.trim()
      : CHECKOUT_CONFIG.campaignId;
    return {
      entry_point: CHECKOUT_CONFIG.entryPoint,
      plan_name: CHECKOUT_CONFIG.planName,
      billing_details: {
        country: "TR",
        currency: "USD"
      },
      promo_campaign: {
        promo_campaign_id: normalizedCampaignId,
        is_coupon_from_query_param: false
      }
    };
  }

  const buildPhShortPromotionPayload = buildShortPromotionPayload;

  function buildPromotionUpdatePayload({
    checkoutSessionId,
    processorEntity = "openai_llc",
    campaignId = CHECKOUT_CONFIG.campaignId
  } = {}) {
    const sessionId = typeof checkoutSessionId === "string" ? checkoutSessionId.trim() : "";
    if (!/^oaics_[A-Za-z0-9_-]{16,160}$/.test(sessionId)) {
      throw new TypeError("更新优惠需要有效的 oaics_* Checkout Session ID");
    }
    const normalizedEntity = typeof processorEntity === "string"
      ? processorEntity.trim().toLowerCase()
      : "";
    if (!/^(?:openai_llc|openai_ie)$/.test(normalizedEntity)) {
      throw new TypeError("Checkout processor_entity 不受支持");
    }
    const normalizedCampaignId = typeof campaignId === "string" && campaignId.trim()
      ? campaignId.trim()
      : CHECKOUT_CONFIG.campaignId;
    return {
      checkout_session_id: sessionId,
      processor_entity: normalizedEntity,
      plan_name: CHECKOUT_CONFIG.planName,
      price_interval: "month",
      seat_quantity: 1,
      promo_campaign: {
        promo_campaign_id: normalizedCampaignId,
        is_coupon_from_query_param: false
      }
    };
  }

  function getSessionAccountId(session) {
    const candidates = [
      session && session.account && (session.account.id || session.account.account_id),
      session && session.currentAccount && (session.currentAccount.id || session.currentAccount.account_id),
      session && session.account_id
    ];
    const value = candidates.find((candidate) => typeof candidate === "string" && candidate.trim());
    return value ? value.trim() : "";
  }

  function collectPlusPromoCampaignIds(value) {
    const output = [];
    const visited = new Set();
    const queue = [{ value, depth: 0 }];
    while (queue.length) {
      const item = queue.shift();
      const candidate = item.value;
      if (typeof candidate === "string") {
        const normalized = candidate.trim();
        if (/^plus-[a-z0-9][a-z0-9-]{2,120}$/i.test(normalized) && !output.includes(normalized)) {
          output.push(normalized);
        }
        continue;
      }
      if (!candidate || typeof candidate !== "object" || visited.has(candidate) || item.depth >= 6) continue;
      visited.add(candidate);
      for (const child of Object.values(candidate)) {
        if (child && (typeof child === "object" || typeof child === "string")) {
          queue.push({ value: child, depth: item.depth + 1 });
        }
      }
    }
    return output;
  }

  function resolveAccountPromotionContext(payload, { preferredAccountId = "" } = {}) {
    const accounts = payload && payload.accounts && typeof payload.accounts === "object"
      ? payload.accounts
      : {};
    const ordering = payload && Array.isArray(payload.account_ordering)
      ? payload.account_ordering.filter((value) => typeof value === "string")
      : [];
    const accountIds = [...ordering, ...Object.keys(accounts).filter((id) => !ordering.includes(id))];
    const entries = accountIds
      .map((key) => ({ key, value: accounts[key] }))
      .filter((item) => item.value && typeof item.value === "object");
    const preferred = typeof preferredAccountId === "string" ? preferredAccountId.trim() : "";
    const selected = entries.find((item) => (
      preferred && (item.key === preferred || item.value.account?.account_id === preferred)
    )) || entries.find((item) => item.value.can_access_with_session !== false) || entries[0] || null;

    if (!selected) {
      return Object.freeze({
        accountId: "",
        accountIdPresent: false,
        accountIdLength: 0,
        planType: "",
        hasPreviouslyPaidSubscription: false,
        hasActiveSubscription: false,
        billingCurrency: "",
        hasCustomerObject: false,
        eligibleCampaignIds: Object.freeze([]),
        discountCampaignId: "",
        trialCampaignId: ""
      });
    }

    const source = selected.value;
    const account = source.account && typeof source.account === "object" ? source.account : {};
    const entitlement = source.entitlement && typeof source.entitlement === "object" ? source.entitlement : {};
    const accountId = typeof account.account_id === "string" && account.account_id.trim()
      ? account.account_id.trim()
      : selected.key;
    const eligibleCampaignIds = collectPlusPromoCampaignIds(source.eligible_promo_campaigns);
    return Object.freeze({
      accountId,
      accountIdPresent: Boolean(accountId),
      accountIdLength: accountId.length,
      planType: typeof account.plan_type === "string" ? account.plan_type : "",
      hasPreviouslyPaidSubscription: account.has_previously_paid_subscription === true,
      hasActiveSubscription: entitlement.has_active_subscription === true,
      billingCurrency: typeof entitlement.billing_currency === "string" ? entitlement.billing_currency : "",
      hasCustomerObject: account.processor?.a001?.has_customer_object === true,
      eligibleCampaignIds: Object.freeze(eligibleCampaignIds),
      discountCampaignId: typeof entitlement.discount?.promo_campaign_id === "string"
        ? entitlement.discount.promo_campaign_id
        : "",
      trialCampaignId: typeof entitlement.trial?.promo_campaign_id === "string"
        ? entitlement.trial.promo_campaign_id
        : ""
    });
  }

  function selectPlusPromotionCampaign(context, fallbackCampaignId = CHECKOUT_CONFIG.campaignId) {
    const eligible = context && Array.isArray(context.eligibleCampaignIds)
      ? context.eligibleCampaignIds
      : [];
    for (const campaignId of PLUS_PROMO_CAMPAIGN_PRIORITY) {
      if (eligible.includes(campaignId)) return campaignId;
    }
    return eligible.find((campaignId) => /^plus-/i.test(campaignId)) || fallbackCampaignId;
  }

  function summarizeAccountPromotionContext(context) {
    const source = context && typeof context === "object" ? context : {};
    return sanitizeDiagnosticText(JSON.stringify({
      account_id_present: source.accountIdPresent === true,
      account_id_length: Number.isFinite(source.accountIdLength) ? source.accountIdLength : 0,
      plan_type: typeof source.planType === "string" ? source.planType : "",
      has_previously_paid_subscription: source.hasPreviouslyPaidSubscription === true,
      has_active_subscription: source.hasActiveSubscription === true,
      billing_currency: typeof source.billingCurrency === "string" ? source.billingCurrency : "",
      has_customer_object: source.hasCustomerObject === true,
      eligible_promo_campaign_ids: Array.isArray(source.eligibleCampaignIds) ? source.eligibleCampaignIds : [],
      discount_promo_campaign_id: typeof source.discountCampaignId === "string" ? source.discountCampaignId : "",
      trial_promo_campaign_id: typeof source.trialCampaignId === "string" ? source.trialCampaignId : ""
    }), 1800);
  }

  function summarizePaymentMethodsPreflight(payload) {
    const methods = payload && Array.isArray(payload.payment_methods) ? payload.payment_methods : [];
    const types = [...new Set(methods
      .map((method) => method && typeof method.type === "string" ? method.type : "")
      .filter(Boolean))].slice(0, 12);
    return Object.freeze({
      oneClickTrialEligible: payload?.one_click_trial_eligible === true,
      paymentMethodCount: methods.length,
      paymentMethodTypes: Object.freeze(types)
    });
  }

  function hasAppliedPromotion(payload) {
    const source = payload && payload.checkout_session && typeof payload.checkout_session === "object"
      ? payload.checkout_session
      : payload;
    if (!source || typeof source !== "object") return false;
    const state = source.checkout_state && typeof source.checkout_state === "object"
      ? source.checkout_state
      : {};
    const discountMinorUnits = state.total?.discount?.minorUnitsAmount;
    if (Number.isFinite(discountMinorUnits) && discountMinorUnits > 0) return true;
    if (Array.isArray(state.discountAmounts) && state.discountAmounts.some((item) => (
      Number(item?.minorUnitsAmount) > 0 || Number(item?.percentOff) > 0
    ))) return true;
    if (Array.isArray(state.lineItems) && state.lineItems.some((item) => (
      Number(item?.discount?.minorUnitsAmount) > 0
      || (Array.isArray(item?.discountAmounts) && item.discountAmounts.some((discount) => (
        Number(discount?.minorUnitsAmount) > 0 || Number(discount?.percentOff) > 0
      )))
    ))) return true;
    return source.scheduled_discount_preview != null || source.immediate_discount_settings != null;
  }

  function resolveHostedCheckoutUrl(payload) {
    if (!payload || typeof payload !== "object") {
      throw new TypeError("服务端没有返回 Hosted Checkout 响应。");
    }

    const candidates = [payload.url, payload.stripe_hosted_url, payload.checkout_url];
    const value = candidates.find((candidate) => typeof candidate === "string" && candidate.trim());
    if (!value) {
      throw new TypeError("服务端没有返回 Hosted Checkout URL，已停止打开可能未带优惠的结账页。");
    }

    let url;
    try {
      url = new URL(value.trim());
    } catch {
      throw new TypeError("服务端返回的 Hosted Checkout URL 格式不正确。");
    }

    if (url.protocol !== "https:" || url.username || url.password) {
      throw new TypeError("Hosted Checkout URL 必须是不含凭据的 HTTPS 地址。");
    }

    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    const allowedDomains = ["chatgpt.com", "openai.com", "stripe.com"];
    const isAllowed = allowedDomains.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
    );
    if (!isAllowed) {
      throw new TypeError("服务端返回了未识别的 Checkout 域名。");
    }

    return url.toString();
  }

  function normalizeCheckoutSessionToken(value) {
    if (typeof value !== "string") return "";
    const text = value.trim();
    if (!text || text.length > 2048 || /[\u0000-\u001f\u007f]/.test(text)) return "";
    const stripeMatch = text.match(/(cs_(?:live|test)_[A-Za-z0-9_-]{6,512})/);
    if (stripeMatch) return stripeMatch[1];
    if (/^[A-Za-z0-9_-]{8,512}$/.test(text) && !/^(?:pk|sk)_(?:live|test)_/.test(text)) {
      return text;
    }
    return "";
  }

  function extractCheckoutSessionId(payload) {
    if (!payload || typeof payload !== "object") return "";
    const directCandidates = [
      payload.checkout_session_id,
      payload.checkout_session_id && payload.checkout_session_id.id,
      payload.checkoutSessionId,
      payload.session_id,
      payload.sessionId,
      payload.checkout_session && payload.checkout_session.id,
      payload.checkoutSession && payload.checkoutSession.id,
      payload.checkout && (payload.checkout.session_id || payload.checkout.sessionId || payload.checkout.id),
      payload.data && (payload.data.checkout_session_id || payload.data.checkoutSessionId || payload.data.session_id || payload.data.sessionId),
      payload.payment && (payload.payment.checkout_session_id || payload.payment.session_id)
    ];
    for (const candidate of directCandidates) {
      const normalized = normalizeCheckoutSessionToken(candidate);
      if (normalized) return normalized;
    }

    const queue = [{ value: payload, path: "", depth: 0 }];
    let visited = 0;
    while (queue.length && visited < 80) {
      const current = queue.shift();
      visited += 1;
      if (!current.value || typeof current.value !== "object" || current.depth > 3) continue;
      for (const [key, value] of Object.entries(current.value)) {
        const path = current.path ? `${current.path}.${key}` : key;
        const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
        const pathHint = path.toLowerCase();
        const looksLikeSessionId = normalizedKey.includes("sessionid")
          || normalizedKey.includes("checkoutsession")
          || (normalizedKey === "id" && /checkout|session/.test(current.path.toLowerCase()));
        if (looksLikeSessionId) {
          const normalized = normalizeCheckoutSessionToken(value);
          if (normalized) return normalized;
        }
        if (typeof value === "string" && /url|uri|link/.test(normalizedKey)) {
          const normalized = normalizeCheckoutSessionToken(value);
          if (normalized) return normalized;
        }
        if (value && typeof value === "object" && current.depth < 3 && /checkout|session|payment|data|result/.test(pathHint)) {
          queue.push({ value, path, depth: current.depth + 1 });
        }
      }
    }
    return "";
  }

  function extractOpenAICheckoutSessionId(payload) {
    if (!payload || typeof payload !== "object") return "";
    const queue = [{ value: payload, depth: 0 }];
    const visited = new Set();
    let inspected = 0;
    while (queue.length && inspected < 400) {
      const { value, depth } = queue.shift();
      inspected += 1;
      if (typeof value === "string") {
        const match = value.match(/(?:^|[/])((?:oaics)_[A-Za-z0-9_-]{16,160})(?:$|[?#/])/);
        if (match) return match[1];
        if (/^oaics_[A-Za-z0-9_-]{16,160}$/.test(value.trim())) return value.trim();
        continue;
      }
      if (!value || typeof value !== "object" || visited.has(value) || depth >= 6) continue;
      visited.add(value);
      for (const [key, child] of Object.entries(value)) {
        if (typeof child === "string" && /(?:oaics|openai.*checkout|checkout.*openai)/i.test(key)) {
          const match = child.trim().match(/oaics_[A-Za-z0-9_-]{16,160}/);
          if (match) return match[0];
        }
        if (child && (typeof child === "object" || typeof child === "string")) {
          queue.push({ value: child, depth: depth + 1 });
        }
      }
    }
    return "";
  }

  function requireOpenAICheckoutSession(payload) {
    const sessionId = extractOpenAICheckoutSessionId(payload);
    if (!sessionId) {
      const stripeId = extractCheckoutSessionId(payload);
      const actual = stripeId && /^cs_(?:live|test)_/.test(stripeId) ? "cs_*" : "unknown";
      throw new TypeError(`第二阶段返回 ${actual}，目标必须是 oaics_*；已停止打开错误提供方的结账页。`);
    }
    return sessionId;
  }

  function describeCheckoutIdentifiers(payload) {
    if (!payload || typeof payload !== "object") return "none";
    const output = [];
    const queue = [{ value: payload, path: "$", depth: 0 }];
    const visited = new Set();
    let inspected = 0;
    while (queue.length && inspected < 400 && output.length < 30) {
      const { value, path, depth } = queue.shift();
      inspected += 1;
      if (typeof value === "string") {
        const oaics = value.match(/oaics_[A-Za-z0-9_-]{16,160}/);
        const stripe = value.match(/cs_(?:live|test)_[A-Za-z0-9_-]{6,512}/);
        if (oaics) output.push(`${path}:oaics(${oaics[0].length})`);
        if (stripe) output.push(`${path}:stripe(${stripe[0].length})`);
        continue;
      }
      if (!value || typeof value !== "object" || visited.has(value) || depth >= 6) continue;
      visited.add(value);
      for (const [key, child] of Object.entries(value)) {
        if (child && (typeof child === "object" || typeof child === "string")) {
          queue.push({ value: child, path: `${path}.${key}`, depth: depth + 1 });
        }
      }
    }
    return output.length ? output.join(", ") : "none";
  }

  function describeCheckoutResponseShape(payload) {
    if (!payload || typeof payload !== "object") return typeof payload;
    return Object.entries(payload).slice(0, 20).map(([key, value]) => {
      if (Array.isArray(value)) return `${key}:array(${value.length})`;
      if (value && typeof value === "object") {
        return `${key}:object(${Object.keys(value).slice(0, 8).join("|")})`;
      }
      if (typeof value === "string") return `${key}:string(${value.length})`;
      return `${key}:${typeof value}`;
    }).join(", ");
  }

  function summarizePromotionState(payload) {
    if (!payload || typeof payload !== "object") return "{}";
    const source = payload.checkout_session && typeof payload.checkout_session === "object"
      ? payload.checkout_session
      : payload;
    const promotionKeys = [
      "one_click_trial_eligible",
      "checkout_provider",
      "plan_name",
      "currency",
      "country",
      "billing_details",
      "checkout_state",
      "line_items",
      "price",
      "subtotal",
      "tax",
      "total",
      "discount",
      "scheduled_discount_preview",
      "immediate_discount_settings",
      "promo_campaign",
      "promo_credit_grant",
      "credit_discount_offer",
      "credit_discount_preview"
    ];

    function summarize(value, depth = 0) {
      if (value === null || typeof value === "boolean" || typeof value === "number") return value;
      if (typeof value === "string") return sanitizeDiagnosticText(value, 160);
      if (depth >= 5) return "[depth-limit]";
      if (Array.isArray(value)) return value.slice(0, 20).map((item) => summarize(item, depth + 1));
      if (!value || typeof value !== "object") return String(value);
      const output = {};
      for (const [key, child] of Object.entries(value).slice(0, 50)) {
        const isOpaqueSessionId = key === "id"
          && typeof child === "string"
          && /^(?:oaics_|cs_(?:live|test)_)/i.test(child);
        if (isOpaqueSessionId || /session|token|secret|authorization|password|email|phone|address|customer|fingerprint|account.*id|workspace.*id|user.*id/i.test(key)) {
          output[key] = `[${Array.isArray(child) ? "array" : typeof child}]`;
        } else {
          output[key] = summarize(child, depth + 1);
        }
      }
      return output;
    }

    const summary = {
      tag: summarize(source.tag ?? payload.tag),
      checkout_ui_mode: summarize(source.checkout_ui_mode),
      automatic_tax_enabled: summarize(source.automatic_tax_enabled)
    };
    for (const key of promotionKeys) {
      if (Object.prototype.hasOwnProperty.call(source, key)) summary[key] = summarize(source[key]);
    }
    return sanitizeDiagnosticText(JSON.stringify(summary), 2400);
  }

  function getStripeInitContext(payload) {
    const sessionId = extractCheckoutSessionId(payload);
    if (!sessionId) {
      throw new TypeError(`服务端响应缺少可用的 Checkout Session ID；响应形态：${describeCheckoutResponseShape(payload)}`);
    }
    const keyCandidate = [
      payload.publishable_key,
      payload.publishableKey,
      payload.data && (payload.data.publishable_key || payload.data.publishableKey),
      payload.checkout && (payload.checkout.publishable_key || payload.checkout.publishableKey)
    ].find((value) => typeof value === "string" && /^pk_(?:live|test)_[A-Za-z0-9_-]+$/.test(value.trim()));
    const publishableKey = keyCandidate
      ? keyCandidate.trim()
      : "";
    return Object.freeze({
      sessionId,
      publishableKey,
      locale: "en",
      stripeCompatible: /^cs_(?:live|test)_[A-Za-z0-9_-]{6,512}$/.test(sessionId)
    });
  }

  function buildClientSecretCheckoutUrl(payload) {
    const sessionId = extractCheckoutSessionId(payload);
    const secretCandidate = payload && (payload.client_secret
      || payload.clientSecret
      || (payload.data && (payload.data.client_secret || payload.data.clientSecret))
      || (payload.checkout && (payload.checkout.client_secret || payload.checkout.clientSecret)));
    const clientSecret = typeof secretCandidate === "string"
      ? secretCandidate.trim()
      : "";
    if (!sessionId || !clientSecret) return "";
    const marker = `${sessionId}_secret_`;
    const markerIndex = clientSecret.indexOf(marker);
    if (markerIndex < 0) return "";
    const fragment = clientSecret.slice(markerIndex + marker.length);
    if (!/^[A-Za-z0-9_-]+$/.test(fragment)) return "";
    return `https://pay.openai.com/c/pay/${sessionId}#${fragment}`;
  }

  function buildInternalCheckoutUrl(payload) {
    const sessionId = extractOpenAICheckoutSessionId(payload) || extractCheckoutSessionId(payload);
    if (!sessionId) return "";
    const entityCandidate = payload && (payload.processor_entity
      || payload.processorEntity
      || (payload.data && (payload.data.processor_entity || payload.data.processorEntity)));
    const rawEntity = typeof entityCandidate === "string"
      ? entityCandidate.trim().toLowerCase()
      : "";
    const processorEntity = /^(?:openai_llc|openai_ie)$/.test(rawEntity) ? rawEntity : "openai_llc";
    return `https://chatgpt.com/checkout/${processorEntity}/${encodeURIComponent(sessionId)}`;
  }

  function buildCheckoutUrl(sessionId) {
    if (typeof sessionId !== "string" || sessionId.trim() === "") {
      throw new TypeError("Missing checkout session id");
    }

    return `https://chatgpt.com/checkout/openai_llc/${encodeURIComponent(sessionId.trim())}`;
  }

  function parseProxyLine(input) {
    const value = typeof input === "string" ? input.trim() : "";
    if (!value) {
      throw new TypeError("代理条目为空");
    }
    if (/\s/.test(value)) {
      throw new TypeError("代理条目不能包含空白字符");
    }

    const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `http://${value}`;
    let url;
    try {
      url = new URL(withScheme);
    } catch {
      throw new TypeError("代理格式应为 user:password@host:port");
    }

    const scheme = url.protocol.slice(0, -1).toLowerCase();
    const allowedSchemes = new Set(["http", "https", "socks4", "socks5"]);
    if (!allowedSchemes.has(scheme)) {
      throw new TypeError("代理协议仅支持 http、https、socks4 或 socks5");
    }
    if (!url.hostname || (url.pathname && url.pathname !== "/") || url.search || url.hash) {
      throw new TypeError("代理条目只能包含凭据、主机和端口");
    }

    const defaultPorts = { http: 80, https: 443, socks4: 1080, socks5: 1080 };
    const port = url.port ? Number(url.port) : defaultPorts[scheme];
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new TypeError("代理端口应在 1 到 65535 之间");
    }

    let username = "";
    let password = "";
    try {
      username = decodeURIComponent(url.username);
      password = decodeURIComponent(url.password);
    } catch {
      throw new TypeError("代理用户名或密码编码不正确");
    }

    return Object.freeze({
      raw: value,
      scheme,
      host: url.hostname,
      port,
      username,
      password,
      hasCredentials: Boolean(username || password)
    });
  }

  function parseProxyPool(input, maxPoolSize = PROXY_FLOW_CONFIG.maxPoolSize) {
    const normalizedLimit = Number.isInteger(maxPoolSize) && maxPoolSize > 0
      ? maxPoolSize
      : PROXY_FLOW_CONFIG.maxPoolSize;
    const lines = String(input || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length === 0) {
      throw new TypeError("代理池至少需要 1 条代理");
    }
    if (lines.length > normalizedLimit) {
      throw new TypeError(`代理池最多支持 ${normalizedLimit} 条代理`);
    }

    return Object.freeze(lines.map((line, index) => {
      try {
        return parseProxyLine(line);
      } catch (error) {
        throw new TypeError(`代理池第 ${index + 1} 行：${error.message}`);
      }
    }));
  }

  function selectProxyFromPool(input, cursor = 0) {
    const pool = Array.isArray(input) ? input : parseProxyPool(input);
    if (pool.length === 0) {
      throw new TypeError("代理池至少需要 1 条代理");
    }
    const normalizedCursor = Number.isInteger(cursor) ? cursor : 0;
    const index = ((normalizedCursor % pool.length) + pool.length) % pool.length;
    return pool[index];
  }

  function formatProxyEndpoint(proxy) {
    if (!proxy || typeof proxy !== "object" || !proxy.host || !proxy.port) {
      return "未设置";
    }
    return `${proxy.scheme || "http"}://${proxy.host}:${proxy.port}`;
  }

  function parseResponseText(text) {
    if (!text) {
      return {};
    }

    try {
      return JSON.parse(text);
    } catch {
      return { detail: text.slice(0, 500) };
    }
  }

  function redactString(value) {
    return String(value)
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [已脱敏]")
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[令牌已脱敏]")
      .replace(/([?&](?:access_token|token|session|session_id|key|secret|code)=)[^&\s]+/gi, "$1[已脱敏]")
      .replace(/\b[\w.-]+:[^@\s]+@[\w.-]+:\d{2,5}\b/g, "[代理凭据已脱敏]")
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[邮箱已脱敏]")
      .replace(/\b[A-Za-z0-9_-]{48,}\b/g, "[长标识已脱敏]");
  }

  function stringifyDiagnosticValue(value) {
    if (typeof value === "string") {
      return value;
    }

    if (value === undefined || value === null) {
      return "";
    }

    if (typeof value !== "object") {
      return String(value);
    }

    try {
      return JSON.stringify(value, (key, currentValue) => {
        if (/token|secret|password|authorization|session(?:_id)?/i.test(key)) {
          return "[已脱敏]";
        }
        return currentValue;
      });
    } catch {
      return "[无法序列化的响应]";
    }
  }

  function sanitizeDiagnosticText(value, maxLength = 240) {
    const normalizedLimit = Number.isInteger(maxLength) && maxLength > 0 ? maxLength : 240;
    const sanitized = redactString(stringifyDiagnosticValue(value))
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();

    if (sanitized.length <= normalizedLimit) {
      return sanitized;
    }

    return `${sanitized.slice(0, normalizedLimit - 1)}…`;
  }

  function getPayloadMessage(payload) {
    if (!payload || typeof payload !== "object") return "";
    if (payload.detail !== undefined) return sanitizeDiagnosticText(payload.detail);
    if (payload.message !== undefined) return sanitizeDiagnosticText(payload.message);
    if (payload.error !== undefined) return sanitizeDiagnosticText(payload.error);
    return "";
  }

  function getPayloadCode(payload) {
    if (!payload || typeof payload !== "object") return "";
    const candidates = [
      payload.code,
      payload.type,
      payload.error && payload.error.code,
      payload.error && payload.error.type,
      payload.detail && payload.detail.code,
      payload.detail && payload.detail.type
    ];
    const code = candidates.find((candidate) => typeof candidate === "string" && candidate.trim());
    return code ? sanitizeDiagnosticText(code, 80) : "";
  }

  function classifyDiagnostic({ status, payload, error, ok = false } = {}) {
    if (ok) return "success";

    const errorName = error && typeof error === "object" ? error.name : "";
    if (errorName === "AbortError" || errorName === "TimeoutError") return "timeout";
    if (errorName === "ResponseError") return "response";

    const statusNumber = Number(status) || 0;
    const fingerprint = `${getPayloadCode(payload)} ${getPayloadMessage(payload)}`.toLowerCase();
    const eligibilityPattern = /promo|campaign|coupon|eligible|eligibility|region|country|payment method|活动|资格|地区|付款方式/;

    if (statusNumber === 401) return "authentication";
    if (statusNumber === 403) return eligibilityPattern.test(fingerprint) ? "eligibility" : "access";
    if ([400, 409, 422].includes(statusNumber)) {
      return eligibilityPattern.test(fingerprint) ? "eligibility" : "validation";
    }
    if (statusNumber === 429) return "rate_limit";
    if (statusNumber >= 500) return "server";
    if (statusNumber >= 400) return "validation";
    if (error) return "network";
    return "unknown";
  }

  function createDiagnosticRecord({ stage, status, payload, error, ok = false } = {}) {
    const category = classifyDiagnostic({ status, payload, error, ok });
    const message = getPayloadMessage(payload)
      || sanitizeDiagnosticText(error && error.message ? error.message : error)
      || (ok ? "请求完成" : "没有可用的错误详情");

    return Object.freeze({
      timestamp: new Date().toISOString(),
      stage: DIAGNOSTIC_STAGE_LABELS[stage] || "网络请求",
      result: ok ? "成功" : "失败",
      category: DIAGNOSTIC_CATEGORY_LABELS[category] || DIAGNOSTIC_CATEGORY_LABELS.unknown,
      httpStatus: Number(status) || null,
      code: getPayloadCode(payload) || null,
      message: sanitizeDiagnosticText(message)
    });
  }

  function formatDiagnosticRecord(record) {
    if (!record || typeof record !== "object") return "暂无诊断记录";
    return [
      `时间：${sanitizeDiagnosticText(record.timestamp, 40) || "—"}`,
      `阶段：${sanitizeDiagnosticText(record.stage, 40) || "—"}`,
      `结果：${sanitizeDiagnosticText(record.result, 20) || "—"}`,
      `分类：${sanitizeDiagnosticText(record.category, 40) || "—"}`,
      `HTTP：${record.httpStatus || "—"}`,
      `代码：${sanitizeDiagnosticText(record.code, 80) || "—"}`,
      `说明：${sanitizeDiagnosticText(record.message) || "—"}`
    ].join("\n");
  }

  function validateOfficialActivityUrl(input) {
    const value = typeof input === "string" ? input.trim() : "";
    if (!value) {
      return { ok: false, error: "请输入官方活动链接。" };
    }

    let url;
    try {
      url = new URL(value);
    } catch {
      return { ok: false, error: "链接格式不正确。" };
    }

    if (url.protocol !== "https:" || url.username || url.password) {
      return { ok: false, error: "仅支持不含用户名或密码的 HTTPS 链接。" };
    }

    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    const isOfficialHost = ["chatgpt.com", "openai.com"].some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
    );
    if (!isOfficialHost) {
      return { ok: false, error: "仅支持 chatgpt.com 或 openai.com 官方域名。" };
    }

    url.hash = "";
    return { ok: true, url: url.toString() };
  }

  function formatApiError(payload, status) {
    const prefix = status ? `请求失败（HTTP ${status}）` : "请求失败";

    if (!payload || typeof payload !== "object") {
      return prefix;
    }

    const message = getPayloadMessage(payload);
    if (message) return `${prefix}：${message}`;

    return prefix;
  }

  return Object.freeze({
    CHECKOUT_CONFIG,
    PLUS_PROMO_CAMPAIGN_PRIORITY,
    PROXY_FLOW_CONFIG,
    buildCheckoutPayload,
    buildBaselineCheckoutPayload,
    buildPromotionCheckoutPayload,
    buildShortPromotionPayload,
    buildPhShortPromotionPayload,
    buildPromotionUpdatePayload,
    getSessionAccountId,
    collectPlusPromoCampaignIds,
    resolveAccountPromotionContext,
    selectPlusPromotionCampaign,
    summarizeAccountPromotionContext,
    summarizePaymentMethodsPreflight,
    hasAppliedPromotion,
    buildCheckoutUrl,
    resolveHostedCheckoutUrl,
    extractCheckoutSessionId,
    extractOpenAICheckoutSessionId,
    requireOpenAICheckoutSession,
    describeCheckoutIdentifiers,
    describeCheckoutResponseShape,
    summarizePromotionState,
    getStripeInitContext,
    buildClientSecretCheckoutUrl,
    buildInternalCheckoutUrl,
    parseProxyLine,
    parseProxyPool,
    selectProxyFromPool,
    formatProxyEndpoint,
    parseResponseText,
    formatApiError,
    sanitizeDiagnosticText,
    classifyDiagnostic,
    createDiagnosticRecord,
    formatDiagnosticRecord,
    validateOfficialActivityUrl
  });
});
