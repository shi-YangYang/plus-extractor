"use strict";

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
  cardBindingSession: null
};

const elements = {
  health: document.querySelector("#health"),
  healthText: document.querySelector("#health-text"),
  apiAddress: document.querySelector("#api-address"),
  proxyForm: document.querySelector("#proxy-form"),
  proxyMessage: document.querySelector("#proxy-message"),
  usPool: document.querySelector("#us-pool"),
  trPool: document.querySelector("#tr-pool"),
  usCount: document.querySelector("#us-count"),
  trCount: document.querySelector("#tr-count"),
  usEndpoints: document.querySelector("#us-endpoints"),
  trEndpoints: document.querySelector("#tr-endpoints"),
  usProbe: document.querySelector("#us-probe"),
  trProbe: document.querySelector("#tr-probe"),
  pipeline: document.querySelector("#pipeline"),
  taskList: document.querySelector("#task-list"),
  taskDetail: document.querySelector("#task-detail"),
  registrationForm: document.querySelector("#registration-form"),
  accountSource: document.querySelector("#account-source"),
  mailboxProbeButton: document.querySelector("#mailbox-probe-button"),
  registrationMessage: document.querySelector("#registration-message"),
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
  sharedCardSection: document.querySelector("#shared-card-binding-section"),
  sharedCardCount: document.querySelector("#shared-card-binding-count"),
  sharedCardMount: document.querySelector("#shared-stripe-card"),
  sharedCardMessage: document.querySelector("#shared-card-binding-message"),
  sharedCardReload: document.querySelector("#batch-card-reload"),
  sharedCardSubmit: document.querySelector("#batch-card-submit"),
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

function updateRegistrationActions() {
  const pools = state.bootstrap && state.bootstrap.proxyPools;
  const proxiesReady = Boolean(pools && pools.US.configured && pools.TR.configured);
  const accountReady = Boolean(elements.accountSource.value.trim());
  elements.mailboxProbeButton.disabled = !proxiesReady || !accountReady;
  elements.createTaskButton.disabled = !proxiesReady || !accountReady;
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
  const concurrencyReady = count > 0 && count <= 10 && !state.batchRunning && !cardSessionActive;
  const selectedTasks = tasks.filter((task) => state.selectedExportTaskIds.has(task.id));
  const everySelectedIn = (states) => selectedTasks.length === count
    && selectedTasks.every((task) => states.includes(task.state));
  const hasRetryableFailures = FAILURE_SELECTION_GROUPS.some((group) => (
    tasks.some((task) => group.states.includes(task.state))
  ));
  const retryLimit = Number(state.bootstrap && state.bootstrap.batch && state.bootstrap.batch.maxRetries) || 10;
  elements.batchRetryCount.max = String(retryLimit);
  elements.exportCount.textContent = `已选择 ${count} 个账号${count > 10 ? " · 并发批次最多 10 个" : ""}`;
  elements.exportAccountsButton.disabled = count === 0 || state.batchRunning || cardSessionActive;
  elements.selectFailedButton.disabled = !hasRetryableFailures || state.batchRunning || cardSessionActive;
  elements.batchRetryCount.disabled = state.batchRunning || cardSessionActive;
  elements.batchRegisterButton.disabled = !concurrencyReady || !everySelectedIn(["QUEUED", "REGISTERING_BLOCKED", "REGISTRATION_BLOCKED", "REGISTRATION_FAILED"]);
  elements.batchExtractButton.disabled = !concurrencyReady || !everySelectedIn(["REGISTERED", "CHECKOUT_LINK_BLOCKED", "EXTRACTION_FAILED"]);
  elements.batchCardProfileButton.disabled = !concurrencyReady || !everySelectedIn(["CHECKOUT_LINK_READY", "CARD_BINDING_BLOCKED", "CARD_BINDING_FAILED", "TRIAL_PAYMENT_BLOCKED", "TRIAL_PAYMENT_FAILED"]);
  elements.batchCardBindButton.disabled = !concurrencyReady || !everySelectedIn(["CHECKOUT_LINK_READY", "CARD_BINDING_BLOCKED", "CARD_BINDING_FAILED", "TRIAL_PAYMENT_BLOCKED", "TRIAL_PAYMENT_FAILED"]);
  elements.batchSubscribeButton.disabled = !concurrencyReady || !everySelectedIn(["CARD_BOUND", "TRIAL_PAYMENT_BLOCKED", "TRIAL_PAYMENT_FAILED"]);
  elements.exportSelectAll.disabled = state.batchRunning || cardSessionActive;
  elements.exportSelectAll.checked = tasks.length > 0 && count === tasks.length;
  elements.exportSelectAll.indeterminate = count > 0 && count < tasks.length;
  if (!cardSessionActive) {
    elements.sharedCardCount.textContent = count
      ? `已选择 ${count} 个账号；完成提链的账号可以共用下方卡片并发绑定。`
      : "选择 1–10 个已完成提链的账号，然后点击“并发绑卡”。";
  }
}

function renderTasks() {
  const tasks = state.bootstrap.tasks || [];
  elements.taskList.replaceChildren();
  if (!tasks.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "尚无任务。配置 US 和 TR 代理池后创建第一条流水线。";
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
    const time = document.createElement("div");
    time.className = "task-time";
    time.textContent = `${task.account && task.account.account ? `${task.account.account} · ` : ""}${new Date(task.updatedAt).toLocaleString()}`;
    top.append(id, status);
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
  const id = document.createElement("p");
  const profile = task.account && task.account.profile
    ? ` · ${task.account.profile.fullName} · ${task.account.profile.age} 岁`
    : "";
  id.textContent = task.account
    ? `${task.account.account} · ${task.account.mailboxHost}${profile} · ${task.id}`
    : task.id;
  heading.append(title, id);
  const run = document.createElement("button");
  run.type = "button";
  run.className = "button primary";
  const hostedCardInputRequired = ["CHECKOUT_LINK_READY", "CARD_BINDING_BLOCKED", "CARD_BINDING_FAILED"].includes(task.state);
  const trialRunnable = ["CARD_BOUND", "TRIAL_PAYMENT_BLOCKED", "TRIAL_PAYMENT_FAILED"].includes(task.state);
  const trialAdapterReady = Boolean(
    state.bootstrap
    && state.bootstrap.adapters
    && state.bootstrap.adapters.trialPayment
    && state.bootstrap.adapters.trialPayment.ready
  );
  const promotionPending = trialRunnable
    && task.checkoutLink
    && task.checkoutLink.promotionApplied !== true;
  run.textContent = trialRunnable
    ? (promotionPending
      ? "刷新优惠资格"
      : (task.state === "CARD_BOUND" ? "一键订阅" : "重新尝试一键订阅"))
    : hostedCardInputRequired
    ? (task.cardProfile ? "请使用下方开始绑卡" : "请先生成绑卡资料")
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
    const promotionEligible = task.checkoutLink.promotionApplied === true;
    const promotionPending = task.checkoutLink.promotionStatus === "pending_payment_method";
    const eligibilityLabel = document.createElement("span");
    eligibilityLabel.className = `promotion-eligibility-label ${promotionEligible ? "eligible" : "not-eligible"}`;
    eligibilityLabel.textContent = promotionEligible
      ? "有优惠资格"
      : promotionPending
        ? "待绑卡后复核"
        : "无优惠资格";
    checkoutHeader.append(checkoutHeading, eligibilityLabel);
    const checkoutMeta = document.createElement("p");
    const flow = Array.isArray(task.checkoutLink.proxyFlow) ? task.checkoutLink.proxyFlow.join(" → ") : "US → TR";
    const promotion = task.checkoutLink.promotionApplied
      ? `${task.checkoutLink.campaignId || "活动"} 已应用`
      : promotionPending
        ? "普通链接已就绪，绑卡后重新校验活动"
        : "当前账号未检测到活动资格";
    checkoutMeta.textContent = `${flow} · ${promotion} · ${task.checkoutLink.route || "checkout"}`;
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
  const checkoutCompleted = task.stages.some((stage) => stage.key === "checkout_link" && stage.state === "COMPLETED");
  if (checkoutCompleted) {
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
    const canRebindAfterTrialBlock = ["TRIAL_PAYMENT_BLOCKED", "TRIAL_PAYMENT_FAILED"].includes(task.state);
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
      sharedNotice.textContent = "卡片输入已独立到账号列表上方；勾选 1–10 个账号后使用“并发绑卡”。";
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
  renderProxyRegion("US", state.bootstrap.proxyPools.US);
  renderProxyRegion("TR", state.bootstrap.proxyPools.TR);
  updateRegistrationActions();
  renderPipeline();
  renderTasks();
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
  const US = elements.usPool.value.trim();
  const TR = elements.trPool.value.trim();
  if (!US || !TR) {
    setProxyMessage("请同时填写 US 和 TR 代理池；保存会完整替换现有配置。", "error");
    return;
  }
  setProxyMessage("正在保存到本地后端…");
  try {
    const payload = await api("/api/proxy-pools", {
      method: "PUT",
      body: JSON.stringify({ US, TR })
    });
    state.bootstrap.proxyPools = payload.proxyPools;
    elements.usPool.value = "";
    elements.trPool.value = "";
    setProxyMessage("代理池已保存；输入框已清空，凭据不会从 API 回传。", "success");
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

elements.mailboxProbeButton.addEventListener("click", async () => {
  const accountLine = elements.accountSource.value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
  elements.mailboxProbeButton.disabled = true;
  elements.createTaskButton.disabled = true;
  setRegistrationMessage("正在通过 US 代理检查接码平台…");
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
  elements.mailboxProbeButton.disabled = true;
  elements.createTaskButton.disabled = true;
  setRegistrationMessage("正在批量识别账号并创建本地注册任务…");
  try {
    const payload = await api("/api/tasks/import", {
      method: "POST",
      body: JSON.stringify({ text })
    });
    const imported = payload.import;
    state.selectedTaskId = imported.tasks[0] && imported.tasks[0].id || null;
    elements.accountSource.value = "";
    await refresh({ quiet: true });
    setRegistrationMessage(`已导入 ${imported.count} 个任务；每次并发执行最多选择 10 个。`, "success");
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
  const promotionPending = task.checkoutLink && task.checkoutLink.promotionApplied !== true;
  const confirmed = window.confirm(
    promotionPending
      ? "确认刷新绑卡后的优惠资格？系统只会在免费优惠已应用且当前应付为 0 时发送订阅请求。"
      : "确认使用已绑定的默认支付方式订阅 ChatGPT Plus？当前优惠首月应付为 0；试用结束后将按结账页价格自动续费，除非提前取消。"
  );
  if (!confirmed) return;

  button.disabled = true;
  button.textContent = promotionPending ? "正在刷新并校验优惠…" : "正在更新账单并订阅…";
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
  const selected = failures.slice(0, 10);
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
  if (!ids.length || ids.length > 10) {
    setBatchMessage("请选择 1–10 个账号执行并发批次。", "error");
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
  setBatchMessage(`${labels[stage]}已启动：${ids.length}/10 个账号${stage === "trial_payment" ? "" : `，失败后最多自动重试 ${maxRetries} 次`}。`);
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
  if (!ids.length || ids.length > 10) {
    setBatchMessage("请选择 1–10 个账号生成绑卡信息。", "error");
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
    if (probe && probe.setupIntent) return stripe;
    lastError = probe && probe.error || lastError;
  }
  throw lastError || new Error("没有匹配当前 SetupIntent 的 Stripe 公钥。");
}

function setSharedCardMessage(text, kind = "") {
  elements.sharedCardMessage.textContent = text;
  elements.sharedCardMessage.className = kind ? `card-binding-message ${kind}` : "card-binding-message";
  elements.sharedCardSection.dataset.state = kind === "error" ? "error" : kind === "success" ? "ready" : "running";
}

function resetSharedCardPanel(message = "尚未准备批量绑卡会话。") {
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

async function cancelCardPreparations(preparations = []) {
  await Promise.all(preparations.map((preparation) => api(`/api/tasks/${preparation.taskId}/card-binding/cancel`, {
    method: "POST",
    body: JSON.stringify({ token: preparation.token })
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
  if (!ids.length || ids.length > 10) {
    setBatchMessage("请选择 1–10 个账号执行并发绑卡。", "error");
    return;
  }
  const maxRetries = readCardBindingRetryCount();
  if (maxRetries == null) return;
  if (state.cardBindingSession) await disposeCardBindingPanel();
  state.batchRunning = true;
  elements.batchCardBindButton.textContent = "并发准备中…";
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
      preparations: batch.preparations,
      completedTaskIds: new Set(),
      maxRetries,
      retryDelayMs: Number(batch.retryDelayMs || state.bootstrap && state.bootstrap.batch && state.bootstrap.batch.retryDelayMs) || 0,
      preparationRetryRounds: Number(batch.retryRounds || 0),
      stripe: null,
      cardElement: null,
      disposed: false
    };
    state.cardBindingSession = session;
    await loadStripeJs();
    session.stripe = await resolveStripeForIntent(batch.preparations[0].clientSecret, batch.preparations[0].publishableKeys);
    const intentChecks = await Promise.all(batch.preparations.map((preparation) => session.stripe.retrieveSetupIntent(preparation.clientSecret)));
    const unmatched = intentChecks.find((result) => !result || !result.setupIntent);
    if (unmatched) throw unmatched.error || new Error("批量 SetupIntent 未使用同一 Stripe 公钥。 ");
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
      elements.sharedCardCount.textContent = `${batch.prepared}/${batch.requested} 个账号已准备；卡资料只需填写一次。`;
      setSharedCardMessage("Stripe 卡输入框已就绪，可以并发确认。", "success");
    });
    session.cardElement.on("change", (event) => {
      if (event.error) setSharedCardMessage(event.error.message, "error");
      else if (event.complete) setSharedCardMessage("卡资料填写完成，可以确认并发绑定。", "success");
      else setSharedCardMessage("请填写卡号、有效期和 CVC。");
    });
    session.cardElement.on("loaderror", (event) => {
      elements.sharedCardSubmit.disabled = true;
      elements.sharedCardReload.disabled = false;
      setSharedCardMessage(event && event.error && event.error.message || "Stripe 卡输入框加载失败。", "error");
    });
    setBatchMessage(`并发绑卡已准备 ${batch.prepared}/${batch.requested} 个账号；请在独立卡片中填写一次卡资料。`, batch.failures.length ? "error" : "success");
  } catch (error) {
    if (state.cardBindingSession) await disposeCardBindingPanel();
    setSharedCardMessage(error.message || String(error), "error");
    setBatchMessage(error.message || String(error), "error");
  } finally {
    state.batchRunning = false;
    elements.batchCardBindButton.textContent = "并发绑卡";
    updateExportControls();
  }
}

async function submitBatchCardBinding() {
  const session = state.cardBindingSession;
  if (!session || !session.cardElement || session.disposed) return;
  state.batchRunning = true;
  elements.sharedCardSubmit.disabled = true;
  elements.sharedCardReload.disabled = true;
  setSharedCardMessage(`?????? ${session.preparations.length} ? SetupIntent?`);
  updateExportControls();
  try {
    const bindings = [];
    const finalRejectedPreparations = [];
    let pending = [...session.preparations];
    let stripeRetryRounds = 0;
    let stripeRetryExecutions = 0;
    let maxDispatchSkewMs = 0;
    let firstStripeFailure = null;
    while (pending.length) {
      const roundDispatchTimes = [];
      const confirmationPromises = pending.map((preparation) => {
        roundDispatchTimes.push(performance.now());
        return session.stripe.confirmCardSetup(preparation.clientSecret, {
          payment_method: {
            card: session.cardElement,
            billing_details: preparation.billing,
            allow_redisplay: "always"
          },
          set_as_default_payment_method: true
        }).then((result) => {
          if (result.error) throw result.error;
          if (!result.setupIntent || result.setupIntent.status !== "succeeded") {
            throw new Error(`SetupIntent ?????${result.setupIntent && result.setupIntent.status || "unknown"}`);
          }
          const paymentMethod = result.setupIntent.payment_method;
          const paymentMethodId = typeof paymentMethod === "string" ? paymentMethod : paymentMethod && paymentMethod.id;
          if (!paymentMethodId) throw new Error("Stripe ??? payment method id?");
          return {
            id: preparation.taskId,
            token: preparation.token,
            setupIntentId: result.setupIntent.id,
            paymentMethodId
          };
        });
      });
      if (roundDispatchTimes.length > 1) {
        maxDispatchSkewMs = Math.max(maxDispatchSkewMs,
          Math.max(...roundDispatchTimes) - Math.min(...roundDispatchTimes));
      }
      const settled = await Promise.allSettled(confirmationPromises);
      const retryable = [];
      for (let index = 0; index < settled.length; index += 1) {
        const outcome = settled[index];
        if (outcome.status === "fulfilled") bindings.push(outcome.value);
        else {
          firstStripeFailure = firstStripeFailure || outcome.reason;
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
        `Stripe ???? ${retryable.length} ??${session.retryDelayMs / 1000} ?????? ${stripeRetryRounds}/${session.maxRetries}?`,
        "error"
      );
      if (session.retryDelayMs) await new Promise((resolve) => setTimeout(resolve, session.retryDelayMs));
      pending = retryable;
    }
    await cancelCardPreparations(finalRejectedPreparations);
    if (!bindings.length) {
      throw firstStripeFailure || new Error("Stripe ????? SetupIntent?");
    }
    const payload = await api("/api/tasks/batch/card-binding/complete", {
      method: "POST",
      body: JSON.stringify({ bindings, maxRetries: session.maxRetries })
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
      `???????${completed}/${requested}????? ${session.preparationRetryRounds}/${session.maxRetries}?Stripe ?? ${stripeRetryRounds}/${session.maxRetries}?${stripeRetryExecutions} ?????US ???? ${batch.retryRounds}/${batch.maxRetries}?${batch.retryExecutions} ??????????? ${maxDispatchSkewMs.toFixed(3)} ms?`,
      completed === requested ? "success" : "error"
    );
    toast(`?????? ${completed}/${requested}`);
  } catch (error) {
    await disposeCardBindingPanel();
    setSharedCardMessage(error && error.message || String(error), "error");
    setBatchMessage(error && error.message || String(error), "error");
  } finally {
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

refresh({ quiet: true });
setInterval(() => refresh({ quiet: true }), 4_000);
