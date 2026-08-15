"use strict";

const WEBUI_BUILD = "20260811-23-protocol-registration-any-pool";
window.__PLUS_EXTRACTOR_WEBUI_BUILD__ = WEBUI_BUILD;

const API_BASE = localStorage.getItem("plusExtractorApiBase") || "http://127.0.0.1:17890";
const FAILURE_SELECTION_GROUPS = Object.freeze([
  Object.freeze({
    stage: "registration",
    label: "注册失败",
    states: Object.freeze(["REGISTERING_BLOCKED", "REGISTRATION_BLOCKED", "REGISTRATION_FAILED"])
  }),
  Object.freeze({
    stage: "checkout_link",
    label: "提链失败",
    states: Object.freeze(["CHECKOUT_LINK_BLOCKED", "EXTRACTION_FAILED"])
  }),
  Object.freeze({
    stage: "card_binding",
    label: "绑卡失败",
    states: Object.freeze(["CARD_BINDING_BLOCKED", "CARD_BINDING_FAILED"])
  }),
  Object.freeze({
    stage: "trial_payment",
    label: "订阅失败",
    states: Object.freeze(["TRIAL_PAYMENT_BLOCKED", "TRIAL_PAYMENT_FAILED"])
  })
]);
const state = {
  bootstrap: null,
  selectedTaskId: null,
  selectedExportTaskIds: new Set(),
  refreshing: false,
  batchRunning: false,
  cardBindingSession: null,
  activeTab: "workflow",
  plusVerifying: false,
  plusVerification: null,
  operationSettingsSaving: false,
  operationSettingsDirty: false
};

const elements = {
  health: document.querySelector("#health"),
  healthText: document.querySelector("#health-text"),
  apiAddress: document.querySelector("#api-address"),
  proxyForm: document.querySelector("#proxy-form"),
  proxyMessage: document.querySelector("#proxy-message"),
  registrationPool: document.querySelector("#registration-pool"),
  usPool: document.querySelector("#us-pool"),
  trPool: document.querySelector("#tr-pool"),
  registrationCount: document.querySelector("#registration-count"),
  usCount: document.querySelector("#us-count"),
  trCount: document.querySelector("#tr-count"),
  registrationEndpoints: document.querySelector("#registration-endpoints"),
  usEndpoints: document.querySelector("#us-endpoints"),
  trEndpoints: document.querySelector("#tr-endpoints"),
  registrationProbe: document.querySelector("#registration-probe"),
  usProbe: document.querySelector("#us-probe"),
  trProbe: document.querySelector("#tr-probe"),
  pipeline: document.querySelector("#pipeline"),
  taskList: document.querySelector("#task-list"),
  taskDetail: document.querySelector("#task-detail"),
  registrationForm: document.querySelector("#registration-form"),
  accountImportFormat: document.querySelector("#account-import-format"),
  accountSource: document.querySelector("#account-source"),
  accountSourceLabel: document.querySelector("#account-source-label"),
  accountImportNote: document.querySelector("#account-import-note"),
  mailboxProbeButton: document.querySelector("#mailbox-probe-button"),
  registrationMessage: document.querySelector("#registration-message"),
  registrationMode: document.querySelector("#registration-mode"),
  registrationModeButtons: [...document.querySelectorAll("[data-registration-mode]")],
  maxAccountOperations: document.querySelector("#max-account-operations"),
  operationSettingsSave: document.querySelector("#operation-settings-save"),
  operationSettingsSummary: document.querySelector("#operation-settings-summary"),
  roxyBrowserStatus: document.querySelector("#roxy-browser-status"),
  createTaskButton: document.querySelector("#create-task-button"),
  refreshButton: document.querySelector("#refresh-button"),
  exportSelectAll: document.querySelector("#export-select-all"),
  exportFormat: document.querySelector("#export-format"),
  exportAccountsButton: document.querySelector("#export-accounts-button"),
  exportCount: document.querySelector("#account-export-count"),
  exportMessage: document.querySelector("#account-export-message"),
  batchMessage: document.querySelector("#account-batch-message"),
  selectFailedButton: document.querySelector("#select-failed-button"),
  batchRetryCount: document.querySelector("#batch-retry-count"),
  batchRegisterButton: document.querySelector("#batch-register-button"),
  batchExtractButton: document.querySelector("#batch-extract-button"),
  batchCardProfileButton: document.querySelector("#batch-card-profile-button"),
  batchCardBindButton: document.querySelector("#batch-card-bind-button"),
  batchSubscribeButton: document.querySelector("#batch-subscribe-button"),
  batchLimitNote: document.querySelector("#batch-limit-note"),
  sharedCardSection: document.querySelector("#shared-card-binding-section"),
  sharedCardCount: document.querySelector("#shared-card-binding-count"),
  sharedCardMount: document.querySelector("#shared-stripe-card"),
  sharedCardMessage: document.querySelector("#shared-card-binding-message"),
  sharedCardReload: document.querySelector("#batch-card-reload"),
  sharedCardSubmit: document.querySelector("#batch-card-submit"),
  tabs: [...document.querySelectorAll("[data-tab]")],
  tabPanels: [...document.querySelectorAll("[data-tab-panel]")],
  plusSessionSource: document.querySelector("#plus-session-source"),
  plusFileInput: document.querySelector("#plus-file-input"),
  plusFileButton: document.querySelector("#plus-file-button"),
  plusClearButton: document.querySelector("#plus-clear-button"),
  plusVerifyButton: document.querySelector("#plus-verify-button"),
  plusMessage: document.querySelector("#plus-verification-message"),
  plusResults: document.querySelector("#plus-results"),
  plusSummaryRequested: document.querySelector("#plus-summary-requested"),
  plusSummaryActive: document.querySelector("#plus-summary-active"),
  plusSummaryInactive: document.querySelector("#plus-summary-inactive"),
  plusSummaryFailed: document.querySelector("#plus-summary-failed"),
  toast: document.querySelector("#toast")
};

elements.apiAddress.textContent = API_BASE;

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({ ok: false, message: `HTTP ${response.status}` }));
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.message || payload.error || `HTTP ${response.status}`);
    error.code = payload.error;
    throw error;
  }
  return payload;
}

function setHealth(online, text) {
  elements.health.dataset.state = online ? "online" : "offline";
  elements.healthText.textContent = text;
}

function maximumAccountOperations() {
  const configured = Number(
    state.bootstrap
    && state.bootstrap.operationSettings
    && state.bootstrap.operationSettings.maxAccountOperations
  );
  return Number.isInteger(configured) && configured >= 1 && configured <= 30 ? configured : 10;
}

function renderOperationSettings() {
  if (!state.bootstrap) return;
  const settings = state.bootstrap.operationSettings || {};
  const roxy = state.bootstrap.roxyBrowser || {};
  const configuredMaximum = maximumAccountOperations();
  const pendingMaximum = Number(elements.maxAccountOperations.value);
  const maximum = state.operationSettingsDirty
    && Number.isInteger(pendingMaximum)
    && pendingMaximum >= 1
    && pendingMaximum <= 30
    ? pendingMaximum
    : configuredMaximum;
  const windows = Math.ceil(maximum / 2);
  const configuredProxyProfiles = Number.isFinite(Number(roxy.configuredProxyProfiles))
    ? Number(roxy.configuredProxyProfiles)
    : Number(roxy.availableProfiles || 0);
  const availableConfiguredProfiles = Number.isFinite(Number(roxy.availableConfiguredProfiles))
    ? Number(roxy.availableConfiguredProfiles)
    : configuredProxyProfiles;
  if (!state.operationSettingsDirty) {
    elements.maxAccountOperations.value = String(configuredMaximum);
  }
  const savedMode = settings.registrationMode === "roxybrowser" ? "roxybrowser" : "protocol";
  const selectedMode = state.operationSettingsDirty && elements.registrationMode.value === "roxybrowser"
    ? "roxybrowser"
    : state.operationSettingsDirty
      ? "protocol"
      : savedMode;
  elements.registrationMode.value = selectedMode;
  for (const button of elements.registrationModeButtons) {
    const selected = button.dataset.registrationMode === selectedMode;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-pressed", String(selected));
    button.disabled = state.operationSettingsSaving;
  }
  const modeLabel = selectedMode === "roxybrowser" ? "RoxyBrowser WebUI" : "协议注册";
  const proxyModeLabel = selectedMode === "roxybrowser"
    ? "复用每个 Roxy 窗口已配置的代理，不改写窗口代理"
    : "使用平台任意地区注册代理池";
  elements.operationSettingsSummary.textContent = state.operationSettingsDirty
    ? `待保存：${modeLabel}；N=${maximum} 个账号/轮；${proxyModeLabel}。`
    : `${modeLabel}；N=${maximum} 个账号/轮；${proxyModeLabel}。RoxyBrowser 使用 ${windows} 个窗口，每窗口顺序处理 2 个账号。`;
  const roxyCapacityReady = roxy.ready && availableConfiguredProfiles >= windows;
  elements.roxyBrowserStatus.textContent = roxy.ready
    ? `RoxyBrowser ${roxy.version || ""} 已连接：可见配置 ${roxy.availableProfiles || 0} 个，其中 ${configuredProxyProfiles} 个已配置代理、${availableConfiguredProfiles} 个当前空闲，当前打开 ${roxy.openedProfiles || 0} 个；当前 N 需要 ${windows} 个空闲窗口。WebUI 注册保留窗口现有代理，并在提交邮箱前校验 JP 出口。`
    : `RoxyBrowser 本地控制未连接（${roxy.error || "ROXY_BRIDGE_UNAVAILABLE"}）。`;
  elements.roxyBrowserStatus.className = `operation-settings-status ${roxyCapacityReady ? "ready" : "pending"}`;
  elements.operationSettingsSave.disabled = state.operationSettingsSaving;
  elements.maxAccountOperations.disabled = state.operationSettingsSaving;
  elements.batchLimitNote.textContent = `每轮最多 ${maximum} 个账号；注册、绑卡提链和同步订阅共用该账号数上限。Roxy 注册对应 ${windows} 个窗口，每窗口 2 个账号，使用窗口自身已配置代理。`;
  if (elements.accountImportFormat.value !== "access_token") {
    elements.accountImportNote.textContent = selectedMode === "roxybrowser"
      ? "RoxyBrowser WebUI 注册复用每个窗口已配置的代理，不改写窗口代理；提交邮箱前仍校验该窗口出口为 JP。"
      : "协议注册使用平台任意地区代理池；同一次注册会校验 ChatGPT 与 Auth 出口国家一致。账户姓名自动生成为 First Last，年龄随机为 20–40 岁。";
  }
  updateRegistrationActions();
}

function selectTab(tabName) {
  const selected = tabName === "plus" ? "plus" : "workflow";
  state.activeTab = selected;
  localStorage.setItem("plusExtractorActiveTab", selected);
  for (const tab of elements.tabs) {
    const active = tab.dataset.tab === selected;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  }
  for (const panel of elements.tabPanels) panel.hidden = panel.dataset.tabPanel !== selected;
}

let toastTimer;
function toast(message, kind = "") {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.className = kind ? `toast ${kind}` : "toast";
  elements.toast.hidden = false;
  toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 4_000);
}

function setProxyMessage(message = "", kind = "") {
  elements.proxyMessage.textContent = message;
  elements.proxyMessage.className = kind ? `form-message ${kind}` : "form-message";
}

function setRegistrationMessage(message = "", kind = "") {
  elements.registrationMessage.textContent = message;
  elements.registrationMessage.className = kind ? `form-message ${kind}` : "form-message";
}

function setPlusMessage(message = "", kind = "") {
  elements.plusMessage.textContent = message;
  elements.plusMessage.className = kind ? `form-message ${kind}` : "form-message";
}

function updatePlusControls() {
  const proxiesReady = Boolean(state.bootstrap && state.bootstrap.proxyPools && state.bootstrap.proxyPools.US.configured);
  const hasInput = Boolean(elements.plusSessionSource.value.trim());
  elements.plusVerifyButton.disabled = state.plusVerifying || !hasInput || !proxiesReady;
  elements.plusFileButton.disabled = state.plusVerifying;
  elements.plusClearButton.disabled = state.plusVerifying || (!hasInput && !state.plusVerification);
}

function normalizeRawAccessTokenLine(value) {
  let token = String(value || "").trim();
  for (let pass = 0; pass < 3; pass += 1) {
    const before = token;
    const assignment = token.match(/^(?:access[_-]?token|at)\s*[:=]\s*(.+)$/i);
    if (assignment) token = assignment[1].trim();
    token = token.replace(/^Bearer[ \t]+/i, "").trim();
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
      try {
        const parsed = JSON.parse(token);
        if (typeof parsed === "string") token = parsed.trim();
      } catch {
        if (token.startsWith("'") && token.endsWith("'")) token = token.slice(1, -1).trim();
      }
    }
    if (token === before) break;
  }
  if (token.length < 20 || token.length > 20_000) return "";
  return /^[A-Za-z0-9._~+\/-]+=*$/.test(token) ? token : "";
}

function parsePlusSessionSource(source) {
  const value = String(source || "").trim();
  if (!value) throw new Error("请导入至少一条完整 Session JSON 或 Access Token。");
  try {
    const whole = JSON.parse(value);
    if (Array.isArray(whole)) return whole;
    if (whole && typeof whole === "object") return [whole];
    if (typeof whole === "string") {
      const accessToken = normalizeRawAccessTokenLine(whole);
      if (accessToken) return [{ accessToken }];
    }
  } catch {
    // JSONL is parsed line by line below.
  }
  const lines = value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.map((line, index) => {
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
      return parsed;
    } catch {
      const accessToken = normalizeRawAccessTokenLine(line);
      if (accessToken) return { accessToken };
      throw new Error(`第 ${index + 1} 行不是有效的 Session JSON 或 Access Token。`);
    }
  });
}

function resetPlusResults() {
  state.plusVerification = null;
  elements.plusSummaryRequested.textContent = "0";
  elements.plusSummaryActive.textContent = "0";
  elements.plusSummaryInactive.textContent = "0";
  elements.plusSummaryFailed.textContent = "0";
  elements.plusResults.replaceChildren();
  const empty = document.createElement("div");
  empty.className = "empty-state";
  empty.textContent = "导入 Session JSON 或 Access Token 后开始验证。";
  elements.plusResults.append(empty);
}

function renderPlusResults(verification) {
  state.plusVerification = verification;
  elements.plusSummaryRequested.textContent = String(verification.requested || 0);
  elements.plusSummaryActive.textContent = String(verification.plusActive || 0);
  elements.plusSummaryInactive.textContent = String(verification.noPlus || 0);
  elements.plusSummaryFailed.textContent = String(verification.failed || 0);
  elements.plusResults.replaceChildren();

  const header = document.createElement("div");
  header.className = "plus-result-header";
  for (const label of ["序号", "账号", "结果", "套餐", "权益详情"]) {
    const cell = document.createElement("span");
    cell.textContent = label;
    header.append(cell);
  }
  elements.plusResults.append(header);

  for (const result of verification.results || []) {
    const row = document.createElement("div");
    row.className = "plus-result-row";
    const index = document.createElement("span");
    index.textContent = String(Number(result.index) + 1);
    const email = document.createElement("code");
    email.textContent = result.email || `第 ${Number(result.index) + 1} 条`;
    const status = document.createElement("span");
    status.className = `plus-result-status ${result.hasPlus ? "active" : result.ok ? "inactive" : "failed"}`;
    status.textContent = result.hasPlus ? "PLUS 已到账" : result.ok ? "未到账" : "验证失败";
    const plan = document.createElement("span");
    plan.textContent = result.ok ? result.plan || "free" : "—";
    const detail = document.createElement("span");
    detail.className = "plus-result-detail";
    if (!result.ok) detail.textContent = `${result.code || "PLUS_VERIFY_FAILED"} · ${result.message || "验证失败"}`;
    else if (result.hasPlus) {
      const dates = [result.trial ? "试用" : "订阅", result.renewsAt ? `续费 ${new Date(result.renewsAt).toLocaleString()}` : "", result.expiresAt ? `到期 ${new Date(result.expiresAt).toLocaleString()}` : ""].filter(Boolean);
      detail.textContent = dates.join(" · ");
    } else detail.textContent = result.hasActiveSubscription ? "存在其他有效订阅，但不是 Plus" : "没有有效 Plus 权益";
    row.append(index, email, status, plan, detail);
    elements.plusResults.append(row);
  }
}

async function verifyImportedPlusSessions() {
  let sessions;
  try {
    sessions = parsePlusSessionSource(elements.plusSessionSource.value);
  } catch (error) {
    setPlusMessage(error.message, "error");
    return;
  }
  const maximum = Number(state.bootstrap && state.bootstrap.plusVerification && state.bootstrap.plusVerification.maxBatchSize) || 500;
  if (sessions.length > maximum) {
    setPlusMessage(`单批最多导入 ${maximum} 条 Session JSON 或 Access Token。`, "error");
    return;
  }
  state.plusVerifying = true;
  updatePlusControls();
  elements.plusVerifyButton.textContent = `正在验证 ${sessions.length} 条…`;
  setPlusMessage(`正在按最多 10 路并发验证 ${sessions.length} 个账号；结果仅保留脱敏权益字段。`);
  try {
    const payload = await api("/api/plus-verification", {
      method: "POST",
      body: JSON.stringify({ sessions })
    });
    renderPlusResults(payload.verification);
    const result = payload.verification;
    setPlusMessage(`验证完成：Plus 已到账 ${result.plusActive}，未到账 ${result.noPlus}，失败 ${result.failed}。`, result.failed ? "error" : "success");
    toast(`Plus 验证完成 ${result.plusActive}/${result.requested}`);
  } catch (error) {
    setPlusMessage(error.message || String(error), "error");
  } finally {
    state.plusVerifying = false;
    elements.plusVerifyButton.textContent = "开始批量验证";
    updatePlusControls();
  }
}

function updateRegistrationActions() {
  const pools = state.bootstrap && state.bootstrap.proxyPools;
  const registrationMode = elements.registrationMode.value === "roxybrowser" ? "roxybrowser" : "protocol";
  const roxy = state.bootstrap && state.bootstrap.roxyBrowser;
  const protocolRegistrationReady = Boolean(pools && pools.REGISTRATION && pools.REGISTRATION.configured);
  const requiredRoxyWindows = Math.ceil(maximumAccountOperations() / 2);
  const roxyProxyCapacity = roxy && Number.isFinite(Number(roxy.availableConfiguredProfiles))
    ? Number(roxy.availableConfiguredProfiles)
    : Number(roxy && (roxy.configuredProxyProfiles ?? roxy.availableProfiles) || 0);
  const roxyRegistrationReady = Boolean(
    roxy && roxy.ready
    && roxyProxyCapacity >= requiredRoxyWindows
    && pools && pools.US && pools.US.configured
  );
  const registrationReady = registrationMode === "roxybrowser"
    ? roxyRegistrationReady
    : protocolRegistrationReady;
  const downstreamProxiesReady = Boolean(pools && pools.US.configured && pools.TR.configured);
  const accountReady = Boolean(elements.accountSource.value.trim());
  const accessTokenMode = elements.accountImportFormat.value === "access_token";
  elements.mailboxProbeButton.disabled = accessTokenMode || !protocolRegistrationReady || !accountReady;
  elements.createTaskButton.disabled = !(accessTokenMode ? downstreamProxiesReady : registrationReady) || !accountReady;
}

function updateAccountImportMode() {
  const accessTokenMode = elements.accountImportFormat.value === "access_token";
  elements.mailboxProbeButton.hidden = accessTokenMode;
  elements.accountSourceLabel.textContent = accessTokenMode
    ? "批量导入 Access Token / Session JSON"
    : "批量导入账号（每行一个，自动识别三条或四条连接线）";
  elements.accountSource.placeholder = accessTokenMode
    ? "每行一个裸 AT、Bearer AT、accessToken=AT，或完整 Session JSON / JSONL"
    : "icloud邮箱---https://接码平台/messages/...\nicloud邮箱----https://icloud.biubiu007.com/console/open.php?mail=...&pwd=...&limit=1\nicloud邮箱----https://icloud-api.top/s/TOKEN/icloud邮箱";
  elements.accountImportNote.textContent = accessTokenMode
    ? "AT 会先通过 US 账号上下文验证，再作为已注册账号进入绑卡与提链流程；令牌只写入本机私有会话文件，任务列表与接口响应均不返回令牌。"
    : elements.registrationMode.value === "roxybrowser"
      ? "RoxyBrowser WebUI 注册复用每个窗口已配置的代理，不改写窗口代理；提交邮箱前仍校验该窗口出口为 JP。"
      : "协议注册使用平台任意地区代理池；同一次注册会校验 ChatGPT 与 Auth 出口国家一致。账户姓名自动生成为 First Last，年龄随机为 20–40 岁。";
  elements.createTaskButton.textContent = accessTokenMode ? "批量导入 AT 账号" : "批量导入任务";
  setRegistrationMessage();
  updateRegistrationActions();
}

function renderProxyRegion(region, summary) {
  const lower = region.toLowerCase();
  elements[`${lower}Count`].textContent = summary.configured ? `${summary.count} 条已保存` : "未配置";
  const container = elements[`${lower}Endpoints`];
  container.replaceChildren();
  for (const proxy of summary.proxies.slice(0, 8)) {
    const item = document.createElement("span");
    item.className = "endpoint";
    item.textContent = proxy.endpoint;
    container.append(item);
  }
  if (summary.proxies.length > 8) {
    const more = document.createElement("span");
    more.className = "endpoint";
    more.textContent = `+${summary.proxies.length - 8}`;
    container.append(more);
  }
  const probeButton = document.querySelector(`.probe-button[data-region="${region}"]`);
  probeButton.disabled = !summary.configured;
}

function adapterForStage(stageKey) {
  const adapters = state.bootstrap && state.bootstrap.adapters || {};
  const map = {
    registration: adapters.registration,
    checkout_link: adapters.checkoutLink,
    card_binding: adapters.cardBinding,
    trial_payment: adapters.trialPayment
  };
  return map[stageKey] || {};
}

function renderPipeline() {
  elements.pipeline.replaceChildren();
  for (const [index, stage] of (state.bootstrap.pipeline || []).entries()) {
    const adapter = adapterForStage(stage.key);
    const article = document.createElement("article");
    article.className = "stage";

    const number = document.createElement("span");
    number.className = "stage-number";
    number.textContent = String(index + 1).padStart(2, "0");
    const title = document.createElement("h3");
    title.textContent = stage.label;
    const description = document.createElement("p");
    description.textContent = adapter.status === "mailbox_reader_ready"
      ? "接码读取与验证码轮询已就绪；浏览器注册驱动待接入。"
      : adapter.status === "legacy_logic_ready"
      ? "旧插件核心逻辑可复用，Local API 传输层待接入。"
      : adapter.ready ? "适配器已就绪。" : "等待必要输入后接入。";
    const meta = document.createElement("div");
    meta.className = "stage-meta";
    const proxyTag = document.createElement("span");
    proxyTag.className = "tag";
    proxyTag.textContent = stage.proxy;
    const statusTag = document.createElement("span");
    statusTag.className = `tag ${adapter.ready ? "ready" : "pending"}`;
    statusTag.textContent = adapter.status || "pending";
    meta.append(proxyTag, statusTag);
    article.append(number, title, description, meta);
    elements.pipeline.append(article);
  }
}

function stateClass(value) {
  const stateValue = String(value || "").toUpperCase();
  if (stateValue === "ABANDONED") return "abandoned";
  if (stateValue.includes("BLOCKED")) return "blocked";
  if (stateValue.includes("FAILED")) return "failed";
  if (["REGISTERED", "CHECKOUT_LINK_READY", "CARD_BOUND", "TRIAL_ACTIVE", "COMPLETED"].includes(stateValue)) return "completed";
  return "";
}

function plusEligibilityBadge(eligibility) {
  if (!eligibility || !["eligible", "ineligible", "unknown"].includes(eligibility.status)) return null;
  const badge = document.createElement("span");
  badge.className = `plus-eligibility-pill ${eligibility.status}`;
  badge.textContent = eligibility.status === "eligible"
    ? "\u6709 Plus \u8bd5\u7528\u8d44\u683c"
    : eligibility.status === "ineligible"
      ? "\u65e0 Plus \u8bd5\u7528\u8d44\u683c"
      : "Plus \u8d44\u683c\u5f85\u68c0\u6d4b";
  const evidence = [eligibility.couponStatus, eligibility.buttonVisible ? "offer_button" : ""]
    .filter(Boolean)
    .join(" + ");
  badge.title = `${eligibility.campaignId || "plus-1-month-free"}${evidence ? ` \u00b7 ${evidence}` : ""}`;
  return badge;
}

function setExportMessage(message = "", kind = "") {
  elements.exportMessage.textContent = message;
  elements.exportMessage.className = kind
    ? `form-message account-export-message ${kind}`
    : "form-message account-export-message";
}

function setBatchMessage(message = "", kind = "") {
  elements.batchMessage.textContent = message;
  elements.batchMessage.className = kind
    ? `form-message account-batch-message ${kind}`
    : "form-message account-batch-message";
}

function updateExportControls() {
  const tasks = state.bootstrap && state.bootstrap.tasks || [];
  const ids = new Set(tasks.map((task) => task.id));
  state.selectedExportTaskIds = new Set([...state.selectedExportTaskIds].filter((id) => ids.has(id)));
  const count = state.selectedExportTaskIds.size;
  const cardSessionActive = Boolean(state.cardBindingSession);
  const operationLimit = maximumAccountOperations();
  const concurrencyReady = count > 0 && count <= operationLimit && !state.batchRunning && !cardSessionActive;
  const selectedTasks = tasks.filter((task) => state.selectedExportTaskIds.has(task.id));
  const everySelectedIn = (states) => selectedTasks.length === count
    && selectedTasks.every((task) => states.includes(task.state));
  const hasRetryableFailures = FAILURE_SELECTION_GROUPS.some((group) => (
    tasks.some((task) => group.states.includes(task.state))
  ));
  const retryLimit = Number(state.bootstrap && state.bootstrap.batch && state.bootstrap.batch.maxRetries) || 10;
  elements.batchRetryCount.max = String(retryLimit);
  elements.exportCount.textContent = `已选择 ${count} 个账号${count > operationLimit ? ` · 每轮上限 ${operationLimit} 个` : ""}`;
  elements.exportAccountsButton.disabled = count === 0 || state.batchRunning || cardSessionActive;
  elements.selectFailedButton.disabled = !hasRetryableFailures || state.batchRunning || cardSessionActive;
  elements.batchRetryCount.disabled = state.batchRunning || cardSessionActive;
  elements.batchRegisterButton.disabled = !concurrencyReady || !everySelectedIn(["QUEUED", "REGISTERING_BLOCKED", "REGISTRATION_BLOCKED", "REGISTRATION_FAILED"]);
  elements.batchExtractButton.disabled = !concurrencyReady || !everySelectedIn(["CHECKOUT_LINK_BLOCKED", "EXTRACTION_FAILED"]);
  const cardFlowStates = ["REGISTERED", "CARD_BINDING_READY", "CHECKOUT_LINK_READY", "CHECKOUT_LINK_BLOCKED", "EXTRACTION_FAILED", "CARD_BINDING_BLOCKED", "CARD_BINDING_FAILED", "TRIAL_PAYMENT_BLOCKED", "TRIAL_PAYMENT_FAILED"];
  elements.batchCardProfileButton.disabled = !concurrencyReady || !everySelectedIn(cardFlowStates);
  elements.batchCardBindButton.disabled = !concurrencyReady || !everySelectedIn(cardFlowStates);
  elements.batchSubscribeButton.disabled = !concurrencyReady || !everySelectedIn(["CARD_BOUND", "TRIAL_PAYMENT_BLOCKED", "TRIAL_PAYMENT_FAILED"]);
  elements.exportSelectAll.disabled = state.batchRunning || cardSessionActive;
  elements.exportSelectAll.checked = tasks.length > 0 && count === tasks.length;
  elements.exportSelectAll.indeterminate = count > 0 && count < tasks.length;
  if (!cardSessionActive) {
    elements.sharedCardCount.textContent = count
      ? `已选择 ${count} 个账号；绑定成功后会立即在同一粘性会话提链。`
      : `选择 1–${operationLimit} 个已注册账号，然后点击“绑卡并提链”。`;
  }
  renderOperationSettings();
}

function renderTasks() {
  const tasks = state.bootstrap.tasks || [];
  elements.taskList.replaceChildren();
  if (!tasks.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "尚无任务。先配置任意地区注册代理池；绑卡、提链和订阅继续使用独立的 US/TR 池。";
    elements.taskList.append(empty);
    state.selectedTaskId = null;
    updateExportControls();
    renderTaskDetail();
    return;
  }

  if (!state.selectedTaskId || !tasks.some((task) => task.id === state.selectedTaskId)) {
    state.selectedTaskId = tasks[0].id;
  }
  for (const task of tasks) {
    const row = document.createElement("div");
    row.className = `task-list-row${task.id === state.selectedTaskId ? " selected" : ""}`;
    const selection = document.createElement("input");
    selection.type = "checkbox";
    selection.className = "task-export-checkbox";
    selection.checked = state.selectedExportTaskIds.has(task.id);
    selection.disabled = state.batchRunning || Boolean(state.cardBindingSession);
    selection.setAttribute("aria-label", `选择账号 ${task.account && task.account.account || task.id} 用于批量操作`);
    selection.addEventListener("change", () => {
      if (selection.checked) state.selectedExportTaskIds.add(task.id);
      else state.selectedExportTaskIds.delete(task.id);
      updateExportControls();
    });
    const button = document.createElement("button");
    button.type = "button";
    button.className = `task-item${task.id === state.selectedTaskId ? " selected" : ""}`;
    const top = document.createElement("div");
    top.className = "task-topline";
    const id = document.createElement("span");
    id.className = "task-id";
    id.textContent = task.id.slice(0, 13);
    const status = document.createElement("span");
    status.className = `state-pill ${stateClass(task.state)}`.trim();
    status.textContent = task.state;
    const badges = document.createElement("span");
    badges.className = "task-badges";
    const eligibilityBadge = plusEligibilityBadge(task.plusEligibility);
    if (eligibilityBadge) badges.append(eligibilityBadge);
    badges.append(status);
    const time = document.createElement("div");
    time.className = "task-time";
    time.textContent = `${task.account && task.account.account ? `${task.account.account} · ` : ""}${new Date(task.updatedAt).toLocaleString()}`;
    top.append(id, badges);
    button.append(top, time);
    button.addEventListener("click", () => {
      state.selectedTaskId = task.id;
      renderTasks();
    });
    row.append(selection, button);
    elements.taskList.append(row);
  }
  updateExportControls();
  renderTaskDetail();
}

function renderTaskDetail() {
  const task = (state.bootstrap && state.bootstrap.tasks || []).find((candidate) => candidate.id === state.selectedTaskId);
  elements.taskDetail.replaceChildren();
  if (!task) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "选择任务查看阶段日志";
    elements.taskDetail.append(empty);
    return;
  }

  const header = document.createElement("div");
  header.className = "detail-header";
  const heading = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = task.state;
  const titleLine = document.createElement("div");
  titleLine.className = "detail-title-line";
  titleLine.append(title);
  const detailEligibilityBadge = plusEligibilityBadge(task.plusEligibility);
  if (detailEligibilityBadge) titleLine.append(detailEligibilityBadge);
  const id = document.createElement("p");
  const profile = task.account && task.account.profile
    ? ` · ${task.account.profile.fullName} · ${task.account.profile.age} 岁`
    : "";
  id.textContent = task.account
    ? `${task.account.account} · ${task.account.mailboxHost}${profile} · ${task.id}`
    : task.id;
  heading.append(titleLine, id);
  const run = document.createElement("button");
  run.type = "button";
  run.className = "button primary";
  const hostedCardInputRequired = ["REGISTERED", "CARD_BINDING_READY", "CHECKOUT_LINK_READY", "CARD_BINDING_BLOCKED", "CARD_BINDING_FAILED"].includes(task.state);
  const trialRunnable = ["CARD_BOUND", "TRIAL_PAYMENT_BLOCKED", "TRIAL_PAYMENT_FAILED"].includes(task.state);
  const trialAdapterReady = Boolean(
    state.bootstrap
    && state.bootstrap.adapters
    && state.bootstrap.adapters.trialPayment
    && state.bootstrap.adapters.trialPayment.ready
  );
  const promotionPending = trialRunnable
    && task.checkoutLink
    && task.checkoutLink.zeroAmountVerified !== true
    && task.checkoutLink.fullDiscountVerified !== true;
  run.textContent = trialRunnable
    ? (promotionPending
      ? "准备零金额订阅"
      : (task.state === "CARD_BOUND" ? "一键订阅" : "重新尝试一键订阅"))
    : hostedCardInputRequired
    ? (task.cardProfile ? "请使用上方绑卡并提链" : "请先生成绑卡资料")
    : task.state.includes("BLOCKED") || task.state.includes("FAILED")
    ? "重试当前阶段"
    : task.state === "ABANDONED"
    ? "账号已废弃"
    : "运行下一阶段";
  run.disabled = task.state === "TRIAL_ACTIVE"
    || task.state === "ABANDONED"
    || task.state === "BINDING_CARD"
    || task.state === "REQUESTING_TRIAL"
    || hostedCardInputRequired
    || (trialRunnable && !trialAdapterReady);
  run.addEventListener("click", () => trialRunnable ? subscribeTrial(task, run) : runTask(task.id, run));

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "button danger";
  remove.textContent = "删除账号";
  remove.addEventListener("click", () => deleteTask(task.id, remove));

  const actions = document.createElement("div");
  actions.className = "detail-actions";
  actions.append(run);
  if (["REGISTERING", "EXTRACTING_CHECKOUT_LINK", "REQUESTING_TRIAL"].includes(task.state)) {
    const terminate = document.createElement("button");
    terminate.type = "button";
    terminate.className = "button danger";
    terminate.textContent = "终止当前任务";
    terminate.addEventListener("click", () => terminateTask(task.id, terminate));
    actions.append(terminate);
  }
  if (task.state !== "ABANDONED") {
    const abandon = document.createElement("button");
    abandon.type = "button";
    abandon.className = "button subtle warning";
    abandon.textContent = "废弃账号";
    abandon.addEventListener("click", () => abandonTask(task.id, abandon));
    actions.append(abandon);
  }
  actions.append(remove);
  header.append(heading, actions);

  const progress = document.createElement("div");
  progress.className = "stage-progress";
  for (const stage of task.stages) {
    const item = document.createElement("div");
    item.className = `progress-cell ${String(stage.state).toLowerCase()}`;
    item.textContent = `${stage.label}\n${stage.state}`;
    progress.append(item);
  }

  let checkoutResult = null;
  if (task.checkoutLink && task.checkoutLink.url) {
    checkoutResult = document.createElement("section");
    checkoutResult.className = "checkout-result";

    const checkoutHeader = document.createElement("div");
    checkoutHeader.className = "checkout-result-header";
    const checkoutHeading = document.createElement("h4");
    checkoutHeading.textContent = "已提取结账链接";
    const zeroAmountVerified = task.checkoutLink.zeroAmountVerified === true
      || task.checkoutLink.fullDiscountVerified === true;
    const eligibilityLabel = document.createElement("span");
    eligibilityLabel.className = `promotion-eligibility-label ${zeroAmountVerified ? "eligible" : "not-eligible"}`;
    const protocolValidationFailed = task.checkoutLink.promotionStatus === "protocol_validation_failed";
    eligibilityLabel.textContent = zeroAmountVerified
      ? "本次应付 0 已确认"
      : protocolValidationFailed
        ? "链接已生成 · 协议验证待重试"
      : Number(task.checkoutLink.dueTodayMinorUnits) > 0
        ? "链接已生成 · 当前非0元"
        : "链接已生成 · 待零金额验证";
    checkoutHeader.append(checkoutHeading, eligibilityLabel);
    const checkoutMeta = document.createElement("p");
    const flow = Array.isArray(task.checkoutLink.proxyFlow) ? task.checkoutLink.proxyFlow.join(" → ") : "US → TR";
    const promotion = zeroAmountVerified
      ? `${task.checkoutLink.campaignId || "活动"} · Stripe 实时应付 0${Number(task.checkoutLink.discountPercent) >= 100 ? " · 100% 折扣" : ""}`
      : "Stripe 实时金额尚未确认为 0";
    const verification = zeroAmountVerified
      ? "零应付已校验"
      : protocolValidationFailed
        ? "候选链接可复制，零金额订阅阶段将重新执行协议验证"
      : Number(task.checkoutLink.dueTodayMinorUnits) > 0
        ? "当前金额非0，订阅确认保持锁定"
        : "等待零金额订阅准备阶段复核";
    checkoutMeta.textContent = [
      flow,
      task.checkoutLink.checkoutCountry ? `账单 ${task.checkoutLink.checkoutCountry}` : "",
      promotion,
      verification,
      task.checkoutLink.route || "checkout"
    ].filter(Boolean).join(" · ");
    const checkoutCode = document.createElement("code");
    checkoutCode.textContent = task.checkoutLink.url;

    const checkoutActions = document.createElement("div");
    checkoutActions.className = "checkout-actions";
    const openLink = document.createElement("a");
    openLink.className = "button primary";
    openLink.href = task.checkoutLink.url;
    openLink.target = "_blank";
    openLink.rel = "noopener noreferrer";
    openLink.textContent = "打开结账页";
    const copyLink = document.createElement("button");
    copyLink.type = "button";
    copyLink.className = "button subtle";
    copyLink.textContent = "复制链接";
    copyLink.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(task.checkoutLink.url);
        toast("结账链接已复制");
      } catch (error) {
        toast(error.message || "复制失败", "error");
      }
    });
    checkoutActions.append(openLink, copyLink);
    checkoutResult.append(checkoutHeader, checkoutMeta, checkoutCode, checkoutActions);
  }

  let cardProfileResult = null;
  const accountRegistered = task.stages.some((stage) => stage.key === "registration" && stage.state === "COMPLETED");
  if (accountRegistered) {
    cardProfileResult = document.createElement("section");
    cardProfileResult.className = "card-profile-result";
    const profileHeader = document.createElement("div");
    profileHeader.className = "card-profile-header";
    const profileHeading = document.createElement("h4");
    profileHeading.textContent = "绑卡姓名与地址";
    const generateButton = document.createElement("button");
    generateButton.type = "button";
    generateButton.className = "button subtle";
    generateButton.textContent = task.cardProfile ? "重新生成" : "生成资料";
    generateButton.disabled = task.state === "BINDING_CARD"
      || task.state === "CARD_BINDING_READY"
      || task.state === "CARD_BOUND"
      || task.state === "TRIAL_ACTIVE"
      || task.state === "ABANDONED";
    generateButton.addEventListener("click", () => generateCardProfile(task.id, generateButton));
    const profileActions = document.createElement("div");
    profileActions.className = "card-profile-actions";
    profileActions.append(generateButton);
    if (["CARD_BINDING_BLOCKED", "CARD_BINDING_FAILED"].includes(task.state)) {
      const retryCardButton = document.createElement("button");
      retryCardButton.type = "button";
      retryCardButton.className = "button primary card-binding-retry-button";
      retryCardButton.textContent = "重试绑卡";
      retryCardButton.addEventListener("click", async () => {
        state.selectedExportTaskIds = new Set([task.id]);
        renderTasks();
        await startBatchCardBinding([task.id]);
      });
      profileActions.append(retryCardButton);
    }
    const canRebindAfterTrialBlock = ["CHECKOUT_LINK_BLOCKED", "EXTRACTION_FAILED", "TRIAL_PAYMENT_BLOCKED", "TRIAL_PAYMENT_FAILED"].includes(task.state);
    profileHeader.append(profileHeading, profileActions);
    cardProfileResult.append(profileHeader);

    if (task.cardProfile) {
      const profileGrid = document.createElement("div");
      profileGrid.className = "card-profile-grid";
      const fields = [
        ["姓", task.cardProfile.lastName, ""],
        ["名", task.cardProfile.firstName, ""],
        ["邮政编码", task.cardProfile.postalCode, ""],
        ["完整地址", task.cardProfile.fullAddress, "wide"]
      ];
      for (const [label, value, className] of fields) {
        const field = document.createElement("div");
        field.className = `card-profile-field${className ? ` ${className}` : ""}`;
        const fieldLabel = document.createElement("span");
        fieldLabel.textContent = label;
        const fieldValue = document.createElement("code");
        fieldValue.textContent = value;
        field.append(fieldLabel, fieldValue);
        profileGrid.append(field);
      }
      cardProfileResult.append(profileGrid);
      if (task.cardBinding) {
        const bindingSummary = document.createElement("div");
        bindingSummary.className = "card-binding-summary";
        const bindingTitle = document.createElement("strong");
        bindingTitle.textContent = "支付方式已绑定";
        const bindingValue = document.createElement("code");
        const expiration = `${String(task.cardBinding.expMonth).padStart(2, "0")}/${task.cardBinding.expYear}`;
        bindingValue.textContent = `${String(task.cardBinding.brand || "card").toUpperCase()} ···· ${task.cardBinding.last4} · ${expiration}`;
        const bindingMeta = document.createElement("span");
        bindingMeta.textContent = `${task.cardBinding.proxyRegion || "US"} 核验${task.cardBinding.default ? " · 默认支付方式" : ""}`;
        bindingSummary.append(bindingTitle, bindingValue, bindingMeta);
        cardProfileResult.append(bindingSummary);
      }
    } else {
      const profileEmpty = document.createElement("p");
      profileEmpty.textContent = "按参考 JSON 随机抽取一组相互匹配的姓名、邮编和完整地址。";
      cardProfileResult.append(profileEmpty);
    }
    if (task.state !== "ABANDONED" && (!task.cardBinding || canRebindAfterTrialBlock)) {
      const sharedNotice = document.createElement("p");
      sharedNotice.className = "card-binding-privacy";
      sharedNotice.textContent = `卡片输入位于账号列表上方；勾选 1–${maximumAccountOperations()} 个账号后使用“绑卡并提链”。`;
      cardProfileResult.append(sharedNotice);
    }
  }

  let trialResult = null;
  if (task.trialSubscription) {
    trialResult = document.createElement("section");
    trialResult.className = "trial-subscription-result";
    const trialHeader = document.createElement("div");
    trialHeader.className = "trial-subscription-header";
    const trialHeading = document.createElement("h4");
    trialHeading.textContent = "Plus 订阅已激活";
    const trialLabel = document.createElement("span");
    trialLabel.className = "promotion-eligibility-label eligible";
    trialLabel.textContent = task.trialSubscription.trial ? "优惠已生效" : "订阅有效";
    trialHeader.append(trialHeading, trialLabel);
    const trialMeta = document.createElement("p");
    const taxRate = task.trialSubscription.taxRatePercent == null ? "已恢复" : `${task.trialSubscription.taxRatePercent}%`;
    const dueToday = task.trialSubscription.dueTodayMinorUnits == null ? "已恢复" : task.trialSubscription.dueTodayMinorUnits;
    trialMeta.textContent = [
      `计划 ${task.trialSubscription.plan || "plus"}`,
      `账单地区 ${task.trialSubscription.billingCountry || "已验证"}`,
      `税率 ${taxRate}`,
      `今日应付 ${dueToday}`,
      `出口 ${task.trialSubscription.proxyRegion || "US"}`
    ].join(" · ");
    const trialDates = document.createElement("code");
    trialDates.textContent = task.trialSubscription.renewsAt
      ? `续费时间 ${new Date(task.trialSubscription.renewsAt).toLocaleString()}`
      : task.trialSubscription.expiresAt
      ? `到期时间 ${new Date(task.trialSubscription.expiresAt).toLocaleString()}`
      : `激活时间 ${new Date(task.trialSubscription.subscribedAt).toLocaleString()}`;
    trialResult.append(trialHeader, trialMeta, trialDates);
  }

  const logs = document.createElement("div");
  logs.className = "log-list";
  for (const entry of [...task.logs].reverse()) {
    const row = document.createElement("div");
    row.className = `log-entry ${entry.level || ""}`;
    const time = document.createElement("span");
    time.className = "log-time";
    time.textContent = new Date(entry.at).toLocaleTimeString();
    const message = document.createElement("span");
    message.className = "log-message";
    const details = entry.details && entry.details.code ? ` · ${entry.details.code}` : "";
    message.textContent = `${entry.message}${details}`;
    row.append(time, message);
    logs.append(row);
  }
  elements.taskDetail.append(
    header,
    progress,
    ...(checkoutResult ? [checkoutResult] : []),
    ...(cardProfileResult ? [cardProfileResult] : []),
    ...(trialResult ? [trialResult] : []),
    logs
  );
}

function render() {
  if (!state.bootstrap) return;
  renderOperationSettings();
  renderProxyRegion("REGISTRATION", state.bootstrap.proxyPools.REGISTRATION);
  renderProxyRegion("US", state.bootstrap.proxyPools.US);
  renderProxyRegion("TR", state.bootstrap.proxyPools.TR);
  updateRegistrationActions();
  renderPipeline();
  renderTasks();
  updatePlusControls();
}

async function refresh({ quiet = false } = {}) {
  if (quiet && state.cardBindingSession) return;
  if (state.refreshing) return;
  state.refreshing = true;
  try {
    state.bootstrap = await api("/api/bootstrap");
    setHealth(true, "Local API 在线");
    render();
    if (!quiet) toast("状态已刷新");
  } catch (error) {
    setHealth(false, "Local API 离线");
    if (!quiet) toast(error.message, "error");
  } finally {
    state.refreshing = false;
  }
}

elements.proxyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(["REGISTRATION", "US", "TR"].map((region) => [
    region,
    elements[`${region.toLowerCase()}Pool`].value.trim()
  ]));
  const updates = Object.fromEntries(Object.entries(values).filter(([, value]) => value));
  if (!Object.keys(updates).length) {
    setProxyMessage("请至少填写一个需要新增或替换的代理池；空白池会保留现有配置。", "error");
    return;
  }
  setProxyMessage("正在保存到本地后端…");
  try {
    const payload = await api("/api/proxy-pools", {
      method: "PUT",
      body: JSON.stringify(updates)
    });
    state.bootstrap.proxyPools = payload.proxyPools;
    elements.registrationPool.value = "";
    elements.usPool.value = "";
    elements.trPool.value = "";
    setProxyMessage(`已更新 ${Object.keys(updates).join("、")} 代理池；空白池保持原值，凭据不会从 API 回传。`, "success");
    render();
  } catch (error) {
    setProxyMessage(error.message, "error");
  }
});

for (const button of document.querySelectorAll(".probe-button")) {
  button.addEventListener("click", async () => {
    const region = button.dataset.region;
    const target = elements[`${region.toLowerCase()}Probe`];
    target.textContent = "连接中…";
    target.className = "probe-result";
    button.disabled = true;
    try {
      const result = await api("/api/proxy-pools/probe", {
        method: "POST",
        body: JSON.stringify({ region, index: 0 })
      });
      const routeLabel = result.route === "first_hop" ? "本地首跳链路可达" : "网关直连可达";
      target.textContent = `${routeLabel} · ${result.latencyMs} ms`;
      target.className = "probe-result ok";
    } catch (error) {
      target.textContent = error.message;
      target.className = "probe-result error";
    } finally {
      button.disabled = false;
    }
  });
}

elements.accountSource.addEventListener("input", updateRegistrationActions);
elements.accountImportFormat.addEventListener("change", updateAccountImportMode);
for (const button of elements.registrationModeButtons) {
  button.addEventListener("click", () => {
    elements.registrationMode.value = button.dataset.registrationMode === "roxybrowser" ? "roxybrowser" : "protocol";
    state.operationSettingsDirty = true;
    renderOperationSettings();
  });
}
elements.maxAccountOperations.addEventListener("input", () => {
  const value = Number(elements.maxAccountOperations.value);
  if (Number.isInteger(value) && value >= 1 && value <= 30) {
    state.operationSettingsDirty = true;
    renderOperationSettings();
  }
});

elements.operationSettingsSave.addEventListener("click", async () => {
  const maxAccountOperations = Number(elements.maxAccountOperations.value);
  if (!Number.isInteger(maxAccountOperations) || maxAccountOperations < 1 || maxAccountOperations > 30) {
    setRegistrationMessage("每轮最大账号数 N 必须是 1–30 的整数。", "error");
    elements.maxAccountOperations.focus();
    return;
  }
  state.operationSettingsSaving = true;
  renderOperationSettings();
  setRegistrationMessage("正在保存注册方式与每轮账号数…");
  try {
    const payload = await api("/api/operation-settings", {
      method: "PUT",
      body: JSON.stringify({
        maxAccountOperations,
        registrationMode: elements.registrationMode.value
      })
    });
    state.bootstrap.operationSettings = payload.settings;
    state.bootstrap.batch = payload.batch;
    state.bootstrap.roxyBrowser = payload.roxyBrowser;
    state.operationSettingsDirty = false;
    render();
    setRegistrationMessage(
      `设置已保存：每轮最多 ${payload.settings.maxAccountOperations} 个账号；注册方式为 ${payload.settings.registrationMode === "roxybrowser" ? "RoxyBrowser WebUI" : "协议"}。`,
      "success"
    );
  } catch (error) {
    setRegistrationMessage(error.message, "error");
  } finally {
    state.operationSettingsSaving = false;
    renderOperationSettings();
  }
});

elements.mailboxProbeButton.addEventListener("click", async () => {
  if (elements.accountImportFormat.value === "access_token") return;
  const accountLine = elements.accountSource.value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
  elements.mailboxProbeButton.disabled = true;
  elements.createTaskButton.disabled = true;
  setRegistrationMessage("正在通过注册专用代理检查接码平台…");
  try {
    const payload = await api("/api/mailbox/probe", {
      method: "POST",
      body: JSON.stringify({ accountLine })
    });
    const mailbox = payload.mailbox;
    const codeState = mailbox.codeAvailable ? "已检测到验证码" : "暂未收到验证码";
    setRegistrationMessage(
      `接码平台可达：${mailbox.messageCount} 封邮件，${codeState}。`,
      "success"
    );
  } catch (error) {
    setRegistrationMessage(error.message, "error");
  } finally {
    updateRegistrationActions();
  }
});

elements.registrationForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = elements.accountSource.value;
  const format = elements.accountImportFormat.value === "access_token" ? "access_token" : "email_url";
  elements.mailboxProbeButton.disabled = true;
  elements.createTaskButton.disabled = true;
  setRegistrationMessage(format === "access_token"
    ? "正在通过 US 验证 AT 并创建可直接绑卡的账号任务…"
    : "正在批量识别账号并创建使用任意地区代理的本地注册任务…");
  try {
    const body = format === "access_token"
      ? { format, sessions: parsePlusSessionSource(text) }
      : { format, text };
    const payload = await api("/api/tasks/import", {
      method: "POST",
      body: JSON.stringify(body)
    });
    const imported = payload.import;
    state.selectedTaskId = imported.tasks[0] && imported.tasks[0].id || null;
    elements.accountSource.value = "";
    await refresh({ quiet: true });
    setRegistrationMessage(format === "access_token"
      ? `已导入 ${imported.count} 个 AT 账号，均已进入 REGISTERED，可直接生成绑卡资料并执行绑卡提链。`
      : `已导入 ${imported.count} 个任务；每轮最多选择 ${maximumAccountOperations()} 个账号。`, "success");
  } catch (error) {
    setRegistrationMessage(error.message, "error");
  } finally {
    updateRegistrationActions();
  }
});

async function runTask(taskId, button) {
  button.disabled = true;
  button.textContent = "执行中…";
  try {
    await api(`/api/tasks/${taskId}/run`, { method: "POST", body: "{}" });
    await refresh({ quiet: true });
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function subscribeTrial(task, button) {
  const promotionPending = task.checkoutLink
    && task.checkoutLink.zeroAmountVerified !== true
    && task.checkoutLink.fullDiscountVerified !== true;
  const confirmed = window.confirm(
    promotionPending
      ? "确认准备零金额订阅？系统会重新加载原始 Checkout；只有 Stripe 实时应付确认为 0 时才发送订阅请求。"
      : "确认使用已绑定的默认支付方式订阅 ChatGPT Plus？当前优惠首月应付为 0；试用结束后将按结账页价格自动续费，除非提前取消。"
  );
  if (!confirmed) return;

  button.disabled = true;
  button.textContent = promotionPending ? "正在刷新并校验实时金额…" : "正在更新账单并订阅…";
  try {
    await api(`/api/tasks/${task.id}/run`, {
      method: "POST",
      body: JSON.stringify({ confirmed: true })
    });
    await refresh({ quiet: true });
    const updated = (state.bootstrap && state.bootstrap.tasks || []).find((candidate) => candidate.id === task.id);
    if (updated && updated.state === "TRIAL_ACTIVE") toast("US 账单已保存，Plus 试用订阅已激活");
    else toast("订阅接口已返回，请查看阶段日志", "error");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    if (button.isConnected) button.disabled = false;
  }
}

async function deleteTask(taskId, button) {
  const task = (state.bootstrap && state.bootstrap.tasks || []).find((candidate) => candidate.id === taskId);
  const account = task && task.account && task.account.account || taskId;
  const confirmed = window.confirm(
    `确认删除账号 ${account} 的本地任务记录和已保存登录会话？此操作不可撤销。`
  );
  if (!confirmed) return;

  button.disabled = true;
  button.textContent = "删除中…";
  try {
    if (state.cardBindingSession && state.cardBindingSession.taskIds.includes(taskId)) await disposeCardBindingPanel();
    await api(`/api/tasks/${taskId}`, { method: "DELETE" });
    if (state.bootstrap && Array.isArray(state.bootstrap.tasks)) {
      state.bootstrap.tasks = state.bootstrap.tasks.filter((candidate) => candidate.id !== taskId);
    }
    if (state.selectedTaskId === taskId) state.selectedTaskId = null;
    renderTasks();
    await refresh({ quiet: true });
    toast("账号已删除");
  } catch (error) {
    toast(error.message, "error");
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = "删除账号";
    }
  }
}

async function abandonTask(taskId, button) {
  const task = (state.bootstrap && state.bootstrap.tasks || []).find((candidate) => candidate.id === taskId);
  const account = task && task.account && task.account.account || taskId;
  if (!window.confirm(`确认将账号 ${account} 标记为废弃？账号仍可按需导出。`)) return;
  button.disabled = true;
  button.textContent = "处理中…";
  try {
    if (state.cardBindingSession && state.cardBindingSession.taskIds.includes(taskId)) await disposeCardBindingPanel();
    await api(`/api/tasks/${taskId}/abandon`, { method: "POST", body: "{}" });
    await refresh({ quiet: true });
    toast("账号已标记为废弃");
  } catch (error) {
    toast(error.message, "error");
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = "废弃账号";
    }
  }
}

async function terminateTask(taskId, button) {
  const task = (state.bootstrap && state.bootstrap.tasks || []).find((candidate) => candidate.id === taskId);
  const account = task && task.account && task.account.account || taskId;
  if (!window.confirm(`确认终止 ${account} 当前正在执行的任务？已完成的数据会保留。`)) return;
  button.disabled = true;
  button.textContent = "正在终止…";
  try {
    await api(`/api/tasks/${taskId}/terminate`, { method: "POST", body: "{}" });
    toast("终止信号已发送，正在回收浏览器窗口");
    await new Promise((resolve) => setTimeout(resolve, 500));
    await refresh({ quiet: true });
  } catch (error) {
    toast(error.message, "error");
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = "终止当前任务";
    }
  }
}

async function exportSelectedAccounts() {
  const ids = [...state.selectedExportTaskIds];
  if (!ids.length) return;
  elements.exportAccountsButton.disabled = true;
  setExportMessage("正在生成导出文件…");
  try {
    const payload = await api("/api/tasks/export", {
      method: "POST",
      body: JSON.stringify({ ids, format: elements.exportFormat.value })
    });
    const result = payload.export;
    const blob = new Blob([result.content], { type: result.mediaType || "text/plain;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = result.filename || "plus-extractor-export.txt";
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(href), 0);
    const failureText = result.failures && result.failures.length
      ? `，${result.failures.length} 个失败`
      : "";
    setExportMessage(`已自动下载 ${result.count}/${result.requested} 个账号的 TXT 文件${failureText}。`, result.failures && result.failures.length ? "error" : "success");
  } catch (error) {
    setExportMessage(error.message, "error");
  } finally {
    updateExportControls();
  }
}

function selectFailedTasks() {
  const tasks = state.bootstrap && state.bootstrap.tasks || [];
  const selectedGroup = FAILURE_SELECTION_GROUPS.find((group) => (
    tasks.some((task) => group.states.includes(task.state))
  ));
  if (!selectedGroup) {
    setBatchMessage("当前没有可批量重试的失败账号。", "success");
    return;
  }
  const failures = tasks.filter((task) => selectedGroup.states.includes(task.state));
  const selected = failures.slice(0, maximumAccountOperations());
  state.selectedExportTaskIds = new Set(selected.map((task) => task.id));
  if (selected[0]) state.selectedTaskId = selected[0].id;
  renderTasks();
  const remaining = failures.length - selected.length;
  setBatchMessage(
    `已选择 ${selected.length} 个${selectedGroup.label}账号${remaining > 0 ? `；另有 ${remaining} 个留待下一批` : ""}。`,
    "success"
  );
}

async function runSelectedBatch(stage, button) {
  const ids = [...state.selectedExportTaskIds];
  const operationLimit = maximumAccountOperations();
  if (!ids.length || ids.length > operationLimit) {
    setBatchMessage(`请选择 1–${operationLimit} 个账号执行本轮操作。`, "error");
    return;
  }
  const retryLimit = Number(state.bootstrap && state.bootstrap.batch && state.bootstrap.batch.maxRetries) || 10;
  const configuredRetries = Number(elements.batchRetryCount.value);
  if (!Number.isInteger(configuredRetries) || configuredRetries < 0 || configuredRetries > retryLimit) {
    setBatchMessage(`自动重试次数必须是 0–${retryLimit} 的整数。`, "error");
    elements.batchRetryCount.focus();
    return;
  }
  const maxRetries = stage === "trial_payment" ? 0 : configuredRetries;
  if (stage === "trial_payment") {
    const accepted = window.confirm(
      `确认同步订阅所选 ${ids.length} 个账号？系统会先等待全部 Checkout、支付方式和确认令牌完全加载；任一账号准备失败时发送 0 个 confirm 请求，全部就绪后在同一事件循环批次内统一放行。试用结束后会按结账页价格自动续费，除非提前取消。`
    );
    if (!accepted) return;
  }

  const labels = {
    registration: "并发注册",
    checkout_link: "并发提链",
    trial_payment: "同步订阅"
  };
  state.batchRunning = true;
  updateExportControls();
  button.textContent = stage === "trial_payment" ? "等待全部加载…" : "并发执行中…";
  const registrationMode = state.bootstrap && state.bootstrap.operationSettings
    && state.bootstrap.operationSettings.registrationMode === "roxybrowser"
    ? `；Roxy 窗口 ${Math.ceil(ids.length / 2)} 个`
    : "";
  setBatchMessage(`${labels[stage]}已启动：${ids.length}/${operationLimit} 个账号${stage === "registration" ? registrationMode : ""}${stage === "trial_payment" ? "" : `，失败后最多自动重试 ${maxRetries} 次`}。`);
  try {
    const payload = await api("/api/tasks/batch/run", {
      method: "POST",
      body: JSON.stringify({
        ids,
        stage,
        maxRetries,
        ...(stage === "trial_payment" ? { confirmed: true } : {})
      })
    });
    const batch = payload.batch;
    await refresh({ quiet: true });
    if (stage === "trial_payment" && batch.confirmationsDispatched === 0) {
      setBatchMessage(
        `同步屏障在 ${batch.status} 阶段停止：0 个 confirm 请求已发送，请查看失败账号日志。`,
        "error"
      );
    } else if (stage === "trial_payment") {
      setBatchMessage(
        `同步放行 ${batch.confirmationsDispatched}/${batch.requested} 个 confirm 请求；调度偏差 ${Number(batch.dispatchSkewMs || 0).toFixed(3)} ms，激活 ${batch.completed}/${batch.requested} 个。`,
        batch.failures && batch.failures.length ? "error" : "success"
      );
    } else {
      const successState = stage === "registration" ? "REGISTERED" : "CHECKOUT_LINK_READY";
      const completed = (batch.tasks || []).filter((task) => task.state === successState).length;
      setBatchMessage(
        `${labels[stage]}完成：${completed}/${batch.requested} 个账号进入下一阶段；自动重试 ${batch.retryRounds}/${batch.maxRetries} 轮，共重跑 ${batch.retryExecutions} 个任务。`,
        completed === batch.requested ? "success" : "error"
      );
    }
  } catch (error) {
    setBatchMessage(error.message, "error");
  } finally {
    state.batchRunning = false;
    button.textContent = labels[stage];
    updateExportControls();
  }
}

async function generateCardProfile(taskId, button) {
  button.disabled = true;
  button.textContent = "生成中…";
  try {
    await api(`/api/tasks/${taskId}/card-profile`, { method: "POST", body: "{}" });
    await refresh({ quiet: true });
    toast("姓名与地址已生成");
  } catch (error) {
    toast(error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function generateSelectedCardProfiles() {
  const ids = [...state.selectedExportTaskIds];
  const operationLimit = maximumAccountOperations();
  if (!ids.length || ids.length > operationLimit) {
    setBatchMessage(`请选择 1–${operationLimit} 个账号生成绑卡信息。`, "error");
    return;
  }
  state.batchRunning = true;
  elements.batchCardProfileButton.textContent = "批量生成中…";
  updateExportControls();
  try {
    const payload = await api("/api/tasks/batch/card-profile", {
      method: "POST",
      body: JSON.stringify({ ids })
    });
    mergeBatchTasks(payload.batch.tasks);
    await refresh({ quiet: true });
    setBatchMessage(`已为 ${payload.batch.generated}/${payload.batch.requested} 个已选账号生成绑卡信息。`, "success");
    toast(`绑卡信息已生成 ${payload.batch.generated}/${payload.batch.requested}`);
  } catch (error) {
    setBatchMessage(error.message || String(error), "error");
  } finally {
    state.batchRunning = false;
    elements.batchCardProfileButton.textContent = "一键生成绑卡信息（已选账号）";
    updateExportControls();
  }
}

let stripeJsPromise = null;

function loadStripeJs() {
  if (window.Stripe) return Promise.resolve(window.Stripe);
  if (stripeJsPromise) return stripeJsPromise;
  stripeJsPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[data-card-binding-stripe="true"]');
    const script = existing || document.createElement("script");
    const onLoad = () => window.Stripe
      ? resolve(window.Stripe)
      : reject(new Error("Stripe.js 已加载，但未提供 Stripe 构造函数。"));
    const onError = () => reject(new Error("Stripe.js 加载失败，请检查浏览器网络和代理。"));
    script.addEventListener("load", onLoad, { once: true });
    script.addEventListener("error", onError, { once: true });
    if (!existing) {
      script.src = "https://js.stripe.com/v3/";
      script.async = true;
      script.dataset.cardBindingStripe = "true";
      document.head.append(script);
    }
  }).catch((error) => {
    stripeJsPromise = null;
    throw error;
  });
  return stripeJsPromise;
}

async function resolveStripeForIntent(clientSecret, publishableKeys) {
  let lastError = null;
  for (const key of publishableKeys || []) {
    const stripe = window.Stripe(key);
    const probe = await stripe.retrieveSetupIntent(clientSecret);
    if (probe && probe.setupIntent) return { stripe, key };
    lastError = probe && probe.error || lastError;
  }
  throw lastError || new Error("没有匹配当前 SetupIntent 的 Stripe 公钥。");
}

function setSharedCardMessage(text, kind = "") {
  elements.sharedCardMessage.textContent = text;
  elements.sharedCardMessage.className = kind ? `card-binding-message ${kind}` : "card-binding-message";
  elements.sharedCardSection.dataset.state = kind === "error" ? "error" : kind === "success" ? "ready" : "running";
}

function resetSharedCardPanel(message = "尚未准备绑卡并提链会话。") {
  elements.sharedCardMount.replaceChildren();
  elements.sharedCardSubmit.disabled = true;
  elements.sharedCardReload.disabled = true;
  elements.sharedCardSection.dataset.state = "idle";
  setSharedCardMessage(message);
  elements.sharedCardSection.dataset.state = "idle";
}

function mergeBatchTasks(tasks = []) {
  if (!state.bootstrap || !Array.isArray(state.bootstrap.tasks)) return;
  const updates = new Map(tasks.map((task) => [task.id, task]));
  state.bootstrap.tasks = state.bootstrap.tasks.map((task) => updates.get(task.id) || task);
}

async function cancelCardPreparations(preparations = [], failureByTask = new Map()) {
  await Promise.all(preparations.map((preparation) => api(`/api/tasks/${preparation.taskId}/card-binding/cancel`, {
    method: "POST",
    body: JSON.stringify({
      token: preparation.token,
      failure: failureByTask.get(preparation.taskId) || null
    })
  }).catch(() => null)));
}

async function disposeCardBindingPanel({ cancel = true } = {}) {
  const session = state.cardBindingSession;
  if (!session) {
    resetSharedCardPanel();
    return;
  }
  session.disposed = true;
  if (session.cardElement && typeof session.cardElement.destroy === "function") session.cardElement.destroy();
  state.cardBindingSession = null;
  if (cancel) {
    const incomplete = session.preparations.filter((preparation) => !session.completedTaskIds.has(preparation.taskId));
    await cancelCardPreparations(incomplete);
  }
  resetSharedCardPanel();
  updateExportControls();
}

function readCardBindingRetryCount() {
  const retryLimit = Number(state.bootstrap && state.bootstrap.batch && state.bootstrap.batch.maxRetries) || 10;
  const configuredRetries = Number(elements.batchRetryCount.value);
  if (!Number.isInteger(configuredRetries) || configuredRetries < 0 || configuredRetries > retryLimit) {
    setBatchMessage(`自动重试次数必须是 0–${retryLimit} 的整数。`, "error");
    elements.batchRetryCount.focus();
    return null;
  }
  return configuredRetries;
}

async function startBatchCardBinding(explicitIds = null) {
  const ids = Array.isArray(explicitIds) ? explicitIds : [...state.selectedExportTaskIds];
  const operationLimit = maximumAccountOperations();
  if (!ids.length || ids.length > operationLimit) {
    setBatchMessage(`请选择 1–${operationLimit} 个账号执行绑卡并提链。`, "error");
    return;
  }
  const maxRetries = readCardBindingRetryCount();
  if (maxRetries == null) return;
  if (state.cardBindingSession) await disposeCardBindingPanel();
  state.batchRunning = true;
  elements.batchCardBindButton.textContent = "绑卡并提链准备中…";
  elements.sharedCardCount.textContent = `正在同时准备 ${ids.length} 个账号的 SetupIntent…`;
  setSharedCardMessage("正在通过 US 会话并发准备全部账号…");
  updateExportControls();
  try {
    const payload = await api("/api/tasks/batch/card-binding/prepare", {
      method: "POST",
      body: JSON.stringify({ ids, maxRetries })
    });
    const batch = payload.batch;
    mergeBatchTasks(batch.tasks);
    if (!batch.preparations || !batch.preparations.length) {
      throw new Error(batch.failures && batch.failures[0] && batch.failures[0].message || "没有账号完成绑卡准备。");
    }
    const session = {
      taskIds: ids,
      preparations: [],
      completedTaskIds: new Set(),
      maxRetries,
      retryDelayMs: Number(batch.retryDelayMs || state.bootstrap && state.bootstrap.batch && state.bootstrap.batch.retryDelayMs) || 0,
      preparationRetryRounds: Number(batch.retryRounds || 0),
      stripe: null,
      stripeKey: "",
      cardElement: null,
      submitting: false,
      disposed: false
    };
    state.cardBindingSession = session;
    await loadStripeJs();
    const elementOwner = await resolveStripeForIntent(
      batch.preparations[0].clientSecret,
      batch.preparations[0].publishableKeys
    );
    const confirmationContexts = await Promise.all(batch.preparations.map(async (preparation) => {
      try {
        const resolved = await resolveStripeForIntent(preparation.clientSecret, preparation.publishableKeys);
        return { ...preparation, confirmationStripe: resolved.stripe, stripeKey: resolved.key };
      } catch (error) {
        return { ...preparation, resolutionError: error };
      }
    }));
    const compatible = confirmationContexts.filter((preparation) => (
      !preparation.resolutionError && preparation.stripeKey === elementOwner.key
    ));
    const incompatible = confirmationContexts.filter((preparation) => !compatible.includes(preparation));
    if (incompatible.length) {
      const failures = new Map(incompatible.map((preparation) => [preparation.taskId, {
        code: preparation.resolutionError ? "STRIPE_SETUP_INTENT_RESOLUTION_FAILED" : "STRIPE_ACCOUNT_MISMATCH",
        message: preparation.resolutionError && preparation.resolutionError.message
          || "该账号与当前卡片输入框不属于同一个 Stripe 账户。"
      }]));
      await cancelCardPreparations(incompatible, failures);
    }
    if (!compatible.length) throw new Error("没有 SetupIntent 与当前 Stripe 卡输入框匹配。");
    session.preparations = compatible;
    session.stripe = elementOwner.stripe;
    session.stripeKey = elementOwner.key;
    if (session.disposed) return;
    const stripeElements = session.stripe.elements({ locale: "zh" });
    session.cardElement = stripeElements.create("card", {
      hidePostalCode: true,
      style: {
        base: {
          color: "#eefbf6",
          fontFamily: "Inter, system-ui, sans-serif",
          fontSize: "16px",
          "::placeholder": { color: "#708c82" }
        },
        invalid: { color: "#ff8d8d" }
      }
    });
    session.cardElement.mount(elements.sharedCardMount);
    session.cardElement.on("ready", () => {
      elements.sharedCardSubmit.disabled = false;
      elements.sharedCardReload.disabled = false;
      elements.sharedCardCount.textContent = `${compatible.length}/${batch.requested} 个账号已准备；每个账号使用独立 Stripe 实例确认。`;
      setSharedCardMessage("Stripe 卡输入框已就绪；卡资料填写一次，确认阶段同步并发。", "success");
    });
    session.cardElement.on("change", (event) => {
      if (event.error) setSharedCardMessage(event.error.message, "error");
      else if (event.complete) setSharedCardMessage("卡资料填写完成，可以确认绑卡并提链。", "success");
      else setSharedCardMessage("请填写卡号、有效期和 CVC。");
    });
    session.cardElement.on("loaderror", (event) => {
      elements.sharedCardSubmit.disabled = true;
      elements.sharedCardReload.disabled = false;
      setSharedCardMessage(event && event.error && event.error.message || "Stripe 卡输入框加载失败。", "error");
    });
    setBatchMessage(
      `绑卡并提链已准备 ${compatible.length}/${batch.requested} 个账号；请在独立卡片中填写一次卡资料。`,
      batch.failures.length || incompatible.length ? "error" : "success"
    );
  } catch (error) {
    if (state.cardBindingSession) await disposeCardBindingPanel();
    setSharedCardMessage(error.message || String(error), "error");
    setBatchMessage(error.message || String(error), "error");
  } finally {
    state.batchRunning = false;
    elements.batchCardBindButton.textContent = "绑卡并提链";
    updateExportControls();
  }
}

const STRIPE_ELEMENT_RELEASE_DELAY_MS = 250;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function createIndependentPaymentMethod(session, preparation) {
  const result = await session.stripe.createPaymentMethod({
    type: "card",
    card: session.cardElement,
    billing_details: preparation.billing,
    allow_redisplay: "always"
  });
  await delay(STRIPE_ELEMENT_RELEASE_DELAY_MS);
  if (result && result.error) throw result.error;
  const paymentMethodId = String(result && result.paymentMethod && result.paymentMethod.id || "");
  if (!/^pm_[A-Za-z0-9_-]{8,255}$/.test(paymentMethodId)) {
    throw new Error("Stripe 未返回独立 payment method id。");
  }
  return paymentMethodId;
}

async function confirmPreparedBinding(session, preparation, paymentMethodId) {
  if (!preparation.confirmationStripe || preparation.stripeKey !== session.stripeKey) {
    throw new Error("SetupIntent 与当前卡片输入框不属于同一个 Stripe 账户。");
  }
  const result = await preparation.confirmationStripe.confirmCardSetup(preparation.clientSecret, {
    payment_method: paymentMethodId,
    set_as_default_payment_method: true
  });
  if (result && result.error) throw result.error;
  if (!result || !result.setupIntent || result.setupIntent.status !== "succeeded") {
    throw new Error(`SetupIntent 状态为 ${result && result.setupIntent && result.setupIntent.status || "unknown"}`);
  }
  const confirmedPaymentMethod = typeof result.setupIntent.payment_method === "string"
    ? result.setupIntent.payment_method
    : result.setupIntent.payment_method && result.setupIntent.payment_method.id;
  if (confirmedPaymentMethod && confirmedPaymentMethod !== paymentMethodId) {
    throw new Error("Stripe 返回了不同的 PaymentMethod。");
  }
  return confirmedPaymentMethod || paymentMethodId;
}

async function submitBatchCardBinding() {
  const session = state.cardBindingSession;
  if (!session || !session.cardElement || session.disposed || session.submitting) return;
  session.submitting = true;
  state.batchRunning = true;
  elements.sharedCardSubmit.disabled = true;
  elements.sharedCardReload.disabled = true;
  setSharedCardMessage(`正在为 ${session.preparations.length} 个账号逐一生成独立 PaymentMethod；随后由独立 Stripe 实例同步确认。`);
  updateExportControls();
  try {
    const independentBindings = [];
    const finalRejectedPreparations = [];
    let pending = [...session.preparations];
    let stripeRetryRounds = 0;
    let stripeRetryExecutions = 0;
    let paymentMethodExecutions = 0;
    let firstStripeFailure = null;
    while (pending.length) {
      const retryable = [];
      for (let index = 0; index < pending.length; index += 1) {
        const preparation = pending[index];
        setSharedCardMessage(
          `正在生成第 ${index + 1}/${pending.length} 个独立 PaymentMethod（第 ${stripeRetryRounds + 1} 轮）…`
        );
        try {
          paymentMethodExecutions += 1;
          const paymentMethodId = await createIndependentPaymentMethod(session, preparation);
          independentBindings.push({
            id: preparation.taskId,
            token: preparation.token,
            setupIntentId: preparation.clientSecret.split("_secret_", 1)[0],
            paymentMethodId
          });
        } catch (error) {
          firstStripeFailure = firstStripeFailure || error;
          retryable.push(pending[index]);
        }
      }
      if (!retryable.length) break;
      if (stripeRetryRounds >= session.maxRetries) {
        finalRejectedPreparations.push(...retryable);
        break;
      }
      stripeRetryRounds += 1;
      stripeRetryExecutions += retryable.length;
      setSharedCardMessage(
        `PaymentMethod 生成有 ${retryable.length} 个失败，${session.retryDelayMs / 1000} 秒后按队列重试；轮次 ${stripeRetryRounds}/${session.maxRetries}。`,
        "error"
      );
      if (session.retryDelayMs) await new Promise((resolve) => setTimeout(resolve, session.retryDelayMs));
      pending = retryable;
    }
    await cancelCardPreparations(finalRejectedPreparations, new Map(finalRejectedPreparations.map((preparation) => [preparation.taskId, {
      code: "STRIPE_PAYMENT_METHOD_CREATE_FAILED",
      message: String(firstStripeFailure && firstStripeFailure.message || "Stripe 未生成独立 PaymentMethod。")
    }])));
    if (!independentBindings.length) {
      throw firstStripeFailure || new Error("Stripe 未生成任何独立 PaymentMethod。");
    }
    setSharedCardMessage(`已生成 ${independentBindings.length} 个独立 PaymentMethod；正在同步提交 confirmCardSetup…`);
    const preparationByTask = new Map(session.preparations.map((preparation) => [preparation.taskId, preparation]));
    const confirmationStarts = [];
    const confirmationResults = await Promise.all(independentBindings.map(async (binding, index) => {
      const preparation = preparationByTask.get(binding.id);
      const startedAt = performance.now();
      confirmationStarts.push(startedAt);
      try {
        const paymentMethodId = await confirmPreparedBinding(session, preparation, binding.paymentMethodId);
        return { index, ok: true, binding: { ...binding, paymentMethodId } };
      } catch (error) {
        return { index, ok: false, preparation, error };
      }
    }));
    const confirmedBindings = confirmationResults
      .filter((result) => result.ok)
      .sort((a, b) => a.index - b.index)
      .map((result) => result.binding);
    const rejectedResults = confirmationResults.filter((result) => !result.ok);
    const rejectedPreparations = rejectedResults.map((result) => result.preparation).filter(Boolean);
    const confirmationFailures = new Map(rejectedResults.map((result) => [result.preparation && result.preparation.taskId, {
      code: String(result.error && result.error.code || "STRIPE_CARD_CONFIRM_FAILED"),
      message: String(result.error && result.error.message || "Stripe 绑卡确认失败。")
    }]));
    for (const result of rejectedResults) firstStripeFailure = firstStripeFailure || result.error;
    await cancelCardPreparations(rejectedPreparations, confirmationFailures);
    if (!confirmedBindings.length) {
      throw firstStripeFailure || new Error("Stripe.js 未确认任何 SetupIntent。");
    }
    const dispatchSkewMs = confirmationStarts.length > 1
      ? Math.max(...confirmationStarts) - Math.min(...confirmationStarts)
      : 0;
    const payload = await api("/api/tasks/batch/card-binding/complete", {
      method: "POST",
      body: JSON.stringify({ bindings: confirmedBindings, maxRetries: session.maxRetries })
    });
    const batch = payload.batch;
    mergeBatchTasks(batch.tasks);
    const failedIds = new Set((batch.failures || []).map((failure) => failure.id));
    const verificationFailures = session.preparations.filter((preparation) => failedIds.has(preparation.taskId));
    await cancelCardPreparations(verificationFailures);
    for (const task of batch.tasks || []) {
      if (task.state === "CARD_BOUND") session.completedTaskIds.add(task.id);
    }
    const completed = session.completedTaskIds.size;
    const requested = session.taskIds.length;
    await disposeCardBindingPanel({ cancel: false });
    await refresh({ quiet: true });
    setBatchMessage(
      `绑卡并提链完成：${completed}/${requested}；独立 Stripe 实例同步确认 ${confirmedBindings.length}/${independentBindings.length}，调用偏差 ${dispatchSkewMs.toFixed(2)}ms；已核验默认卡 ${batch.cardBound || 0}/${requested}；候选链接 ${batch.candidateReady || batch.checkoutReady || 0}/${requested}；已验证实时0元 ${batch.zeroAmountVerified || 0}/${requested}；准备重试 ${session.preparationRetryRounds}/${session.maxRetries}；PaymentMethod 重试 ${stripeRetryRounds}/${session.maxRetries}（${stripeRetryExecutions} 次，共生成 ${paymentMethodExecutions} 次）；US 核验与并行提链重试 ${batch.retryRounds}/${batch.maxRetries}（${batch.retryExecutions} 次）。`,
      completed === requested ? "success" : "error"
    );
    toast(`绑卡并提链完成 ${completed}/${requested}`);
  } catch (error) {
    await disposeCardBindingPanel();
    setSharedCardMessage(error && error.message || String(error), "error");
    setBatchMessage(error && error.message || String(error), "error");
  } finally {
    session.submitting = false;
    state.batchRunning = false;
    updateExportControls();
  }
}

elements.exportSelectAll.addEventListener("change", () => {
  const tasks = state.bootstrap && state.bootstrap.tasks || [];
  state.selectedExportTaskIds = elements.exportSelectAll.checked
    ? new Set(tasks.map((task) => task.id))
    : new Set();
  renderTasks();
});
elements.exportAccountsButton.addEventListener("click", exportSelectedAccounts);
elements.selectFailedButton.addEventListener("click", selectFailedTasks);
elements.batchRegisterButton.addEventListener("click", () => runSelectedBatch("registration", elements.batchRegisterButton));
elements.batchExtractButton.addEventListener("click", () => runSelectedBatch("checkout_link", elements.batchExtractButton));
elements.batchCardProfileButton.addEventListener("click", generateSelectedCardProfiles);
elements.batchCardBindButton.addEventListener("click", () => startBatchCardBinding());
elements.sharedCardSubmit.addEventListener("click", submitBatchCardBinding);
elements.sharedCardReload.addEventListener("click", async () => {
  const ids = state.cardBindingSession ? [...state.cardBindingSession.taskIds] : [...state.selectedExportTaskIds];
  await disposeCardBindingPanel();
  state.selectedExportTaskIds = new Set(ids);
  await startBatchCardBinding();
});
elements.batchSubscribeButton.addEventListener("click", () => runSelectedBatch("trial_payment", elements.batchSubscribeButton));
elements.refreshButton.addEventListener("click", async () => {
  await disposeCardBindingPanel();
  refresh();
});

for (const tab of elements.tabs) {
  tab.addEventListener("click", () => selectTab(tab.dataset.tab));
}
elements.plusSessionSource.addEventListener("input", () => {
  setPlusMessage();
  updatePlusControls();
});
elements.plusFileButton.addEventListener("click", () => elements.plusFileInput.click());
elements.plusFileInput.addEventListener("change", async () => {
  const file = elements.plusFileInput.files && elements.plusFileInput.files[0];
  if (!file) return;
  try {
    elements.plusSessionSource.value = await file.text();
    setPlusMessage(`已读取 ${file.name}，点击“开始批量验证”继续。`, "success");
  } catch (error) {
    setPlusMessage(error.message || "文件读取失败。", "error");
  } finally {
    elements.plusFileInput.value = "";
    updatePlusControls();
  }
});
elements.plusClearButton.addEventListener("click", () => {
  elements.plusSessionSource.value = "";
  setPlusMessage();
  resetPlusResults();
  updatePlusControls();
});
elements.plusVerifyButton.addEventListener("click", verifyImportedPlusSessions);

selectTab(localStorage.getItem("plusExtractorActiveTab") || "workflow");
updateAccountImportMode();
resetPlusResults();
refresh({ quiet: true });
setInterval(() => refresh({ quiet: true }), 4_000);
