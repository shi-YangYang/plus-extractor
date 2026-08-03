(function mountCheckoutHelper() {
  "use strict";

  const ROOT_ID = "chatgpt-checkout-helper-root";
  const REQUEST_TIMEOUT_MS = 15_000;
  const core = globalThis.ChatGPTCheckoutCore;

  if (!core || document.getElementById(ROOT_ID)) {
    return;
  }

  const state = {
    busy: false,
    loggedIn: false
  };

  const host = document.createElement("div");
  host.id = ROOT_ID;
  document.documentElement.append(host);

  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = `
    :host {
      color-scheme: light dark;
      font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      position: fixed;
      z-index: 2147483647;
    }

    *, *::before, *::after { box-sizing: border-box; }
    [hidden] { display: none !important; }

    button, input { font: inherit; }

    .launcher {
      align-items: center;
      background: #111827;
      border: 1px solid rgba(255, 255, 255, 0.18);
      border-radius: 999px;
      bottom: 22px;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.25);
      color: #fff;
      cursor: pointer;
      display: flex;
      font-size: 14px;
      font-weight: 650;
      gap: 8px;
      padding: 11px 16px;
      position: fixed;
      right: 22px;
      transition: transform 140ms ease, box-shadow 140ms ease;
    }

    .launcher:hover {
      box-shadow: 0 16px 38px rgba(0, 0, 0, 0.32);
      transform: translateY(-2px);
    }

    .launcher:focus-visible, .button:focus-visible, .checkbox:focus-visible {
      outline: 3px solid #93c5fd;
      outline-offset: 2px;
    }

    .spark {
      background: #10a37f;
      border-radius: 50%;
      display: inline-block;
      height: 9px;
      width: 9px;
    }

    .overlay {
      align-items: center;
      background: rgba(15, 23, 42, 0.58);
      display: flex;
      inset: 0;
      justify-content: center;
      padding: 20px;
      position: fixed;
    }

    .panel {
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 18px;
      box-shadow: 0 24px 80px rgba(15, 23, 42, 0.3);
      color: #111827;
      max-height: min(720px, calc(100vh - 40px));
      max-width: 460px;
      overflow: auto;
      padding: 24px;
      width: 100%;
    }

    .header {
      align-items: flex-start;
      display: flex;
      gap: 16px;
      justify-content: space-between;
      margin-bottom: 20px;
    }

    .title { font-size: 20px; font-weight: 750; line-height: 1.25; margin: 0; }
    .subtitle { color: #6b7280; font-size: 13px; line-height: 1.5; margin: 6px 0 0; }

    .badge {
      background: #ecfdf5;
      border: 1px solid #a7f3d0;
      border-radius: 999px;
      color: #047857;
      flex: 0 0 auto;
      font-size: 11px;
      font-weight: 700;
      padding: 5px 8px;
    }

    .session {
      align-items: center;
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      display: flex;
      font-size: 13px;
      gap: 9px;
      margin-bottom: 16px;
      padding: 11px 12px;
    }

    .dot { background: #94a3b8; border-radius: 50%; height: 8px; width: 8px; }
    .dot.ok { background: #10b981; }
    .dot.error { background: #ef4444; }

    .details {
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      margin: 0 0 16px;
      overflow: hidden;
    }

    .row {
      align-items: center;
      display: flex;
      gap: 16px;
      justify-content: space-between;
      min-height: 43px;
      padding: 9px 12px;
    }

    .row + .row { border-top: 1px solid #e5e7eb; }
    .label { color: #6b7280; font-size: 12px; }
    .value { font-size: 13px; font-weight: 650; overflow-wrap: anywhere; text-align: right; }

    .notice {
      background: #fffbeb;
      border: 1px solid #fde68a;
      border-radius: 12px;
      color: #92400e;
      font-size: 12px;
      line-height: 1.55;
      margin: 0 0 16px;
      padding: 11px 12px;
    }

    .confirm {
      align-items: flex-start;
      color: #374151;
      cursor: pointer;
      display: flex;
      font-size: 12px;
      gap: 9px;
      line-height: 1.5;
      margin-bottom: 14px;
    }

    .checkbox { height: 16px; margin: 1px 0 0; width: 16px; }

    .status {
      border-radius: 10px;
      font-size: 12px;
      line-height: 1.5;
      margin-bottom: 14px;
      min-height: 18px;
      overflow-wrap: anywhere;
    }

    .status.error { background: #fef2f2; color: #b91c1c; padding: 9px 10px; }
    .status.success { background: #ecfdf5; color: #047857; padding: 9px 10px; }

    .actions { display: flex; gap: 10px; justify-content: flex-end; }

    .button {
      border: 0;
      border-radius: 10px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 700;
      min-height: 40px;
      padding: 9px 14px;
    }

    .button.secondary { background: #f3f4f6; color: #374151; }
    .button.primary { background: #10a37f; color: #fff; }
    .button.primary:hover:not(:disabled) { background: #0d8a6c; }
    .button:disabled { cursor: not-allowed; opacity: 0.48; }

    @media (prefers-color-scheme: dark) {
      .panel { background: #171717; border-color: #383838; color: #f9fafb; }
      .subtitle, .label { color: #9ca3af; }
      .session { background: #202020; border-color: #3f3f46; }
      .details, .row + .row { border-color: #3f3f46; }
      .notice { background: #30270d; border-color: #6b5214; color: #fde68a; }
      .confirm { color: #d1d5db; }
      .button.secondary { background: #2f2f2f; color: #e5e7eb; }
    }

    @media (max-width: 560px) {
      .launcher { bottom: 14px; right: 14px; }
      .overlay { align-items: flex-end; padding: 10px; }
      .panel { border-radius: 18px 18px 12px 12px; padding: 20px; }
    }
  `;
  shadow.append(style);

  function element(tagName, options = {}) {
    const node = document.createElement(tagName);
    if (options.className) node.className = options.className;
    if (options.text !== undefined) node.textContent = options.text;
    if (options.type) node.type = options.type;
    if (options.id) node.id = options.id;
    return node;
  }

  const launcher = element("button", {
    className: "launcher",
    type: "button"
  });
  launcher.setAttribute("aria-haspopup", "dialog");
  launcher.setAttribute("aria-label", "打开 ChatGPT Plus 结账助手");
  launcher.append(
    element("span", { className: "spark" }),
    element("span", { text: "Plus 结账" })
  );

  const overlay = element("div", { className: "overlay" });
  overlay.hidden = true;

  const panel = element("section", { className: "panel" });
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "checkout-helper-title");

  const header = element("div", { className: "header" });
  const heading = element("div");
  heading.append(
    element("h2", {
      className: "title",
      id: "checkout-helper-title",
      text: "Plus 结账助手"
    }),
    element("p", {
      className: "subtitle",
      text: "创建结账会话后，将进入 ChatGPT 官方结账页。"
    })
  );
  header.append(heading, element("span", { className: "badge", text: "仅本地运行" }));

  const sessionRow = element("div", { className: "session" });
  const sessionDot = element("span", { className: "dot" });
  const sessionText = element("span", { text: "等待检测登录状态" });
  sessionRow.append(sessionDot, sessionText);

  const details = element("div", { className: "details" });
  const detailRows = [
    ["方案", core.CHECKOUT_CONFIG.planLabel],
    ["账单地区", `${core.CHECKOUT_CONFIG.countryCode} · ${core.CHECKOUT_CONFIG.countryLabel}`],
    ["币种", core.CHECKOUT_CONFIG.currency],
    ["活动", core.CHECKOUT_CONFIG.campaignId]
  ];
  for (const [label, value] of detailRows) {
    const row = element("div", { className: "row" });
    row.append(
      element("span", { className: "label", text: label }),
      element("span", { className: "value", text: value })
    );
    details.append(row);
  }

  const notice = element("p", {
    className: "notice",
    text: "这是未公开内部接口的本地封装，可能随时失效。活动资格、最终价格、税费与续费规则以官方结账页为准。"
  });

  const confirmLabel = element("label", { className: "confirm" });
  const confirmCheckbox = element("input", { className: "checkbox", type: "checkbox" });
  confirmLabel.append(
    confirmCheckbox,
    element("span", {
      text: "我确认账单地区信息真实、本人符合该活动资格，并会在付款前核对最终价格。"
    })
  );

  const status = element("div", { className: "status" });
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");

  const actions = element("div", { className: "actions" });
  const closeButton = element("button", {
    className: "button secondary",
    type: "button",
    text: "关闭"
  });
  const submitButton = element("button", {
    className: "button primary",
    type: "button",
    text: "创建结账会话"
  });
  submitButton.disabled = true;
  actions.append(closeButton, submitButton);

  panel.append(header, sessionRow, details, notice, confirmLabel, status, actions);
  overlay.append(panel);
  shadow.append(launcher, overlay);

  function setStatus(message = "", kind = "") {
    status.textContent = message;
    status.className = kind ? `status ${kind}` : "status";
  }

  function updateSubmitState() {
    submitButton.disabled = state.busy || !state.loggedIn || !confirmCheckbox.checked;
  }

  function setBusy(busy) {
    state.busy = busy;
    closeButton.disabled = busy;
    confirmCheckbox.disabled = busy;
    submitButton.textContent = busy ? "正在创建…" : "创建结账会话";
    updateSubmitState();
  }

  async function fetchJson(url, options = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        ...options,
        credentials: "include",
        signal: controller.signal
      });
      const payload = core.parseResponseText(await response.text());

      if (!response.ok) {
        throw new Error(core.formatApiError(payload, response.status));
      }

      return payload;
    } catch (error) {
      if (error && error.name === "AbortError") {
        throw new Error("请求超时，请检查网络后重试。");
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function checkSession() {
    state.loggedIn = false;
    sessionDot.className = "dot";
    sessionText.textContent = "正在检测登录状态…";
    updateSubmitState();

    try {
      const session = await fetchJson("/api/auth/session", {
        headers: { Accept: "application/json" }
      });
      state.loggedIn = Boolean(session && session.accessToken);
      sessionDot.className = state.loggedIn ? "dot ok" : "dot error";
      sessionText.textContent = state.loggedIn
        ? "已登录，可以创建结账会话"
        : "未检测到登录凭证，请先登录 ChatGPT";
    } catch (error) {
      sessionDot.className = "dot error";
      sessionText.textContent = "登录状态检测失败";
      setStatus(error instanceof Error ? error.message : String(error), "error");
    } finally {
      updateSubmitState();
    }
  }

  function openDialog() {
    overlay.hidden = false;
    launcher.hidden = true;
    confirmCheckbox.checked = false;
    setStatus();
    updateSubmitState();
    void checkSession();
    closeButton.focus();
  }

  function closeDialog() {
    if (state.busy) return;
    overlay.hidden = true;
    launcher.hidden = false;
    launcher.focus();
  }

  async function createCheckoutSession() {
    if (state.busy || !confirmCheckbox.checked) return;

    setBusy(true);
    setStatus("正在创建官方结账会话…");

    let accessToken = null;
    try {
      const session = await fetchJson("/api/auth/session", {
        headers: { Accept: "application/json" }
      });
      accessToken = session && session.accessToken;

      if (!accessToken) {
        state.loggedIn = false;
        throw new Error("当前会话没有登录凭证，请重新登录后再试。");
      }

      const checkout = await fetchJson("/backend-api/payments/checkout", {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(core.buildCheckoutPayload())
      });
      accessToken = null;

      const checkoutUrl = core.buildCheckoutUrl(checkout.checkout_session_id);
      setStatus("创建成功，正在前往官方结账页…", "success");
      window.location.assign(checkoutUrl);
    } catch (error) {
      accessToken = null;
      setStatus(error instanceof Error ? error.message : String(error), "error");
      setBusy(false);
    }
  }

  launcher.addEventListener("click", openDialog);
  closeButton.addEventListener("click", closeDialog);
  confirmCheckbox.addEventListener("change", updateSubmitState);
  submitButton.addEventListener("click", () => void createCheckoutSession());
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeDialog();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !overlay.hidden) closeDialog();
  });
})();
