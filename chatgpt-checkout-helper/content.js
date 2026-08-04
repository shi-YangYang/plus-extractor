(function mountCheckoutHelper() {
  "use strict";

  const ROOT_ID = "chatgpt-checkout-helper-root";
  const REQUEST_TIMEOUT_MS = 15_000;
  const PROXY_CACHE_KEY = "plusExtractorProxyPoolsV1";
  const PROXY_CACHE_DELAY_MS = 250;
  const core = globalThis.ChatGPTCheckoutCore;

  if (!core || document.getElementById(ROOT_ID)) {
    return;
  }

  const state = {
    busy: false,
    loggedIn: false,
    latestDiagnostic: null,
    activeProxy: null,
    createPoolCursor: 0,
    applyPoolCursor: 0,
    proxyCachePromise: null,
    proxyCacheTimer: null
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

    button, input, textarea { font: inherit; }

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

    .spark.active { background: #f59e0b; box-shadow: 0 0 0 4px rgba(245, 158, 11, 0.2); }

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
      max-width: 760px;
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

    .toolbox {
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 12px;
      margin-bottom: 16px;
      padding: 12px;
    }

    .toolbox-title {
      display: block;
      font-size: 12px;
      font-weight: 700;
      margin-bottom: 7px;
    }

    .link-row { display: flex; gap: 8px; }

    .input {
      background: #fff;
      border: 1px solid #cbd5e1;
      border-radius: 9px;
      color: #111827;
      font-size: 12px;
      min-height: 38px;
      min-width: 0;
      padding: 8px 10px;
      width: 100%;
    }

    .proxy-grid {
      display: grid;
      gap: 10px;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .proxy-card {
      background: #fff;
      border: 1px solid #dbe3ee;
      border-radius: 10px;
      padding: 10px;
    }

    .proxy-card-title {
      align-items: center;
      display: flex;
      font-size: 12px;
      font-weight: 750;
      gap: 7px;
      justify-content: space-between;
      margin-bottom: 7px;
    }

    .phase-badge {
      background: #eef2ff;
      border-radius: 999px;
      color: #4338ca;
      font-size: 10px;
      padding: 3px 6px;
    }

    .proxy-input {
      min-height: 82px;
      resize: vertical;
    }

    .proxy-state {
      align-items: center;
      color: #475569;
      display: flex;
      font-size: 11px;
      gap: 7px;
      justify-content: space-between;
      margin-top: 9px;
    }

    .proxy-state strong { color: #0f766e; }

    .flow-list {
      color: #475569;
      font-size: 11px;
      line-height: 1.55;
      margin: 8px 0 0;
      padding-left: 18px;
    }

    .input:focus-visible {
      border-color: #10a37f;
      outline: 3px solid rgba(16, 163, 127, 0.18);
    }

    .input-help {
      color: #64748b;
      font-size: 11px;
      line-height: 1.45;
      margin: 7px 0 0;
    }

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

    .diagnostic-output {
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 10px;
      color: #dbeafe;
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      font-size: 11px;
      line-height: 1.55;
      margin: -4px 0 14px;
      overflow: auto;
      padding: 10px;
      white-space: pre-wrap;
    }

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
    .button.compact { flex: 0 0 auto; min-height: 38px; padding: 7px 11px; }
    .button.primary { background: #10a37f; color: #fff; }
    .button.primary:hover:not(:disabled) { background: #0d8a6c; }
    .button:disabled { cursor: not-allowed; opacity: 0.48; }

    @media (prefers-color-scheme: dark) {
      .panel { background: #171717; border-color: #383838; color: #f9fafb; }
      .subtitle, .label { color: #9ca3af; }
      .session { background: #202020; border-color: #3f3f46; }
      .details, .row + .row { border-color: #3f3f46; }
      .toolbox { background: #202020; border-color: #3f3f46; }
      .proxy-card { background: #171717; border-color: #3f3f46; }
      .input { background: #171717; border-color: #52525b; color: #f9fafb; }
      .input-help { color: #9ca3af; }
      .proxy-state, .flow-list { color: #a1a1aa; }
      .notice { background: #30270d; border-color: #6b5214; color: #fde68a; }
      .confirm { color: #d1d5db; }
      .button.secondary { background: #2f2f2f; color: #e5e7eb; }
    }

    @media (max-width: 720px) {
      .launcher { bottom: 14px; right: 14px; }
      .overlay { align-items: flex-end; padding: 10px; }
      .panel { border-radius: 18px 18px 12px 12px; padding: 20px; }
      .proxy-grid { grid-template-columns: 1fr; }
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
    element("span", { text: "Plus 优惠" })
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
      text: "Plus 优惠助手"
    }),
    element("p", {
      className: "subtitle",
      text: "先用 US 创建结账，再切换 TR 应用优惠。"
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

  const proxyToolbox = element("div", { className: "toolbox" });
  proxyToolbox.append(element("span", {
    className: "toolbox-title",
    text: "两阶段代理池"
  }));
  const proxyGrid = element("div", { className: "proxy-grid" });

  function createProxyCard({ id, title, badge, placeholder, ariaLabel }) {
    const card = element("div", { className: "proxy-card" });
    const cardTitle = element("div", { className: "proxy-card-title" });
    cardTitle.append(
      element("span", { text: title }),
      element("span", { className: "phase-badge", text: badge })
    );
    const input = element("textarea", {
      className: "input proxy-input",
      id
    });
    input.placeholder = placeholder;
    input.autocomplete = "off";
    input.autocapitalize = "off";
    input.spellcheck = false;
    input.setAttribute("aria-label", ariaLabel);
    const help = element("p", { className: "input-help", text: "每行 1 条，最多 500 条；自动保存在本机。" });
    card.append(cardTitle, input, help);
    return { card, input, help };
  }

  const createProxyCardParts = createProxyCard({
    id: "checkout-helper-proxy-create",
    title: "代理池 1",
    badge: "US · 创建",
    placeholder: "USER:PASSWORD@HOST:PORT",
    ariaLabel: "代理池 1，US 创建 Checkout"
  });
  const applyProxyCardParts = createProxyCard({
    id: "checkout-helper-proxy-apply",
    title: "代理池 2",
    badge: "TR · 优惠",
    placeholder: "USER:PASSWORD@HOST:PORT",
    ariaLabel: "代理池 2，TR 加载结账页应用优惠"
  });
  const createProxyInput = createProxyCardParts.input;
  const applyProxyInput = applyProxyCardParts.input;
  proxyGrid.append(createProxyCardParts.card, applyProxyCardParts.card);

  const proxyState = element("div", { className: "proxy-state" });
  const proxyStateText = element("span", { text: "当前代理：未由插件接管" });
  proxyState.append(proxyStateText);
  proxyToolbox.append(
    proxyGrid,
    element("ol", {
      className: "flow-list",
      text: ""
    }),
    proxyState
  );
  const flowList = proxyToolbox.querySelector(".flow-list");
  flowList.innerHTML = "<li>填写 US 和 TR 两组代理</li><li>插件自动创建并应用优惠</li><li>打开页面后确认今日应付金额为 0</li>";

  const notice = element("p", {
    className: "notice",
    text: "运行时会临时接管浏览器代理；结束后可点击“恢复代理”。优惠和最终金额以结账页为准。"
  });

  const linkToolbox = element("div", { className: "toolbox" });
  const officialLinkLabel = element("label", {
    className: "toolbox-title",
    text: "官方活动链接（可选）"
  });
  officialLinkLabel.setAttribute("for", "checkout-helper-official-link");
  const linkRow = element("div", { className: "link-row" });
  const officialLinkInput = element("input", {
    className: "input",
    type: "url",
    id: "checkout-helper-official-link"
  });
  officialLinkInput.placeholder = "https://chatgpt.com/...";
  officialLinkInput.autocomplete = "off";
  officialLinkInput.spellcheck = false;
  officialLinkInput.setAttribute("aria-label", "官方活动链接");
  const openOfficialLinkButton = element("button", {
    className: "button secondary compact",
    type: "button",
    text: "打开链接"
  });
  linkRow.append(officialLinkInput, openOfficialLinkButton);
  linkToolbox.append(
    officialLinkLabel,
    linkRow,
    element("p", {
      className: "input-help",
      text: "仅支持 chatgpt.com 或 openai.com 的 HTTPS 链接。"
    })
  );

  const diagnosticLabel = element("label", { className: "confirm" });
  const diagnosticCheckbox = element("input", { className: "checkbox", type: "checkbox" });
  diagnosticLabel.append(
    diagnosticCheckbox,
    element("span", {
      text: "显示诊断信息（已隐藏账号、令牌和代理凭据）"
    })
  );
  const diagnosticOutput = element("pre", { className: "diagnostic-output" });
  diagnosticOutput.hidden = true;
  diagnosticOutput.setAttribute("aria-live", "polite");

  const confirmLabel = element("label", { className: "confirm" });
  const confirmCheckbox = element("input", { className: "checkbox", type: "checkbox" });
  confirmLabel.append(
    confirmCheckbox,
    element("span", {
      text: "我已核对代理和结账信息。"
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
  const resetProxyButton = element("button", {
    className: "button secondary",
    type: "button",
    text: "恢复代理"
  });
  const submitButton = element("button", {
    className: "button primary",
    type: "button",
    text: "开始提取"
  });
  submitButton.disabled = true;
  actions.append(resetProxyButton, closeButton, submitButton);

  panel.append(
    header,
    sessionRow,
    details,
    proxyToolbox,
    linkToolbox,
    notice,
    diagnosticLabel,
    diagnosticOutput,
    confirmLabel,
    status,
    actions
  );
  overlay.append(panel);
  shadow.append(launcher, overlay);

  function setStatus(message = "", kind = "") {
    status.textContent = message;
    status.className = kind ? `status ${kind}` : "status";
  }

  function renderDiagnostic() {
    diagnosticOutput.hidden = !diagnosticCheckbox.checked;
    if (!diagnosticCheckbox.checked) return;
    diagnosticOutput.textContent = core.formatDiagnosticRecord(state.latestDiagnostic);
  }

  function recordDiagnostic(record) {
    state.latestDiagnostic = record;
    renderDiagnostic();
  }

  function getProxyStorageArea() {
    const storageArea = globalThis.chrome && chrome.storage && chrome.storage.local;
    return storageArea
      && typeof storageArea.get === "function"
      && typeof storageArea.set === "function"
      ? storageArea
      : null;
  }

  function readProxyCache(storageArea) {
    return new Promise((resolve, reject) => {
      try {
        storageArea.get(PROXY_CACHE_KEY, (items) => {
          const runtimeError = globalThis.chrome && chrome.runtime
            ? chrome.runtime.lastError
            : null;
          if (runtimeError) {
            reject(new Error(runtimeError.message));
            return;
          }
          resolve(items && items[PROXY_CACHE_KEY]);
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function writeProxyCache(storageArea, value) {
    return new Promise((resolve, reject) => {
      try {
        storageArea.set({ [PROXY_CACHE_KEY]: value }, () => {
          const runtimeError = globalThis.chrome && chrome.runtime
            ? chrome.runtime.lastError
            : null;
          if (runtimeError) {
            reject(new Error(runtimeError.message));
            return;
          }
          resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  function restoreProxyPoolCache() {
    if (state.proxyCachePromise) return state.proxyCachePromise;
    const storageArea = getProxyStorageArea();
    if (!storageArea) {
      state.proxyCachePromise = Promise.resolve();
      return state.proxyCachePromise;
    }

    state.proxyCachePromise = readProxyCache(storageArea)
      .then((cached) => {
        if (!cached || typeof cached !== "object") return;
        if (typeof cached.create === "string") createProxyInput.value = cached.create;
        if (typeof cached.apply === "string") applyProxyInput.value = cached.apply;
        getProxyPools();
        updateSubmitState();
      })
      .catch(() => undefined);
    return state.proxyCachePromise;
  }

  function scheduleProxyPoolCache() {
    const storageArea = getProxyStorageArea();
    if (!storageArea) return;
    if (state.proxyCacheTimer) clearTimeout(state.proxyCacheTimer);
    state.proxyCacheTimer = setTimeout(() => {
      state.proxyCacheTimer = null;
      void writeProxyCache(storageArea, {
        create: createProxyInput.value,
        apply: applyProxyInput.value
      }).catch(() => undefined);
    }, PROXY_CACHE_DELAY_MS);
  }

  function inspectProxyPool(input, help) {
    try {
      const pool = core.parseProxyPool(input.value);
      help.textContent = `已缓存 ${pool.length} 条代理，仅保存在本机。`;
      return pool;
    } catch (error) {
      help.textContent = input.value.trim()
        ? error.message
        : "每行 1 条，最多 500 条；自动保存在本机。";
      return null;
    }
  }

  function getProxyPools() {
    return {
      createPool: inspectProxyPool(createProxyInput, createProxyCardParts.help),
      applyPool: inspectProxyPool(applyProxyInput, applyProxyCardParts.help)
    };
  }

  function sendRuntimeMessage(message) {
    if (!globalThis.chrome || !chrome.runtime || typeof chrome.runtime.sendMessage !== "function") {
      const proxy = message.proxy ? core.parseProxyLine(message.proxy) : null;
      return Promise.resolve({
        ok: true,
        simulated: true,
        active: message.type === "checkout-helper:set-proxy",
        phase: message.phase || null,
        endpoint: proxy ? core.formatProxyEndpoint(proxy) : null
      });
    }

    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }
        if (!response || response.ok !== true) {
          reject(new Error(response && response.error ? response.error : "扩展后台没有返回有效结果"));
          return;
        }
        resolve(response);
      });
    });
  }

  async function recordLocalDiagnostic(event, details) {
    try {
      await sendRuntimeMessage({
        type: "checkout-helper:record-diagnostic",
        event,
        details
      });
    } catch {
      // Diagnostics never alter checkout behavior.
    }
  }

  function renderProxyState(proxyStatus) {
    state.activeProxy = proxyStatus && proxyStatus.active ? proxyStatus : null;
    if (!state.activeProxy) {
      proxyStateText.textContent = "当前代理：未由插件接管";
      resetProxyButton.disabled = true;
      launcher.querySelector(".spark").classList.remove("active");
      return;
    }
    const phaseLabel = state.activeProxy.phase === "create" ? "池 1 · 创建阶段" : "池 2 · 优惠阶段";
    const transportLabel = state.activeProxy.transport === "relay" ? "Mihomo 链式中继" : "直连网关";
    proxyStateText.textContent = `当前代理：${phaseLabel} · ${transportLabel} · ${state.activeProxy.endpoint || "已启用"}`;
    resetProxyButton.disabled = state.busy;
    launcher.querySelector(".spark").classList.add("active");
  }

  async function refreshProxyState() {
    try {
      const result = await sendRuntimeMessage({ type: "checkout-helper:get-proxy-status" });
      renderProxyState(result);
    } catch (error) {
      proxyStateText.textContent = `代理状态读取失败：${error.message}`;
    }
  }

  async function switchProxy(proxy, phase) {
    const result = await sendRuntimeMessage({
      type: "checkout-helper:set-proxy",
      phase,
      proxy: proxy.raw
    });
    renderProxyState(result);
    await new Promise((resolve) => setTimeout(resolve, 180));
    const connectivity = await sendRuntimeMessage({ type: "checkout-helper:test-proxy" });
    if (!connectivity.reachable) {
      throw new Error("代理连通性检查未通过");
    }
    return result;
  }

  async function clearProxy({ announce = true } = {}) {
    const result = await sendRuntimeMessage({ type: "checkout-helper:clear-proxy" });
    renderProxyState(result);
    if (announce) setStatus("已清除插件代理并恢复浏览器原有网络设置。", "success");
    return result;
  }

  function updateSubmitState() {
    const { createPool, applyPool } = getProxyPools();
    submitButton.disabled = state.busy
      || !state.loggedIn
      || !confirmCheckbox.checked
      || !createPool
      || !applyPool;
  }

  function setBusy(busy) {
    state.busy = busy;
    closeButton.disabled = busy;
    confirmCheckbox.disabled = busy;
    createProxyInput.disabled = busy;
    applyProxyInput.disabled = busy;
    officialLinkInput.disabled = busy;
    openOfficialLinkButton.disabled = busy;
    resetProxyButton.disabled = busy || !state.activeProxy;
    submitButton.textContent = busy ? "正在处理…" : "开始提取";
    updateSubmitState();
  }

  async function fetchJson(url, options = {}, stage = "network") {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        ...options,
        credentials: options.credentials || "include",
        signal: controller.signal
      });
      const payload = core.parseResponseText(await response.text());
      const diagnostic = core.createDiagnosticRecord({
        stage,
        status: response.status,
        payload,
        ok: response.ok
      });
      recordDiagnostic(diagnostic);

      if (!response.ok) {
        const requestError = new Error(core.formatApiError(payload, response.status));
        requestError.diagnostic = diagnostic;
        throw requestError;
      }

      return payload;
    } catch (error) {
      if (error && error.diagnostic) {
        throw error;
      }

      if (error && error.name === "AbortError") {
        const timeoutError = new Error("请求超时，请检查网络后重试。");
        timeoutError.name = "TimeoutError";
        timeoutError.diagnostic = core.createDiagnosticRecord({ stage, error: timeoutError });
        recordDiagnostic(timeoutError.diagnostic);
        throw timeoutError;
      }

      const networkError = error instanceof Error ? error : new Error(String(error));
      networkError.diagnostic = core.createDiagnosticRecord({ stage, error: networkError });
      recordDiagnostic(networkError.diagnostic);
      throw networkError;
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
      }, "session_check");
      state.loggedIn = Boolean(session && session.accessToken);
      sessionDot.className = state.loggedIn ? "dot ok" : "dot error";
      sessionText.textContent = state.loggedIn
        ? "已登录，可以创建结账会话"
        : "未检测到登录凭证，请先登录 ChatGPT";
      if (!state.loggedIn) {
        recordDiagnostic(core.createDiagnosticRecord({
          stage: "session_check",
          status: 401,
          payload: { message: "会话响应中没有可用的登录凭证" }
        }));
      }
    } catch (error) {
      sessionDot.className = "dot error";
      sessionText.textContent = "登录状态检测失败";
      setStatus(error instanceof Error ? error.message : String(error), "error");
    } finally {
      updateSubmitState();
    }
  }

  async function checkPromotionEligibility(accessToken, campaignId = core.CHECKOUT_CONFIG.campaignId) {
    const query = new URLSearchParams({
      coupon: campaignId,
      is_coupon_from_query_param: "false"
    }).toString();
    const candidates = [
      `/backend-api/payments/promo_campaign/check_coupon?${query}`,
      `/backend-api/promo_campaign/check_coupon?${query}`
    ];
    let lastError = null;
    for (const url of candidates) {
      try {
        const payload = await fetchJson(url, {
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${accessToken}`
          }
        }, "promotion_check");
        return { endpoint: new URL(url, "https://chatgpt.com").pathname, payload };
      } catch (error) {
        lastError = error;
        const status = error && error.diagnostic ? error.diagnostic.httpStatus : null;
        if (status !== 404) break;
      }
    }
    return {
      endpoint: "unavailable",
      error: core.sanitizeDiagnosticText(lastError && lastError.message, 240)
    };
  }

  function promotionCheckIsEligible(result) {
    const payload = result && result.payload;
    if (!payload || typeof payload !== "object") return false;
    if (payload.eligible === true || payload.is_eligible === true) return true;
    const stateValue = [payload.state, payload.status, payload.eligibility]
      .find((value) => typeof value === "string");
    return typeof stateValue === "string" && /^(eligible|available|active)$/i.test(stateValue.trim());
  }

  async function fetchAccountPromotionContext(accessToken, preferredAccountId = "") {
    const query = new URLSearchParams({
      timezone_offset_min: new Date().getTimezoneOffset().toString()
    }).toString();
    const payload = await fetchJson(`/backend-api/accounts/check/v4-2023-04-27?${query}`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`
      }
    }, "account_promotion_context");
    return core.resolveAccountPromotionContext(payload, { preferredAccountId });
  }

  async function fetchPaymentMethodsPreflight(accessToken, accountId) {
    if (!accountId) return core.summarizePaymentMethodsPreflight({});
    const query = new URLSearchParams({ account_id: accountId }).toString();
    const payload = await fetchJson(`/backend-api/payments/payment_methods?${query}`, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`
      }
    }, "payment_methods_preflight");
    return core.summarizePaymentMethodsPreflight(payload);
  }

  async function discoverPromotionCampaign(accessToken, accountContext) {
    const accountCampaign = core.selectPlusPromotionCampaign(accountContext);
    return Object.freeze({
      selectedCampaignId: accountCampaign,
      checks: Object.freeze([]),
      strategy: accountContext?.eligibleCampaignIds?.length
        ? "account_status_campaign"
        : "direct_ph_short_campaign"
    });
  }

  function openDialog() {
    overlay.hidden = false;
    launcher.hidden = true;
    void restoreProxyPoolCache();
    confirmCheckbox.checked = false;
    diagnosticCheckbox.checked = false;
    state.latestDiagnostic = null;
    renderDiagnostic();
    setStatus();
    updateSubmitState();
    void refreshProxyState();
    void checkSession();
    closeButton.focus();
  }

  function openOfficialActivityLink() {
    const validation = core.validateOfficialActivityUrl(officialLinkInput.value);
    if (!validation.ok) {
      const diagnostic = core.createDiagnosticRecord({
        stage: "official_link",
        status: 400,
        payload: { message: validation.error }
      });
      recordDiagnostic(diagnostic);
      setStatus(validation.error, "error");
      return;
    }

    recordDiagnostic(core.createDiagnosticRecord({ stage: "official_link", status: 200, ok: true }));
    setStatus("已在新标签页打开官方活动链接。", "success");
    window.open(validation.url, "_blank", "noopener,noreferrer");
  }

  function closeDialog() {
    if (state.busy) return;
    overlay.hidden = true;
    launcher.hidden = false;
    launcher.focus();
  }

  async function createCheckoutSession() {
    if (state.busy || !confirmCheckbox.checked) return;

    const { createPool, applyPool } = getProxyPools();
    if (!createPool || !applyPool) {
      setStatus("请先修正两个代理池的输入。", "error");
      return;
    }

    const createProxy = core.selectProxyFromPool(createPool, state.createPoolCursor);
    const applyProxy = core.selectProxyFromPool(applyPool, state.applyPoolCursor);

    setBusy(true);
    setStatus(`步骤 1/3：正在通过代理池 1（${core.formatProxyEndpoint(createProxy)}）创建 Checkout…`);

    let accessToken = null;
    try {
      await switchProxy(createProxy, "create");
      state.createPoolCursor += 1;
      recordDiagnostic(core.createDiagnosticRecord({ stage: "proxy_create", status: 200, ok: true }));

      const session = await fetchJson("/api/auth/session", {
        headers: { Accept: "application/json" }
      }, "session_refresh");
      accessToken = session && session.accessToken;

      if (!accessToken) {
        state.loggedIn = false;
        const authenticationError = new Error("当前会话没有登录凭证，请重新登录后再试。");
        authenticationError.diagnostic = core.createDiagnosticRecord({
          stage: "session_refresh",
          status: 401,
          payload: { message: authenticationError.message }
        });
        recordDiagnostic(authenticationError.diagnostic);
        throw authenticationError;
      }

      setStatus("步骤 1/3：正在创建不带活动字段的 PH/PHP 基线 Checkout…");
      const baselineCheckout = await fetchJson("/backend-api/payments/checkout", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Accept-Language": "zh-CN,zh;q=0.9",
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(core.buildBaselineCheckoutPayload())
      }, "checkout_baseline");
      await recordLocalDiagnostic("checkout_baseline", {
        shape: core.describeCheckoutResponseShape(baselineCheckout),
        requestShape: "entry_point,plan_name,billing_details,checkout_ui_mode,locale",
        identifiers: core.describeCheckoutIdentifiers(baselineCheckout),
        promotion: core.summarizePromotionState(baselineCheckout)
      });

      setStatus(`步骤 2/3：基线已创建，正在切换代理池 2（${core.formatProxyEndpoint(applyProxy)}）并由 TR 服务端应用活动…`);
      await switchProxy(applyProxy, "apply");
      state.applyPoolCursor += 1;
      recordDiagnostic(core.createDiagnosticRecord({ stage: "proxy_apply", status: 200, ok: true }));

      const applySession = await fetchJson("/api/auth/session", {
        headers: { Accept: "application/json" }
      }, "session_apply_refresh");
      accessToken = applySession && applySession.accessToken ? applySession.accessToken : accessToken;
      if (!accessToken) throw new Error("优惠阶段会话没有登录凭证");

      let accountContext = core.resolveAccountPromotionContext({});
      try {
        accountContext = await fetchAccountPromotionContext(
          accessToken,
          core.getSessionAccountId(applySession)
        );
        await recordLocalDiagnostic("account_promotion_context", {
          promotion: core.summarizeAccountPromotionContext(accountContext)
        });
      } catch (accountError) {
        await recordLocalDiagnostic("account_promotion_context", {
          message: core.sanitizeDiagnosticText(accountError && accountError.message, 200),
          promotion: core.summarizeAccountPromotionContext(accountContext)
        });
      }

      let paymentPreflight = core.summarizePaymentMethodsPreflight({});
      try {
        paymentPreflight = await fetchPaymentMethodsPreflight(accessToken, accountContext.accountId);
      } catch (paymentError) {
        await recordLocalDiagnostic("payment_methods_preflight", {
          message: core.sanitizeDiagnosticText(paymentError && paymentError.message, 200)
        });
      }
      await recordLocalDiagnostic("payment_methods_preflight", {
        promotion: core.sanitizeDiagnosticText(paymentPreflight, 1000)
      });

      const campaignDiscovery = await discoverPromotionCampaign(accessToken, accountContext);
      const selectedCampaignId = campaignDiscovery.selectedCampaignId;
      await recordLocalDiagnostic("promotion_eligibility", {
        promotion: core.sanitizeDiagnosticText({
          selected_campaign_id: selectedCampaignId,
          account_campaign_ids: accountContext.eligibleCampaignIds,
          one_click_trial_eligible: paymentPreflight.oneClickTrialEligible,
          strategy: campaignDiscovery.strategy,
          checks: campaignDiscovery.checks
        }, 2400)
      });
      let checkout = null;
      let oaicsSessionId = "";
      let promotionApplied = false;
      let lastCheckout = null;
      const attemptKinds = [];

      const baselineOaicsSessionId = core.extractOpenAICheckoutSessionId(baselineCheckout);
      if (baselineOaicsSessionId) {
        setStatus(`步骤 2/3：正在通过 TR 将 ${selectedCampaignId} 应用到 US 阶段创建的同一 OAICS Checkout…`);
        try {
          const updatedCheckout = await fetchJson("/backend-api/payments/checkout/update", {
            method: "POST",
            headers: {
              Accept: "application/json",
              "Accept-Language": "zh-CN,zh;q=0.9",
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify(core.buildPromotionUpdatePayload({
              checkoutSessionId: baselineOaicsSessionId,
              processorEntity: "openai_llc",
              campaignId: selectedCampaignId
            }))
          }, "checkout_promotion_update");
          lastCheckout = updatedCheckout;
          const updatedOaics = core.extractOpenAICheckoutSessionId(updatedCheckout) || baselineOaicsSessionId;
          const updateApplied = core.hasAppliedPromotion(updatedCheckout);
          await recordLocalDiagnostic("checkout_attempt_state", {
            route: "POST /payments/checkout/update · existing US OAICS through TR",
            requestShape: "checkout_session_id,processor_entity,plan_name,price_interval,seat_quantity,promo_campaign",
            identifiers: core.describeCheckoutIdentifiers(updatedCheckout),
            promotion: core.summarizePromotionState(updatedCheckout)
          });
          attemptKinds.push(`ph_short_update_existing:${core.describeCheckoutIdentifiers(updatedCheckout)}:discount=${updateApplied ? "applied" : "missing"}`);
          if (updatedOaics && updateApplied) {
            checkout = {
              ...updatedCheckout,
              checkout_session_id: updatedOaics,
              processor_entity: "openai_llc"
            };
            oaicsSessionId = updatedOaics;
            promotionApplied = true;
          }
        } catch (updateError) {
          await recordLocalDiagnostic("checkout_attempt_state", {
            route: "POST /payments/checkout/update · existing US OAICS through TR",
            requestShape: "checkout_session_id,processor_entity,plan_name,price_interval,seat_quantity,promo_campaign",
            message: core.sanitizeDiagnosticText(updateError && updateError.message, 200)
          });
          attemptKinds.push(`ph_short_update_existing:error=${core.sanitizeDiagnosticText(updateError && updateError.message, 160)}`);
        }
      } else {
        attemptKinds.push("ph_short_update_existing:baseline_missing_oaics");
      }

      if (!promotionApplied) {
        setStatus("步骤 2/3：同会话更新尚未应用折扣，正在生成官方 Sentinel 校验头继续比对创建路径…");
        const sentinelContext = await sendRuntimeMessage({
          type: "checkout-helper:get-sentinel-headers"
        });
        const sentinelHeaders = sentinelContext && sentinelContext.headers && typeof sentinelContext.headers === "object"
          ? sentinelContext.headers
          : {};
        const sentinelHeaderNames = Array.isArray(sentinelContext && sentinelContext.headerNames)
          ? sentinelContext.headerNames.filter((name) => ["OpenAI-Sentinel-Token", "OAI-Telemetry"].includes(name))
          : [];
        if (typeof sentinelHeaders["OpenAI-Sentinel-Token"] !== "string" || !sentinelHeaders["OpenAI-Sentinel-Token"]) {
          throw new Error("官方结账校验头生成失败");
        }
        await recordLocalDiagnostic("sentinel_checkout", {
          identifiers: `flow=chatgpt_checkout headers=${sentinelHeaderNames.join(",")}`,
          promotion: core.sanitizeDiagnosticText({
            sentinel_token_present: true,
            telemetry_present: typeof sentinelHeaders["OAI-Telemetry"] === "string" && Boolean(sentinelHeaders["OAI-Telemetry"]),
            token_value_recorded: false
          }, 600)
        });

        const promotionAttempts = [
          {
            name: "ph_short_official_sentinel",
            payload: core.buildPhShortPromotionPayload({ campaignId: selectedCampaignId })
          },
          {
            name: "official_custom_sentinel",
            payload: core.buildPromotionCheckoutPayload({
              campaignId: selectedCampaignId,
              oneClickTrial: false
            })
          }
        ];
        for (const attempt of promotionAttempts) {
          let candidate;
          try {
            candidate = await fetchJson("/backend-api/payments/checkout", {
              method: "POST",
              headers: {
                Accept: "application/json",
                "Accept-Language": "zh-CN,zh;q=0.9",
                Authorization: `Bearer ${accessToken}`,
                ...sentinelHeaders,
                "Content-Type": "application/json"
              },
              body: JSON.stringify(attempt.payload)
            }, "checkout_promotion");
          } catch (attemptError) {
            attemptKinds.push(`${attempt.name}:error=${core.sanitizeDiagnosticText(attemptError && attemptError.message, 120)}`);
            continue;
          }
          lastCheckout = candidate;
          const candidateOaics = core.extractOpenAICheckoutSessionId(candidate);
          const candidatePromotionApplied = core.hasAppliedPromotion(candidate);
          await recordLocalDiagnostic("checkout_attempt_state", {
            route: `POST /payments/checkout · ${attempt.name}`,
            requestShape: Object.keys(attempt.payload).sort().join(","),
            identifiers: core.describeCheckoutIdentifiers(candidate),
            promotion: core.summarizePromotionState(candidate)
          });
          attemptKinds.push(`${attempt.name}:${core.describeCheckoutIdentifiers(candidate)}:discount=${candidatePromotionApplied ? "applied" : "missing"}`);
          if (candidateOaics && candidatePromotionApplied) {
            checkout = candidate;
            oaicsSessionId = candidateOaics;
            promotionApplied = true;
            break;
          }
        }
      }
      accessToken = null;

      await recordLocalDiagnostic("checkout_provider_attempts", {
        identifiers: core.sanitizeDiagnosticText(attemptKinds.join(" | "), 1000),
        promotion: core.sanitizeDiagnosticText({
          selected_campaign_id: selectedCampaignId,
          one_click_trial_eligible: paymentPreflight.oneClickTrialEligible,
          promotion_applied: promotionApplied
        }, 1000)
      });
      if (!checkout || !oaicsSessionId || !promotionApplied) {
        if (lastCheckout) core.requireOpenAICheckoutSession(lastCheckout);
        throw new Error("服务端返回了 Checkout，但折扣仍为 0；已停止打开未应用优惠的页面");
      }

      const checkoutShape = core.describeCheckoutResponseShape(checkout);
      await recordLocalDiagnostic("checkout_response", {
        shape: checkoutShape,
        requestShape: `PH_SHORT:update-existing-oaics,plan_name,price_interval,seat_quantity,promo_campaign(${selectedCampaignId})`,
        identifiers: core.describeCheckoutIdentifiers(checkout),
        promotion: core.summarizePromotionState(checkout)
      });

      let checkoutUrl = "";
      let checkoutRoute = "服务端 Hosted URL";
      let stripeInitContext = null;
      try {
        checkoutUrl = core.resolveHostedCheckoutUrl(checkout);
      } catch (error) {
        stripeInitContext = core.getStripeInitContext(checkout);
        checkoutRoute = "";
      }

      setStatus("步骤 3/3：TR 服务端已返回 oaics_*，正在打开官方内部优惠结账页…");

      if (!checkoutUrl && stripeInitContext) {
        let stripeFailure = null;
        const internalCheckoutUrl = core.buildInternalCheckoutUrl(checkout);
        if (internalCheckoutUrl) {
          checkoutUrl = internalCheckoutUrl;
          checkoutRoute = "ChatGPT 官方内部结账页";
        } else if (stripeInitContext.stripeCompatible) {
          try {
            const stripeResult = await sendRuntimeMessage({
              type: "checkout-helper:stripe-init",
              sessionId: stripeInitContext.sessionId,
              publishableKey: stripeInitContext.publishableKey,
              locale: stripeInitContext.locale
            });
            checkoutUrl = core.resolveHostedCheckoutUrl({ url: stripeResult.hostedUrl });
            checkoutRoute = "Stripe init Hosted URL";
            recordDiagnostic(core.createDiagnosticRecord({ stage: "stripe_init", status: stripeResult.httpStatus || 200, ok: true }));
          } catch (stripeError) {
            stripeFailure = stripeError;
            recordDiagnostic(core.createDiagnosticRecord({ stage: "stripe_init", error: stripeError }));
          }
        }
        if (!checkoutUrl) {
          const clientSecretUrl = core.buildClientSecretCheckoutUrl(checkout);
          checkoutUrl = clientSecretUrl;
          checkoutRoute = "client_secret 长链";
          if (!checkoutUrl) throw stripeFailure || new Error("Checkout 响应中没有可导航的会话路径");
        }
      }

      await recordLocalDiagnostic("checkout_route", {
        shape: checkoutShape,
        identifiers: core.describeCheckoutIdentifiers(checkout),
        route: checkoutRoute,
        sessionKind: stripeInitContext && stripeInitContext.stripeCompatible ? "stripe" : "hosted-or-opaque"
      });

      setStatus(`三步链路完成（${checkoutRoute}），正在通过代理池 2 打开带活动字段的支付页…`, "success");
      await new Promise((resolve) => setTimeout(resolve, 220));
      window.location.assign(checkoutUrl);
    } catch (error) {
      accessToken = null;
      const message = error instanceof Error ? error.message : String(error);
      await recordLocalDiagnostic("checkout_error", {
        message: core.sanitizeDiagnosticText(message, 200)
      });
      try {
        await clearProxy({ announce: false });
        setStatus(`${message}；已自动恢复代理设置。`, "error");
      } catch (restoreError) {
        setStatus(`${message}；代理恢复失败：${restoreError.message}`, "error");
      }
      setBusy(false);
    }
  }

  launcher.addEventListener("click", openDialog);
  closeButton.addEventListener("click", closeDialog);
  confirmCheckbox.addEventListener("change", updateSubmitState);
  createProxyInput.addEventListener("input", () => {
    updateSubmitState();
    scheduleProxyPoolCache();
  });
  applyProxyInput.addEventListener("input", () => {
    updateSubmitState();
    scheduleProxyPoolCache();
  });
  diagnosticCheckbox.addEventListener("change", renderDiagnostic);
  openOfficialLinkButton.addEventListener("click", openOfficialActivityLink);
  resetProxyButton.addEventListener("click", () => {
    setBusy(true);
    void clearProxy().catch((error) => {
      setStatus(`代理恢复失败：${error.message}`, "error");
    }).finally(() => setBusy(false));
  });
  submitButton.addEventListener("click", () => void createCheckoutSession());
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeDialog();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !overlay.hidden) closeDialog();
  });

  void restoreProxyPoolCache();

  async function inspectCurrentCheckoutRoute() {
    const route = typeof window.location.pathname === "string"
      ? window.location.pathname.match(/^\/checkout\/([^/]+)\/(oaics_[A-Za-z0-9_-]{12,160})\/?$/)
      : null;
    if (!route) return;
    try {
      const session = await fetchJson("/api/auth/session", {
        headers: { Accept: "application/json" }
      }, "existing_checkout_session_refresh");
      const accessToken = session && session.accessToken;
      const processorEntity = encodeURIComponent(route[1]);
      const checkoutSessionId = encodeURIComponent(route[2]);
      const payload = await fetchJson(
        `/backend-api/payments/checkout/${processorEntity}/${checkoutSessionId}`,
        {
          headers: {
            Accept: "application/json",
            ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {})
          }
        },
        "checkout_existing_session"
      );
      await recordLocalDiagnostic("checkout_existing_session", {
        shape: core.describeCheckoutResponseShape(payload),
        identifiers: core.describeCheckoutIdentifiers(payload),
        promotion: core.summarizePromotionState(payload)
      });
    } catch (error) {
      await recordLocalDiagnostic("checkout_existing_session", {
        message: core.sanitizeDiagnosticText(error && error.message, 200)
      });
    }
  }

  void inspectCurrentCheckoutRoute();

  if (typeof window.location.href === "string"
      && new URL(window.location.href).searchParams.get("checkout_helper_contract_probe") === "1") {
    setTimeout(() => {
      const urls = [
        ...Array.from(document.scripts || []).map((script) => script.src),
        ...Array.from(document.querySelectorAll('link[rel="modulepreload"], link[rel="preload"][as="script"]'))
          .map((link) => link.href)
      ].filter(Boolean);
      void sendRuntimeMessage({ type: "checkout-helper:inspect-contract", urls }).catch(() => undefined);
    }, 1800);
  }
})();
