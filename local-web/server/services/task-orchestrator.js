"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { AppError } = require("../lib/errors");
const { sanitizeText } = require("../lib/sanitize");
const { summarizeProxy } = require("../lib/proxy");

const PIPELINE = Object.freeze([
  { key: "registration", label: "iCloud 注册 ChatGPT", proxy: "任意地区", state: "PENDING" },
  { key: "card_binding", label: "绑定支付方式", proxy: "US", state: "READY" },
  { key: "checkout_link", label: "绑卡后提取结账链接", proxy: "US → TR", state: "PENDING" },
  { key: "trial_payment", label: "US 账单与一键订阅", proxy: "US", state: "PENDING" }
]);
const CARD_BINDABLE_STATES = new Set([
  "REGISTERED",
  "CARD_BINDING_READY",
  "CHECKOUT_LINK_READY",
  "CHECKOUT_LINK_BLOCKED",
  "EXTRACTION_FAILED",
  "CARD_BINDING_BLOCKED",
  "CARD_BINDING_FAILED",
  "TRIAL_PAYMENT_BLOCKED",
  "TRIAL_PAYMENT_FAILED"
]);
const BLOCKED_STAGE_CODES = new Set([
  "TRIAL_SUBSCRIPTION_REJECTED",
  "TRIAL_SUBSCRIPTION_ACTION_REQUIRED",
  "TRIAL_CARD_PAYMENT_UNAVAILABLE"
]);
const ACCOUNT_EXPORT_FORMATS = Object.freeze(["email_url", "access_token"]);
const MAX_EXPORT_ACCOUNTS = 500;
const MAX_EXPORT_REFRESH_CONCURRENCY = 10;
const MAX_IMPORT_ACCOUNTS = 500;
const MAX_IMPORT_CONCURRENCY = 10;
const MAX_BATCH_RETRIES = 10;
const DEFAULT_BATCH_RETRY_DELAY_MS = 5_000;
const BATCH_RUN_STATES = Object.freeze({
  registration: new Set(["QUEUED", "REGISTERING_BLOCKED", "REGISTRATION_BLOCKED", "REGISTRATION_FAILED"]),
  checkout_link: new Set(["CHECKOUT_LINK_BLOCKED", "EXTRACTION_FAILED"]),
  trial_payment: new Set(["CARD_BOUND", "TRIAL_PAYMENT_BLOCKED", "TRIAL_PAYMENT_FAILED"])
});
const BATCH_SUCCESS_STATES = Object.freeze({
  registration: "REGISTERED",
  checkout_link: "CARD_BOUND",
  trial_payment: "TRIAL_ACTIVE"
});
const INTERRUPTED_STATE_RECOVERY = Object.freeze({
  REGISTERING: Object.freeze({ state: "REGISTRATION_FAILED", stage: "registration" }),
  BINDING_CARD: Object.freeze({ state: "CARD_BINDING_FAILED", stage: "card_binding" }),
  EXTRACTING_CHECKOUT_LINK: Object.freeze({ state: "EXTRACTION_FAILED", stage: "checkout_link" }),
  REQUESTING_TRIAL: Object.freeze({ state: "TRIAL_PAYMENT_FAILED", stage: "trial_payment" })
});

function checkoutCreatedAfterCardBinding(task) {
  const checkoutAt = Date.parse(task && task.context && task.context.checkout_link
    && task.context.checkout_link.extractedAt || "");
  const boundAt = Date.parse(task && task.context && task.context.card_binding
    && task.context.card_binding.boundAt || "");
  return Number.isFinite(checkoutAt) && Number.isFinite(boundAt) && checkoutAt > boundAt;
}

function checkoutHasVerifiedZeroAmount(checkout) {
  if (!checkout || checkout.dueTodayMinorUnits == null) return false;
  const dueTodayMinorUnits = Number(checkout.dueTodayMinorUnits);
  return Number.isFinite(dueTodayMinorUnits) && dueTodayMinorUnits === 0
    && (checkout.zeroAmountVerified === true || checkout.fullDiscountVerified === true);
}

function normalizePlusTrialEligibility(input) {
  if (!input || typeof input !== "object") return null;
  const status = String(input.status || "").trim().toLowerCase();
  if (!["eligible", "ineligible", "unknown"].includes(status)) return null;
  return Object.freeze({
    campaignId: String(input.campaignId || "plus-1-month-free").slice(0, 120),
    status,
    eligible: status === "eligible" && input.eligible === true,
    redeemed: input.redeemed === true,
    couponStatus: String(input.couponStatus || "unknown").slice(0, 80),
    couponHttpStatus: Number(input.couponHttpStatus) || 0,
    buttonVisible: input.buttonVisible === true,
    source: String(input.source || "unavailable").slice(0, 80),
    checkedAt: input.checkedAt || null
  });
}

function checkoutUsesBangKaProtocol(checkout) {
  return Boolean(checkout
    && checkout.protocolMode === "bangka_oaics"
    && checkout.sessionKind === "oaics");
}

function checkoutRequiresSubscriptionRefresh(task) {
  const checkout = task && task.context && task.context.checkout_link;
  if (checkoutUsesBangKaProtocol(checkout)) return false;
  if (!checkoutCreatedAfterCardBinding(task)) return true;
  return Boolean(checkout
    && checkout.sessionKind === "standard"
    && checkout.promotionVerification !== "stripe_custom_checkout");
}

function candidateCheckoutFromSeed(seed, now = new Date()) {
  const checkoutUrl = String(seed && (seed.checkout_url || seed.checkoutUrl) || "").trim();
  let parsed;
  try {
    parsed = new URL(checkoutUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "chatgpt.com"
      || !/^\/checkout\/openai_llc\/(?:oaics_|cs_(?:live|test)_)[A-Za-z0-9_-]{8,255}$/.test(parsed.pathname)) {
    return null;
  }
  const sessionToken = parsed.pathname.split("/").at(-1);
  return Object.freeze({
    checkoutUrl,
    campaignId: "plus-1-month-free",
    promotionApplied: false,
    fullDiscountVerified: false,
    zeroAmountVerified: false,
    discountPercent: null,
    subtotalMinorUnits: null,
    discountMinorUnits: null,
    dueTodayMinorUnits: null,
    promotionStatus: "pending_protocol_submission",
    promotionVerification: "unverified",
    sessionKind: sessionToken.startsWith("oaics_") ? "oaics" : "standard",
    route: "chatgpt_internal",
    checkoutCountry: "US",
    proxyFlow: Object.freeze(["US"]),
    extractedAt: now.toISOString()
  });
}

function cardBindingFallbackState(task) {
  const checkout = task && task.context && task.context.checkout_link;
  const cardBinding = task && task.context && task.context.card_binding;
  if (cardBinding && checkoutCreatedAfterCardBinding(task) && checkoutHasVerifiedZeroAmount(checkout)) {
    return "CARD_BOUND";
  }
  if (cardBinding) return "EXTRACTION_FAILED";
  if (checkoutHasVerifiedZeroAmount(checkout)) return "CHECKOUT_LINK_READY";
  return task && task.context && task.context.accountSession ? "REGISTERED" : "QUEUED";
}

function maskImportedAccount(email, accountId) {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const match = normalizedEmail.match(/^([^@]+)@([^@]+)$/);
  if (match) {
    const local = match[1];
    const visible = local.length <= 2 ? local[0] || "*" : `${local.slice(0, 2)}***${local.slice(-1)}`;
    return `${visible}@${match[2]}`;
  }
  const suffix = String(accountId || "").replace(/[^A-Za-z0-9]/g, "").slice(-6) || "account";
  return `AT ••••${suffix}`;
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

class TaskOrchestrator {
  constructor({
    store,
    proxyPools,
    adapters,
    profileAddressGenerator = null,
    sessionDirectory = null,
    accountExportClient = null,
    accountSessionImporter = null,
    operationSettings = null,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    batchRetryDelayMs = DEFAULT_BATCH_RETRY_DELAY_MS
  }) {
    this.store = store;
    this.proxyPools = proxyPools;
    this.adapters = adapters;
    this.profileAddressGenerator = profileAddressGenerator;
    this.sessionDirectory = sessionDirectory ? path.resolve(sessionDirectory) : null;
    this.accountExportClient = accountExportClient;
    this.accountSessionImporter = accountSessionImporter;
    this.operationSettings = operationSettings;
    this.sleep = sleep;
    const parsedRetryDelay = Number(batchRetryDelayMs);
    this.batchRetryDelayMs = Number.isFinite(parsedRetryDelay)
      ? Math.max(0, Math.min(parsedRetryDelay, 60_000))
      : DEFAULT_BATCH_RETRY_DELAY_MS;
    this.tasks = [];
    this.running = new Set();
    this.abortControllers = new Map();
    this.terminationRequests = new Set();
  }

  async init() {
    const stored = await this.store.read();
    this.tasks = Array.isArray(stored.tasks) ? stored.tasks : [];
    let migrated = false;
    for (const task of this.tasks) {
      const existingStages = new Map((task.stages || []).map((stage) => [stage.key, stage]));
      const reorderedStages = PIPELINE.map((definition) => existingStages.get(definition.key) || { ...definition });
      if (reorderedStages.map((stage) => stage.key).join(",") !== (task.stages || []).map((stage) => stage.key).join(",")) {
        task.stages = reorderedStages;
        migrated = true;
      }
      const interrupted = INTERRUPTED_STATE_RECOVERY[task.state];
      if (interrupted) {
        const previousState = task.state;
        task.state = interrupted.state;
        task.currentStage = interrupted.stage;
        const stage = (task.stages || []).find((candidate) => candidate.key === interrupted.stage);
        if (stage) stage.state = "FAILED";
        task.updatedAt = new Date().toISOString();
        this.log(task, "warning", "An interrupted in-flight operation was recovered after service restart.", {
          code: "TASK_INTERRUPTED_BY_RESTART",
          previousState,
          recoveredState: interrupted.state
        });
        migrated = true;
      }
      const lastError = [...(task.logs || [])].reverse().find((entry) => entry.level === "error");
      const code = String(lastError && lastError.details && lastError.details.code || "");
      if (task.state === "TRIAL_PAYMENT_FAILED" && BLOCKED_STAGE_CODES.has(code)) {
        task.state = "TRIAL_PAYMENT_BLOCKED";
        const stage = (task.stages || []).find((candidate) => candidate.key === "trial_payment");
        if (stage) stage.state = "BLOCKED";
        task.updatedAt = new Date().toISOString();
        migrated = true;
      }
      const checkout = task.context && task.context.checkout_link;
      if (task.state === "CHECKOUT_LINK_READY" && checkout && checkout.dueTodayMinorUnits != null
          && Number(checkout.dueTodayMinorUnits) > 0) {
        task.state = "EXTRACTION_FAILED";
        task.currentStage = "checkout_link";
        checkout.fullDiscountVerified = false;
        checkout.promotionStatus = "nonzero_due";
        const stage = (task.stages || []).find((candidate) => candidate.key === "checkout_link");
        if (stage) stage.state = "FAILED";
        task.updatedAt = new Date().toISOString();
        this.log(task, "error", "Stored Checkout has a nonzero amount due today.", {
          code: "CHECKOUT_FULL_DISCOUNT_NOT_VERIFIED"
        });
        migrated = true;
      }
    }
    if (migrated) await this.persist();
  }

  pipeline() {
    return PIPELINE.map((stage) => ({ ...stage }));
  }

  operationSnapshot() {
    const configured = this.operationSettings && typeof this.operationSettings.summary === "function"
      ? this.operationSettings.summary()
      : { maxAccountOperations: 10, registrationMode: "protocol" };
    const maxAccountOperations = Number(configured.maxAccountOperations);
    const limit = Number.isInteger(maxAccountOperations) && maxAccountOperations >= 1 && maxAccountOperations <= 30
      ? maxAccountOperations
      : 10;
    const registrationMode = configured.registrationMode === "roxybrowser" ? "roxybrowser" : "protocol";
    return Object.freeze({
      limit,
      registrationMode,
      roxyWindowCount: Math.ceil(limit / 2),
      accountsPerRoxyWindow: 2,
      maxRoxyWindows: 15
    });
  }

  batchConfiguration() {
    const operation = this.operationSnapshot();
    return Object.freeze({
      maxConcurrency: operation.limit,
      maxAccountOperations: operation.limit,
      registrationMode: operation.registrationMode,
      roxyWindowCount: operation.roxyWindowCount,
      accountsPerRoxyWindow: operation.accountsPerRoxyWindow,
      maxRoxyWindows: operation.maxRoxyWindows,
      maxImportSize: MAX_IMPORT_ACCOUNTS,
      accountImportFormats: Object.freeze(["email_url", "access_token"]),
      accessTokenImportConcurrency: MAX_IMPORT_CONCURRENCY,
      maxRetries: MAX_BATCH_RETRIES,
      defaultRetries: 2,
      retryDelayMs: this.batchRetryDelayMs,
      stages: ["registration", "card_binding", "checkout_link", "trial_payment"],
      authSessionExportMode: "registration_cache_parallel_refresh",
      authSessionRefreshConcurrency: MAX_EXPORT_REFRESH_CONCURRENCY,
      cardProfileBatchMaxConcurrency: operation.limit,
      cardBindingMode: "unique_payment_method_browser_instance_barrier_bind_then_extract",
      cardBindingMaxConcurrency: operation.limit,
      cardBindingAutoRetry: true,
      checkoutLinkMode: "parallel_isolated_browser_processes",
      subscriptionMode: "synchronized_browser_process_barrier"
    });
  }

  adapterStatus() {
    return Object.fromEntries(
      Object.entries(this.adapters).map(([key, adapter]) => [key, adapter.describe()])
    );
  }

  list() {
    return [...this.tasks]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((task) => this.publicTask(task));
  }

  find(id) {
    const task = this.tasks.find((candidate) => candidate.id === id);
    if (!task) throw new AppError(404, "TASK_NOT_FOUND", "任务不存在。");
    return task;
  }

  get(id) {
    return this.publicTask(this.find(id));
  }

  async delete(id) {
    const task = this.find(id);
    if (this.running.has(id)) {
      throw new AppError(409, "TASK_DELETE_RUNNING", "任务执行期间不能删除账号。");
    }

    const previousTasks = this.tasks;
    this.tasks = previousTasks.filter((candidate) => candidate.id !== id);
    try {
      await this.persist();
    } catch (error) {
      this.tasks = previousTasks;
      throw error;
    }

    let cardBindingDiscarded = false;
    const cardBinding = this.adapters && this.adapters.cardBinding;
    if (cardBinding && typeof cardBinding.discard === "function") {
      try {
        const result = await cardBinding.discard({ taskId: id });
        cardBindingDiscarded = Boolean(result && result.discarded);
      } catch (_) {
        cardBindingDiscarded = false;
      }
    }

    const sessionRemoved = await this.removeSavedSession(task);
    return Object.freeze({
      id,
      deleted: true,
      sessionRemoved,
      cardBindingDiscarded
    });
  }

  async abandon(id) {
    const task = this.find(id);
    if (this.running.has(id)) {
      throw new AppError(409, "TASK_ABANDON_RUNNING", "The account cannot be abandoned while its task is running.");
    }
    if (task.state === "ABANDONED") return this.publicTask(task);

    const cardBinding = this.adapters && this.adapters.cardBinding;
    if (cardBinding && typeof cardBinding.discard === "function") {
      await cardBinding.discard({ taskId: id }).catch(() => {});
    }
    const now = new Date().toISOString();
    task.state = "ABANDONED";
    task.currentStage = "abandoned";
    task.abandonedAt = now;
    task.updatedAt = now;
    task.context = task.context || {};
    task.context.card_binding = null;
    task.context.trial_payment = null;
    for (const stage of task.stages || []) {
      if (stage.state !== "COMPLETED") stage.state = "SKIPPED";
    }
    this.log(task, "warning", "账号已标记为废弃；保留邮箱、接码地址和登录会话供按需导出");
    await this.persist();
    return this.publicTask(task);
  }

  async terminate(id) {
    const task = this.find(id);
    const controller = this.abortControllers.get(id);
    if (!this.running.has(id) || !controller) {
      throw new AppError(409, "TASK_NOT_RUNNING", "The selected task does not have an active interruptible operation.");
    }
    if (!this.terminationRequests.has(id)) {
      this.terminationRequests.add(id);
      task.updatedAt = new Date().toISOString();
      this.log(task, "warning", "User requested termination of the current in-flight operation.", {
        code: "TASK_TERMINATION_REQUESTED",
        stage: task.currentStage
      });
      controller.abort(new AppError(409, "TASK_TERMINATED", "The current task was terminated by the user."));
      await this.persist();
    }
    return Object.freeze({ terminationRequested: true, task: this.publicTask(task) });
  }

  async exportAccounts(input = {}) {
    const format = String(input.format || "").trim().toLowerCase();
    if (!ACCOUNT_EXPORT_FORMATS.includes(format)) {
      throw new AppError(400, "ACCOUNT_EXPORT_FORMAT_INVALID", "Export format must be email_url or access_token.");
    }
    const ids = [...new Set((Array.isArray(input.ids) ? input.ids : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean))];
    if (!ids.length) throw new AppError(400, "ACCOUNT_EXPORT_SELECTION_REQUIRED", "Select at least one account to export.");
    if (ids.length > MAX_EXPORT_ACCOUNTS) {
      throw new AppError(400, "ACCOUNT_EXPORT_SELECTION_TOO_LARGE", `At most ${MAX_EXPORT_ACCOUNTS} accounts can be exported at once.`);
    }

    const selected = ids.map((id) => this.find(id));
    const lines = [];
    const failures = [];
    const results = await mapWithConcurrency(selected, MAX_EXPORT_REFRESH_CONCURRENCY, async (task, index) => {
      try {
        if (format === "email_url") {
          const registration = task.context && task.context.registration;
          const email = String(registration && registration.email || "").trim();
          const inboxUrl = String(registration && registration.inboxUrl || "").trim();
          if (!email || !inboxUrl) {
            throw new AppError(409, "ACCOUNT_EXPORT_SOURCE_MISSING", "The account is missing its email or mailbox URL.");
          }
          return { line: `${email}---${inboxUrl}` };
        } else {
          if (!this.accountExportClient || typeof this.accountExportClient.readAuthSession !== "function") {
            throw new AppError(503, "ACCOUNT_EXPORT_CLIENT_MISSING", "The auth-session JSON export client is not initialized.");
          }
          const accountSession = task.context && task.context.accountSession;
          const proxy = this.proxyPools.select("US", task.logs.length + index);
          const authSession = await this.accountExportClient.readAuthSession({
            taskId: task.id,
            accountSession,
            proxy
          });
          if (!authSession || typeof authSession !== "object" || Array.isArray(authSession)) {
            throw new AppError(502, "ACCOUNT_EXPORT_SESSION_INVALID", "The session endpoint returned an invalid JSON document.");
          }
          const sessionLine = JSON.stringify(authSession);
          if (!sessionLine) {
            throw new AppError(502, "ACCOUNT_EXPORT_SESSION_INVALID", "The session endpoint returned an empty JSON document.");
          }
          return { line: sessionLine };
        }
      } catch (error) {
        return { failure: {
          id: task.id,
          account: task.account && task.account.account || task.id,
          error: String(error && error.code || "ACCOUNT_EXPORT_FAILED"),
          message: sanitizeText(error && error.message, 200)
        } };
      }
    });
    for (const result of results) {
      if (result.line) lines.push(result.line);
      else failures.push(result.failure);
    }
    if (!lines.length) {
      throw new AppError(409, "ACCOUNT_EXPORT_EMPTY", failures[0] && failures[0].message || "No accounts were exported.");
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filenameType = format === "access_token" ? "auth-session-json" : "email-url";
    return Object.freeze({
      format,
      recordType: format === "access_token" ? "auth_session_json" : "email_url",
      filename: `plus-extractor-${filenameType}-${stamp}.txt`,
      mediaType: "text/plain; charset=utf-8",
      count: lines.length,
      requested: selected.length,
      content: `${lines.join("\n")}\n`,
      failures
    });
  }

  savedSessionPath(task) {
    const session = task && task.context && task.context.accountSession;
    if (
      !this.sessionDirectory
      || !session
      || session.kind !== "playwright_storage_state"
      || typeof session.path !== "string"
    ) {
      return null;
    }

    const candidate = path.resolve(session.path);
    const relative = path.relative(this.sessionDirectory, candidate);
    const outsideDirectory = !relative
      || relative === ".."
      || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative);
    if (outsideDirectory || !candidate.toLowerCase().endsWith(".storage.json")) return null;
    return candidate;
  }

  savedAuthSessionPath(task) {
    const session = task && task.context && task.context.accountSession;
    if (!this.sessionDirectory || !session) return null;
    const explicit = String(session.authSessionPath || "").trim();
    const storagePath = String(session.path || "").trim();
    const derived = storagePath.toLowerCase().endsWith(".storage.json")
      ? storagePath.slice(0, -".storage.json".length) + ".auth-session.json"
      : "";
    if (!explicit && !derived) return null;
    const candidate = path.resolve(explicit || derived);
    const relative = path.relative(this.sessionDirectory, candidate);
    const outsideDirectory = !relative
      || relative === ".."
      || relative.startsWith(`..${path.sep}`)
      || path.isAbsolute(relative);
    if (outsideDirectory || !candidate.toLowerCase().endsWith(".auth-session.json")) return null;
    return candidate;
  }

  resolveSavedBrowserSession(input = {}) {
    const email = String(input.email || "").trim().toLowerCase();
    if (!email) return null;
    const task = this.tasks.find((candidate) => (
      String(candidate && candidate.context && candidate.context.registration
        && candidate.context.registration.email || "").trim().toLowerCase() === email
    ));
    if (!task) return null;
    const sessionPath = this.savedSessionPath(task);
    if (!sessionPath) return null;
    return Object.freeze({
      taskId: task.id,
      accountSession: Object.freeze({
        kind: "playwright_storage_state",
        path: sessionPath
      })
    });
  }

  async removeSavedSession(task) {
    const paths = [this.savedSessionPath(task), this.savedAuthSessionPath(task)].filter(Boolean);
    let removed = false;
    for (const sessionPath of paths) {
      try {
        await fs.unlink(sessionPath);
        removed = true;
      } catch (_) {
        // Missing or already-removed session artifacts do not block account deletion.
      }
    }
    return removed;
  }

  async generateCardProfile(id) {
    const task = this.find(id);
    if (!CARD_BINDABLE_STATES.has(task.state)) {
      throw new AppError(409, "CARD_PROFILE_STATE_INVALID", `Card profile generation is not available from ${task.state}.`);
    }
    if (!task.context || !task.context.accountSession) {
      throw new AppError(409, "ACCOUNT_SESSION_REQUIRED", "Card profile generation requires a saved account session.");
    }
    if (!this.profileAddressGenerator) {
      throw new AppError(503, "PROFILE_ADDRESS_GENERATOR_MISSING", "The profile-address generator is not initialized.");
    }
    const generated = this.profileAddressGenerator.generate();
    task.context = task.context || {};
    task.context.card_profile = generated;
    task.updatedAt = new Date().toISOString();
    this.log(task, "success", "已生成绑卡所需的姓名、邮编和完整地址");
    await this.persist();
    return this.publicTask(task);
  }

  async generateCardProfileBatch(input = {}) {
    const limit = this.operationSnapshot().limit;
    const tasks = this.normalizeCardBindingBatchTasks(input, limit);
    if (!this.profileAddressGenerator) {
      throw new AppError(503, "PROFILE_ADDRESS_GENERATOR_MISSING", "The profile-address generator is not initialized.");
    }
    const generatedAt = new Date().toISOString();
    for (const task of tasks) {
      task.context = task.context || {};
      task.context.card_profile = this.profileAddressGenerator.generate();
      task.updatedAt = generatedAt;
      this.log(task, "success", "Batch action generated a fresh billing name and address for the selected account.");
    }
    await this.persist();
    return Object.freeze({
      stage: "card_profile",
      mode: "parallel_profile_generation",
      limit,
      requested: tasks.length,
      generated: tasks.length,
      tasks: Object.freeze(tasks.map((task) => this.publicTask(task)))
    });
  }

  async prepareCardBinding(id) {
    const task = this.find(id);
    if (this.running.has(id)) throw new AppError(409, "TASK_ALREADY_RUNNING", "任务正在执行。");
    if (!CARD_BINDABLE_STATES.has(task.state)) {
      throw new AppError(409, "CARD_BINDING_STATE_INVALID", `当前状态不能准备绑卡：${task.state}`);
    }
    if (!task.context || !task.context.card_profile) {
      throw new AppError(409, "CARD_PROFILE_REQUIRED", "请先生成绑卡姓名和地址。");
    }
    if (!task.context.accountSession) {
      throw new AppError(409, "ACCOUNT_SESSION_REQUIRED", "绑卡阶段需要已保存的登录会话。");
    }
    this.running.add(id);
    const proxy = this.proxyPools.select("US", task.logs.length);
    try {
      task.currentStage = "card_binding";
      task.updatedAt = new Date().toISOString();
      this.log(task, "info", "正在准备 Stripe 托管卡输入框", {
        proxies: { US: summarizeProxy(proxy, 0).endpoint }
      });
      await this.persist();
      const preparation = await this.adapters.cardBinding.prepare({
        taskId: task.id,
        proxy,
        accountSession: task.context.accountSession,
        cardProfile: task.context.card_profile,
        reportProgress: async (message, details = undefined) => {
          task.updatedAt = new Date().toISOString();
          this.log(task, "info", message, details);
          await this.persist();
        }
      });
      const replacingExistingCard = Boolean(task.context.card_binding);
      task.state = "CARD_BINDING_READY";
      this.setStage(task, "card_binding", "READY");
      task.updatedAt = new Date().toISOString();
      this.log(task, "success", replacingExistingCard
        ? "重新绑卡会话已准备；原支付方式在新卡完成核验前保持不变"
        : "一次性绑卡会话已准备；绑定成功后将立即在同一粘性会话提链", {
        expiresAt: preparation.expiresAt
      });
      await this.persist();
      return preparation;
    } catch (error) {
      task.state = "CARD_BINDING_FAILED";
      task.currentStage = "card_binding";
      this.setStage(task, "card_binding", "FAILED");
      task.updatedAt = new Date().toISOString();
      this.log(task, "error", sanitizeText(error && error.message, 300), {
        code: error && error.code || "CARD_BINDING_PREPARE_FAILED"
      });
      await this.persist();
      throw error;
    } finally {
      this.running.delete(id);
    }
  }

  async completeCardBinding(id, input = {}) {
    const task = this.find(id);
    if (this.running.has(id)) throw new AppError(409, "TASK_ALREADY_RUNNING", "任务正在执行。");
    if (!CARD_BINDABLE_STATES.has(task.state)) {
      throw new AppError(409, "CARD_BINDING_STATE_INVALID", `当前状态不允许绑卡：${task.state}`);
    }
    this.running.add(id);
    const usProxy = this.proxyPools.select("US", task.logs.length);
    task.state = "BINDING_CARD";
    task.currentStage = "card_binding";
    task.updatedAt = new Date().toISOString();
    this.setStage(task, "card_binding", "RUNNING");
    this.log(task, "info", "Stripe 已确认支付方式，正在 US 会话核验默认卡并保存候选 Checkout。", {
      proxies: { US: summarizeProxy(usProxy, 0).endpoint }
    });
    await this.persist();
    let cardVerified = false;
    try {
      const result = await this.adapters.cardBinding.complete({
        taskId: task.id,
        proxy: usProxy,
        token: input.token,
        setupIntentId: input.setupIntentId,
        paymentMethodId: input.paymentMethodId,
        accountSession: task.context.accountSession,
        reportProgress: async (message, details = undefined) => {
          task.updatedAt = new Date().toISOString();
          this.log(task, "info", message, details);
          await this.persist();
        }
      });
      task.context.card_binding = normalizeCardBindingResult(result);
      task.context.checkout_seed = result && result.checkoutSeed || null;
      delete task.context.checkout_link;
      delete task.context.checkoutUrl;
      cardVerified = true;
      task.context.checkout_flow_session_id = String(result && result.flowSessionId || "").trim();
      delete task.context.trial_payment;
      const proxies = {
        US: usProxy,
        TR: this.proxyPools.select("TR", task.logs.length + 1)
      };
      task.state = "EXTRACTING_CHECKOUT_LINK";
      task.currentStage = "checkout_link";
      this.setStage(task, "card_binding", "COMPLETED");
      this.setStage(task, "checkout_link", "RUNNING");
      this.setStage(task, "trial_payment", "PENDING");
      this.log(task, "success", "默认支付方式已核验；正在紧接着提取绑卡后的 Checkout。");
      task.updatedAt = new Date().toISOString();
      await this.persist();

      const checkout = await this.adapters.checkoutLink.execute({
        taskId: task.id,
        proxies,
        proxySessionId: task.context.checkout_flow_session_id,
        accountSession: task.context.accountSession,
        checkoutSeed: task.context.checkout_seed,
        reportProgress: async (message, details = undefined) => {
          task.updatedAt = new Date().toISOString();
          this.log(task, "info", message, details);
          await this.persist();
        }
      });
      if (!checkout || !checkout.checkoutUrl) {
        throw new AppError(
          502,
          "POST_BINDING_CHECKOUT_URL_MISSING",
          "The post-binding protocol did not return a Checkout URL."
        );
      }
      task.context.checkout_link = checkout;
      task.context.checkoutUrl = checkout.checkoutUrl;
      task.state = "CARD_BOUND";
      task.currentStage = "checkout_link";
      this.setStage(task, "checkout_link", "COMPLETED");
      this.log(task, "success", checkoutHasVerifiedZeroAmount(checkout)
        ? "绑卡后的 Checkout 已核验：本次应付为 0。"
        : "Protocol submitted; Checkout 链接已保留，等待零金额订阅准备。", {
        discountPercent: checkout.discountPercent,
        dueTodayMinorUnits: checkout.dueTodayMinorUnits,
        zeroAmountVerified: checkoutHasVerifiedZeroAmount(checkout),
        checkoutCreatedAfterBinding: checkoutCreatedAfterCardBinding(task)
      });
      task.updatedAt = new Date().toISOString();
      await this.persist();
      return this.publicTask(task);
    } catch (error) {
      if (cardVerified) {
        const candidate = task.context && task.context.checkout_link;
        if (candidate && candidate.checkoutUrl) {
          const protocolErrorCode = String(error && error.code || "POST_BINDING_PROTOCOL_FAILED");
          task.context.checkout_link = {
            ...candidate,
            promotionStatus: checkoutHasVerifiedZeroAmount(candidate)
              ? "applied"
              : "protocol_validation_failed",
            protocolValidationStatus: "failed",
            protocolErrorCode
          };
          task.context.checkoutUrl = candidate.checkoutUrl;
          task.state = "CARD_BOUND";
          task.currentStage = "checkout_link";
          this.setStage(task, "card_binding", "COMPLETED");
          this.setStage(task, "checkout_link", "COMPLETED");
          this.setStage(task, "trial_payment", "PENDING");
          this.log(task, "warning", "候选 Checkout 已生成；协议与零金额验证暂未完成，链接保持可复制。", {
            code: protocolErrorCode,
            cardBindingPreserved: true,
            candidateCheckoutPreserved: true,
            zeroAmountVerified: checkoutHasVerifiedZeroAmount(candidate)
          });
          task.updatedAt = new Date().toISOString();
          await this.persist();
          return this.publicTask(task);
        }
        task.state = "EXTRACTION_FAILED";
        task.currentStage = "checkout_link";
        this.setStage(task, "card_binding", "COMPLETED");
        this.setStage(task, "checkout_link", "FAILED");
        this.log(task, "error", sanitizeText(error && error.message, 300), {
          code: error && error.code || "POST_BINDING_CHECKOUT_FAILED",
          cardBindingPreserved: true,
          candidateCheckoutPreserved: false
        });
      } else {
        task.state = "CARD_BINDING_FAILED";
        task.currentStage = "card_binding";
        this.setStage(task, "card_binding", "FAILED");
        this.log(task, "error", sanitizeText(error && error.message, 300), {
          code: error && error.code || "CARD_BINDING_FAILED"
        });
      }
      task.updatedAt = new Date().toISOString();
      await this.persist();
      throw error;
    } finally {
      this.running.delete(id);
    }
  }

  async cancelCardBinding(id, input = {}) {
    const task = this.find(id);
    const result = await this.adapters.cardBinding.cancel({ taskId: task.id, token: input.token });
    if (result.cancelled) {
      const failure = input.failure && typeof input.failure === "object" ? input.failure : null;
      if (failure) {
        task.state = "CARD_BINDING_FAILED";
        task.currentStage = "card_binding";
        this.setStage(task, "card_binding", "FAILED");
        this.log(task, "error", sanitizeText(failure.message, 300), {
          code: sanitizeText(failure.code || "STRIPE_CARD_CONFIRM_FAILED", 80)
        });
      } else if (task.state === "CARD_BINDING_READY") {
        task.state = cardBindingFallbackState(task);
        task.currentStage = task.context && task.context.card_binding ? "checkout_link" : "card_binding";
        this.log(task, "info", "一次性绑卡会话已关闭；请重新点击开始绑卡以创建新会话");
      }
      task.updatedAt = new Date().toISOString();
      await this.persist();
    }
    return result;
  }

  normalizeCardBindingBatchTasks(input = {}, operationLimit = this.operationSnapshot().limit) {
    if (!Array.isArray(input.ids) || !input.ids.length) {
      throw new AppError(400, "CARD_BINDING_BATCH_IDS_REQUIRED", "Select at least one account for concurrent card binding.");
    }
    const ids = [...new Set(input.ids.map((value) => String(value || "").trim()).filter(Boolean))];
    if (ids.length !== input.ids.length) {
      throw new AppError(400, "CARD_BINDING_BATCH_IDS_INVALID", "Concurrent card-binding task ids must be unique and non-empty.");
    }
    if (ids.length > operationLimit) {
      throw new AppError(400, "CARD_BINDING_BATCH_TOO_LARGE", `Concurrent card binding accepts at most ${operationLimit} accounts.`);
    }
    const tasks = ids.map((id) => this.find(id));
    if (this.running.size + tasks.length > operationLimit) {
      throw new AppError(409, "TASK_CONCURRENCY_LIMIT", `The global concurrency limit is ${operationLimit} accounts.`);
    }
    for (const task of tasks) {
      if (this.running.has(task.id)) throw new AppError(409, "TASK_ALREADY_RUNNING", `Task ${task.id} is already running.`);
      if (!CARD_BINDABLE_STATES.has(task.state)) {
        throw new AppError(409, "CARD_BINDING_BATCH_STATE_INVALID", `Task ${task.id} is ${task.state}, which is not ready for card binding.`);
      }
      if (!task.context || !task.context.accountSession) {
        throw new AppError(409, "ACCOUNT_SESSION_REQUIRED", `Task ${task.id} does not have a saved account session.`);
      }
    }
    return tasks;
  }

  async prepareCardBindingBatch(input = {}) {
    const limit = this.operationSnapshot().limit;
    const tasks = this.normalizeCardBindingBatchTasks(input, limit);
    const maxRetries = this.normalizeBatchRetryCount(input);
    let generatedProfiles = 0;
    for (const task of tasks) {
      task.context = task.context || {};
      if (!task.context.card_profile) {
        if (!this.profileAddressGenerator) {
          throw new AppError(503, "PROFILE_ADDRESS_GENERATOR_MISSING", "The profile-address generator is not initialized.");
        }
        task.context.card_profile = this.profileAddressGenerator.generate();
        task.updatedAt = new Date().toISOString();
        this.log(task, "success", "Concurrent card binding generated the required billing name and address.");
        generatedProfiles += 1;
      }
    }
    if (generatedProfiles) await this.persist();

    const attemptsByTask = new Map(tasks.map((task) => [task.id, 0]));
    const preparationByTask = new Map();
    const lastErrorByTask = new Map();
    let pending = [...tasks];
    let retryRounds = 0;
    let retryExecutions = 0;
    while (pending.length) {
      const roundTasks = [...pending];
      const settled = await Promise.allSettled(roundTasks.map(async (task) => {
        attemptsByTask.set(task.id, attemptsByTask.get(task.id) + 1);
        return this.prepareCardBinding(task.id);
      }));
      const retryable = [];
      for (let index = 0; index < settled.length; index += 1) {
        const outcome = settled[index];
        const task = roundTasks[index];
        if (outcome.status === "fulfilled") {
          preparationByTask.set(task.id, Object.freeze({ taskId: task.id, ...outcome.value }));
        } else {
          lastErrorByTask.set(task.id, outcome.reason);
          if (CARD_BINDABLE_STATES.has(task.state)) retryable.push(task);
        }
      }
      if (!retryable.length || retryRounds >= maxRetries) break;
      retryRounds += 1;
      retryExecutions += retryable.length;
      for (const task of retryable) {
        this.log(task, "warning", `Card-binding preparation retry ${retryRounds}/${maxRetries} is scheduled.`, {
          retryRound: retryRounds,
          maxRetries,
          delayMs: this.batchRetryDelayMs
        });
      }
      await this.persist();
      if (this.batchRetryDelayMs) await this.sleep(this.batchRetryDelayMs);
      pending = retryable;
    }
    const preparations = tasks.map((task) => preparationByTask.get(task.id)).filter(Boolean);
    const failures = tasks.filter((task) => !preparationByTask.has(task.id)).map((task) => {
      const error = lastErrorByTask.get(task.id);
      return Object.freeze({
        id: task.id,
        state: task.state,
        error: String(error && error.code || "CARD_BINDING_PREPARE_FAILED"),
        message: sanitizeText(error && error.message, 200)
      });
    });
    await this.persist();
    return Object.freeze({
      stage: "card_binding",
      mode: "parallel_hosted_prepare",
      limit,
      requested: tasks.length,
      generatedProfiles,
      prepared: preparations.length,
      maxRetries,
      retryDelayMs: this.batchRetryDelayMs,
      retryRounds,
      retryExecutions,
      attemptsByTask: tasks.map((task) => ({ id: task.id, attempts: attemptsByTask.get(task.id) || 0 })),
      preparations: Object.freeze(preparations),
      failures: Object.freeze(failures),
      tasks: Object.freeze(tasks.map((task) => this.publicTask(task)))
    });
  }

  async completeCardBindingBatch(input = {}) {
    if (!Array.isArray(input.bindings) || !input.bindings.length) {
      throw new AppError(400, "CARD_BINDING_BATCH_RESULTS_REQUIRED", "Stripe confirmation results are required.");
    }
    const limit = this.operationSnapshot().limit;
    if (input.bindings.length > limit) {
      throw new AppError(400, "CARD_BINDING_BATCH_TOO_LARGE", `Concurrent card binding accepts at most ${limit} accounts.`);
    }
    const maxRetries = this.normalizeBatchRetryCount(input);
    const ids = input.bindings.map((entry) => String(entry && entry.id || "").trim());
    const tasks = this.normalizeCardBindingBatchTasks({ ids }, limit);
    const entries = input.bindings.map((binding, index) => ({ binding, task: tasks[index] }));
    const attemptsByTask = new Map(tasks.map((task) => [task.id, 0]));
    const completedTaskIds = new Set();
    const lastErrorByTask = new Map();
    let pending = [...entries];
    let retryRounds = 0;
    let retryExecutions = 0;
    while (pending.length) {
      const roundEntries = [...pending];
      const settled = await Promise.allSettled(roundEntries.map(async ({ binding, task }) => {
        attemptsByTask.set(task.id, attemptsByTask.get(task.id) + 1);
        return this.completeCardBinding(task.id, {
          token: binding.token,
          setupIntentId: binding.setupIntentId,
          paymentMethodId: binding.paymentMethodId
        });
      }));
      const retryable = [];
      for (let index = 0; index < settled.length; index += 1) {
        const outcome = settled[index];
        const entry = roundEntries[index];
        if (outcome.status === "fulfilled") {
          completedTaskIds.add(entry.task.id);
        } else {
          lastErrorByTask.set(entry.task.id, outcome.reason);
          if (["CARD_BINDING_READY", "CARD_BINDING_BLOCKED", "CARD_BINDING_FAILED"].includes(entry.task.state)) {
            retryable.push(entry);
          }
        }
      }
      if (!retryable.length || retryRounds >= maxRetries) break;
      retryRounds += 1;
      retryExecutions += retryable.length;
      for (const { task } of retryable) {
        this.log(task, "warning", `Card-binding verification retry ${retryRounds}/${maxRetries} is scheduled.`, {
          retryRound: retryRounds,
          maxRetries,
          delayMs: this.batchRetryDelayMs
        });
      }
      await this.persist();
      if (this.batchRetryDelayMs) await this.sleep(this.batchRetryDelayMs);
      pending = retryable;
    }
    const failures = tasks.filter((task) => !completedTaskIds.has(task.id)).map((task) => {
      const error = lastErrorByTask.get(task.id);
      return Object.freeze({
        id: task.id,
        state: task.state,
        error: String(error && error.code || (task.context && task.context.card_binding
          ? "POST_BINDING_CHECKOUT_FAILED"
          : "CARD_BINDING_FAILED")),
        message: sanitizeText(error && error.message, 200)
      });
    });
    const candidateReady = tasks.filter((task) => Boolean(task.context && task.context.checkout_link
      && task.context.checkout_link.checkoutUrl)).length;
    const zeroAmountVerified = tasks.filter((task) => checkoutHasVerifiedZeroAmount(
      task.context && task.context.checkout_link
    )).length;
    await this.persist();
    return Object.freeze({
      stage: "card_binding_checkout_link",
      mode: "browser_instance_barrier_confirm_then_parallel_extract",
      checkoutWorkerMode: "isolated_browser_processes",
      checkoutWorkers: tasks.length,
      limit,
      requested: tasks.length,
      cardBound: tasks.filter((task) => task.context && task.context.card_binding).length,
      checkoutReady: candidateReady,
      candidateReady,
      zeroAmountVerified,
      completed: completedTaskIds.size,
      maxRetries,
      retryDelayMs: this.batchRetryDelayMs,
      retryRounds,
      retryExecutions,
      attemptsByTask: tasks.map((task) => ({ id: task.id, attempts: attemptsByTask.get(task.id) || 0 })),
      failures: Object.freeze(failures),
      tasks: Object.freeze(tasks.map((task) => this.publicTask(task)))
    });
  }

  async create(input = {}) {
    this.proxyPools.requireConfigured(["REGISTRATION"]);
    const registration = this.adapters.registration.prepare(input);
    const task = this.buildTask(registration);
    this.tasks.push(task);
    await this.persist();
    return this.publicTask(task);
  }

  buildTask(registration) {
    const now = new Date().toISOString();
    const task = {
      id: crypto.randomUUID(),
      state: "QUEUED",
      currentStage: "registration",
      createdAt: now,
      updatedAt: now,
      stages: this.pipeline(),
      account: registration.public,
      context: { registration: registration.private },
      logs: []
    };
    this.log(task, "info", "Task created and queued for registration.");
    return task;
  }

  buildImportedTask(resolved) {
    if (!this.sessionDirectory) {
      throw new AppError(503, "ACCOUNT_SESSION_DIRECTORY_MISSING", "The account-session directory is not initialized.");
    }
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const storagePath = path.join(this.sessionDirectory, `${id}.storage.json`);
    const authSessionPath = path.join(this.sessionDirectory, `${id}.auth-session.json`);
    const stages = this.pipeline();
    const registrationStage = stages.find((stage) => stage.key === "registration");
    if (registrationStage) registrationStage.state = "COMPLETED";
    const task = {
      id,
      state: "REGISTERED",
      currentStage: "card_binding",
      createdAt: now,
      updatedAt: now,
      stages,
      account: {
        account: maskImportedAccount(resolved.email, resolved.accountId),
        mailboxHost: "AT import",
        source: "access_token"
      },
      context: {
        registration: {
          importedAccessToken: true,
          email: String(resolved.email || "").trim().toLowerCase()
        },
        registrationResult: {
          mode: "imported_access_token",
          importedAt: now
        },
        accountSession: {
          kind: "playwright_storage_state",
          path: storagePath,
          authSessionPath,
          authSessionCachedAt: now,
          authSessionExpiresAt: resolved.expiresAt || null,
          accessTokenImported: true
        }
      },
      logs: []
    };
    this.log(task, "success", "Access Token validated through the US account context and imported as a registered account.");
    return Object.freeze({ task, storagePath, authSessionPath, authSession: resolved.authSession });
  }

  async writeImportedSession(entry) {
    await fs.mkdir(this.sessionDirectory, { recursive: true });
    try {
      await fs.writeFile(entry.storagePath, JSON.stringify({ cookies: [], origins: [] }), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx"
      });
      await fs.writeFile(entry.authSessionPath, JSON.stringify(entry.authSession), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx"
      });
    } catch (error) {
      await Promise.all([
        fs.unlink(entry.storagePath).catch(() => {}),
        fs.unlink(entry.authSessionPath).catch(() => {})
      ]);
      throw error;
    }
  }

  async importAccessTokenSessions(sessions) {
    if (!Array.isArray(sessions) || !sessions.length) {
      throw new AppError(400, "ACCESS_TOKEN_IMPORT_EMPTY", "Enter at least one Access Token or Session JSON document.");
    }
    if (sessions.length > MAX_IMPORT_ACCOUNTS) {
      throw new AppError(400, "ACCOUNT_IMPORT_TOO_LARGE", `At most ${MAX_IMPORT_ACCOUNTS} accounts can be imported at once.`);
    }
    if (!this.accountSessionImporter || typeof this.accountSessionImporter.resolveImportSession !== "function") {
      throw new AppError(503, "ACCESS_TOKEN_IMPORTER_MISSING", "The Access Token account importer is not initialized.");
    }
    const resolved = await mapWithConcurrency(sessions, MAX_IMPORT_CONCURRENCY, async (session, index) => {
      try {
        return await this.accountSessionImporter.resolveImportSession(session, index);
      } catch (error) {
        throw new AppError(
          Number(error && error.status) || 400,
          error && error.code || "ACCESS_TOKEN_IMPORT_INVALID",
          `Item ${index + 1}: ${error && error.message || "invalid Access Token"}`
        );
      }
    });
    const entries = resolved.map((item) => this.buildImportedTask(item));
    const writeResults = await mapWithConcurrency(entries, MAX_IMPORT_CONCURRENCY, async (entry) => {
      try {
        await this.writeImportedSession(entry);
        return null;
      } catch (error) {
        return error;
      }
    });
    const writeError = writeResults.find(Boolean);
    if (writeError) {
      await Promise.all(entries.flatMap((entry) => [
        fs.unlink(entry.storagePath).catch(() => {}),
        fs.unlink(entry.authSessionPath).catch(() => {})
      ]));
      throw new AppError(500, "ACCESS_TOKEN_IMPORT_SAVE_FAILED", "The imported account session files could not be saved.", writeError);
    }
    const previousTasks = this.tasks;
    this.tasks = [...this.tasks, ...entries.map((entry) => entry.task)];
    try {
      await this.persist();
    } catch (error) {
      this.tasks = previousTasks;
      await Promise.all(entries.flatMap((entry) => [
        fs.unlink(entry.storagePath).catch(() => {}),
        fs.unlink(entry.authSessionPath).catch(() => {})
      ]));
      throw error;
    }
    return Object.freeze({
      format: "access_token",
      count: entries.length,
      readyForCardBinding: entries.length,
      tasks: entries.map((entry) => this.publicTask(entry.task))
    });
  }

  async importAccounts(input = {}) {
    const format = String(input.format || "").trim().toLowerCase();
    if (format === "access_token" || Array.isArray(input.sessions)) {
      this.proxyPools.requireConfigured(["US"]);
      return this.importAccessTokenSessions(input.sessions);
    }
    this.proxyPools.requireConfigured(["REGISTRATION"]);
    const source = Array.isArray(input.accountLines)
      ? input.accountLines.join("\n")
      : String(input.text || input.accountLines || "");
    const lines = source.split(/\r?\n/)
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      .filter((entry) => entry.line);
    if (!lines.length) {
      throw new AppError(400, "ACCOUNT_IMPORT_EMPTY", "Enter at least one account line to import.");
    }
    if (lines.length > MAX_IMPORT_ACCOUNTS) {
      throw new AppError(400, "ACCOUNT_IMPORT_TOO_LARGE", `At most ${MAX_IMPORT_ACCOUNTS} accounts can be imported at once.`);
    }

    const registrations = lines.map((entry) => {
      try {
        return this.adapters.registration.prepare({ accountLine: entry.line });
      } catch (error) {
        throw new AppError(
          Number(error && error.status) || 400,
          error && error.code || "ACCOUNT_IMPORT_LINE_INVALID",
          `Line ${entry.number}: ${error && error.message || "invalid account source"}`
        );
      }
    });
    const tasks = registrations.map((registration) => this.buildTask(registration));
    this.tasks.push(...tasks);
    await this.persist();
    return Object.freeze({
      format: "email_url",
      count: tasks.length,
      tasks: tasks.map((task) => this.publicTask(task))
    });
  }

  normalizeBatchRequest(input = {}) {
    const operation = this.operationSnapshot();
    const stage = String(input.stage || "").trim().toLowerCase();
    if (!Object.hasOwn(BATCH_RUN_STATES, stage)) {
      throw new AppError(400, "TASK_BATCH_STAGE_INVALID", "Batch stage must be registration, checkout_link, or trial_payment.");
    }
    const ids = [...new Set((Array.isArray(input.ids) ? input.ids : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean))];
    if (!ids.length) {
      throw new AppError(400, "TASK_BATCH_SELECTION_REQUIRED", "Select at least one task for the batch.");
    }
    if (ids.length > operation.limit) {
      throw new AppError(400, "TASK_BATCH_TOO_LARGE", `At most ${operation.limit} accounts can run in one operation round.`);
    }
    const tasks = ids.map((id) => this.find(id));
    if (this.running.size + tasks.length > operation.limit) {
      throw new AppError(409, "TASK_CONCURRENCY_LIMIT", `The global concurrency limit is ${operation.limit} accounts.`);
    }
    for (const task of tasks) {
      if (this.running.has(task.id)) {
        throw new AppError(409, "TASK_ALREADY_RUNNING", `Task ${task.id} is already running.`);
      }
      if (!BATCH_RUN_STATES[stage].has(task.state)) {
        throw new AppError(409, "TASK_BATCH_STATE_INVALID", `Task ${task.id} is ${task.state}, which is not ready for ${stage}.`);
      }
    }
    return {
      stage,
      ids,
      tasks,
      limit: operation.limit,
      registrationMode: operation.registrationMode,
      roxyWindowCount: Math.ceil(tasks.length / 2)
    };
  }

  normalizeBatchRetryCount(input = {}) {
    const value = input.maxRetries == null || input.maxRetries === ""
      ? 0
      : Number(input.maxRetries);
    if (!Number.isInteger(value) || value < 0 || value > MAX_BATCH_RETRIES) {
      throw new AppError(
        400,
        "TASK_BATCH_RETRY_COUNT_INVALID",
        `maxRetries must be an integer from 0 through ${MAX_BATCH_RETRIES}.`
      );
    }
    return value;
  }

  async runBatch(input = {}) {
    const batch = this.normalizeBatchRequest(input);
    const maxRetries = this.normalizeBatchRetryCount(input);
    if (batch.stage === "registration"
        && batch.registrationMode === "roxybrowser"
        && this.adapters.registration
        && typeof this.adapters.registration.supportsBatchMode === "function"
        && this.adapters.registration.supportsBatchMode("roxybrowser")) {
      return this.runRoxyRegistrationBatch(batch, maxRetries);
    }
    if (batch.stage === "trial_payment") {
      if (maxRetries > 0) {
        throw new AppError(
          400,
          "TRIAL_BATCH_AUTORETRY_UNSUPPORTED",
          "Automatic retries apply to registration and checkout extraction; synchronized subscription remains a single barrier release."
        );
      }
      if (input.confirmed !== true) {
        throw new AppError(409, "TRIAL_SUBSCRIPTION_CONFIRMATION_REQUIRED", "Confirm the subscription and renewal terms before continuing.");
      }
      return this.runSynchronizedTrialBatch(batch.tasks, batch.limit);
    }
    const attemptsByTask = new Map(batch.tasks.map((task) => [task.id, 0]));
    let pending = [...batch.tasks];
    let retryRounds = 0;
    let retryExecutions = 0;
    while (pending.length) {
      const round = await Promise.allSettled(pending.map(async (task) => {
        attemptsByTask.set(task.id, attemptsByTask.get(task.id) + 1);
        return this.run(task.id, {
          operationLimit: batch.limit,
          registrationMode: batch.registrationMode
        });
      }));
      for (let index = 0; index < round.length; index += 1) {
        const outcome = round[index];
        if (outcome.status === "rejected") {
          const task = pending[index];
          task.updatedAt = new Date().toISOString();
          this.log(task, "error", sanitizeText(outcome.reason && outcome.reason.message, 300), {
            code: outcome.reason && outcome.reason.code || "TASK_BATCH_EXECUTION_FAILED"
          });
        }
      }
      if (round.some((outcome) => outcome.status === "rejected")) await this.persist();
      const retryable = pending.filter((task) => BATCH_RUN_STATES[batch.stage].has(task.state));
      if (!retryable.length || retryRounds >= maxRetries) break;
      retryRounds += 1;
      retryExecutions += retryable.length;
      for (const task of retryable) {
        task.updatedAt = new Date().toISOString();
        this.log(task, "warning", `Automatic retry ${retryRounds}/${maxRetries} is scheduled after the transient-node delay.`, {
          retryRound: retryRounds,
          maxRetries,
          delayMs: this.batchRetryDelayMs,
          priorState: task.state
        });
      }
      await this.persist();
      if (this.batchRetryDelayMs) await this.sleep(this.batchRetryDelayMs);
      pending = retryable;
    }
    const results = batch.tasks.map((task) => this.publicTask(task));
    const failures = results
      .filter((task) => BATCH_RUN_STATES[batch.stage].has(task.state))
      .map((task) => ({ id: task.id, state: task.state }));
    return Object.freeze({
      stage: batch.stage,
      mode: "parallel",
      limit: batch.limit,
      registrationMode: batch.stage === "registration" ? batch.registrationMode : undefined,
      requested: results.length,
      completed: results.filter((task) => task.state === BATCH_SUCCESS_STATES[batch.stage]).length,
      maxRetries,
      retryDelayMs: this.batchRetryDelayMs,
      retryRounds,
      retryExecutions,
      attemptsByTask: results.map((task) => ({
        id: task.id,
        attempts: attemptsByTask.get(task.id) || 0
      })),
      failures,
      tasks: results
    });
  }

  async runRoxyRegistrationBatch(batch, maxRetries) {
    const attemptsByTask = new Map(batch.tasks.map((task) => [task.id, 0]));
    let pending = [...batch.tasks];
    let retryRounds = 0;
    let retryExecutions = 0;
    let windowCountPeak = 0;
    const batchWindowCount = Math.ceil(batch.tasks.length / 2);
    while (pending.length) {
      const roundTasks = [...pending];
      const items = roundTasks.map((task, index) => {
        const profileWindowIndex = Math.floor(index / 2);
        attemptsByTask.set(task.id, attemptsByTask.get(task.id) + 1);
        const controller = new AbortController();
        this.abortControllers.set(task.id, controller);
        this.running.add(task.id);
        task.state = "REGISTERING";
        task.currentStage = "registration";
        task.updatedAt = new Date().toISOString();
        this.setStage(task, "registration", "RUNNING");
        this.log(task, "info", "RoxyBrowser WebUI registration started.", {
          registrationMode: "roxybrowser",
          batchSize: roundTasks.length,
          windowCount: Math.ceil(roundTasks.length / 2),
          accountSlot: (index % 2) + 1,
          retryRound: retryRounds,
          profileWindowIndex
        });
        return {
          taskId: task.id,
          proxy: null,
          signal: controller.signal,
          registration: task.context.registration,
          reportProgress: async (message, details = undefined) => {
            task.updatedAt = new Date().toISOString();
            this.log(task, "info", message, details);
            await this.persist();
          }
        };
      });
      await this.persist();

      let execution;
      try {
        execution = await this.adapters.registration.executeBatch({
          items,
          registrationMode: "roxybrowser"
        });
        windowCountPeak = Math.max(windowCountPeak, Number(execution.windowCount) || 0);
      } catch (error) {
        execution = {
          windowCount: Math.ceil(roundTasks.length / 2),
          outcomes: roundTasks.map(() => ({ status: "rejected", reason: error }))
        };
        windowCountPeak = Math.max(windowCountPeak, execution.windowCount);
      }

      for (let index = 0; index < roundTasks.length; index += 1) {
        const task = roundTasks[index];
        const outcome = execution.outcomes && execution.outcomes[index];
        const validationProxyIndex = (retryRounds * batchWindowCount) + Math.floor(index / 2);
        try {
          if (!outcome || outcome.status !== "fulfilled") {
            const error = outcome && outcome.reason || new AppError(
              502,
              "ROXY_REGISTRATION_OUTCOME_MISSING",
              "RoxyBrowser registration ended without an account outcome."
            );
            const blocked = Number(error && error.status) === 501;
            task.state = blocked ? "REGISTRATION_BLOCKED" : "REGISTRATION_FAILED";
            this.setStage(task, "registration", blocked ? "BLOCKED" : "FAILED");
            this.log(task, blocked ? "warning" : "error", sanitizeText(error && error.message, 300), {
              code: error && error.code || "ROXY_REGISTRATION_FAILED"
            });
            continue;
          }
          const result = outcome.value;
          if (!result || !result.session || !result.session.path || !result.session.authSessionPath) {
            throw new AppError(502, "ROXY_SESSION_RESULT_INVALID", "RoxyBrowser registration did not return both verified session artifacts.");
          }
          if (!this.accountSessionImporter || typeof this.accountSessionImporter.resolveImportSession !== "function") {
            throw new AppError(503, "ROXY_AUTH_CACHE_VALIDATOR_MISSING", "RoxyBrowser post-cleanup AT validation is not initialized.");
          }
          try {
            const privateAuthSession = await fs.readFile(result.session.authSessionPath, "utf8");
            await this.accountSessionImporter.resolveImportSession(privateAuthSession, validationProxyIndex);
          } catch (error) {
            throw new AppError(
              Number(error && error.status) || 401,
              "ROXY_AUTH_CACHE_LIVE_VALIDATION_FAILED",
              "RoxyBrowser completed registration, but its saved AT did not pass live account validation after profile cleanup.",
              Object.freeze({ upstreamCode: String(error && error.code || "AUTH_CACHE_REJECTED").slice(0, 120) })
            );
          }
          task.context.registrationResult = result;
          task.context.accountSession = result.session;
          task.context.plus_trial_eligibility = normalizePlusTrialEligibility(result.plusEligibility);
          task.state = "REGISTERED";
          task.currentStage = "registration";
          this.setStage(task, "registration", "COMPLETED");
          this.log(task, "success", "RoxyBrowser registration completed; storage and AT cache are committed.", {
            registrationMode: "roxybrowser",
            liveAuthCacheVerified: true
          });
        } catch (error) {
          task.state = "REGISTRATION_FAILED";
          this.setStage(task, "registration", "FAILED");
          this.log(task, "error", sanitizeText(error && error.message, 300), {
            code: error && error.code || "ROXY_REGISTRATION_FAILED"
          });
        } finally {
          task.updatedAt = new Date().toISOString();
          this.running.delete(task.id);
          this.abortControllers.delete(task.id);
        }
      }
      await this.persist();

      const retryable = roundTasks.filter((task) => (
        !this.terminationRequests.has(task.id) && BATCH_RUN_STATES.registration.has(task.state)
      ));
      for (const task of roundTasks) this.terminationRequests.delete(task.id);
      if (!retryable.length || retryRounds >= maxRetries) break;
      retryRounds += 1;
      retryExecutions += retryable.length;
      for (const task of retryable) {
        this.log(task, "warning", `RoxyBrowser automatic retry ${retryRounds}/${maxRetries} is scheduled.`, {
          retryRound: retryRounds,
          maxRetries,
          delayMs: this.batchRetryDelayMs
        });
      }
      await this.persist();
      if (this.batchRetryDelayMs) await this.sleep(this.batchRetryDelayMs);
      pending = retryable;
    }

    const results = batch.tasks.map((task) => this.publicTask(task));
    const failures = results
      .filter((task) => BATCH_RUN_STATES.registration.has(task.state))
      .map((task) => ({ id: task.id, state: task.state }));
    return Object.freeze({
      stage: "registration",
      mode: "roxy_windows_two_slots",
      registrationMode: "roxybrowser",
      limit: batch.limit,
      requested: results.length,
      windowCount: windowCountPeak || Math.ceil(results.length / 2),
      accountsPerWindow: 2,
      completed: results.filter((task) => task.state === "REGISTERED").length,
      maxRetries,
      retryDelayMs: this.batchRetryDelayMs,
      retryRounds,
      retryExecutions,
      attemptsByTask: results.map((task) => ({
        id: task.id,
        attempts: attemptsByTask.get(task.id) || 0
      })),
      failures,
      tasks: results
    });
  }

  applyTrialFailure(task, error) {
    const blocked = Number(error && error.status) === 501
      || BLOCKED_STAGE_CODES.has(String(error && error.code || ""));
    task.state = blocked ? "TRIAL_PAYMENT_BLOCKED" : "TRIAL_PAYMENT_FAILED";
    task.currentStage = "trial_payment";
    this.setStage(task, "trial_payment", blocked ? "BLOCKED" : "FAILED");
    task.updatedAt = new Date().toISOString();
    this.log(task, blocked ? "warning" : "error", sanitizeText(error && error.message, 300), {
      code: error && error.code || "TRIAL_PAYMENT_FAILED"
    });
  }

  async runSynchronizedTrialBatch(tasks, operationLimit = this.operationSnapshot().limit) {
    const adapter = this.adapters.trialPayment;
    if (!adapter || typeof adapter.supportsSynchronizedBatch !== "function" || !adapter.supportsSynchronizedBatch()) {
      throw new AppError(503, "TRIAL_SYNCHRONIZED_BATCH_UNAVAILABLE", "The synchronized subscription client is not initialized.");
    }

    const entries = tasks.map((task, batchIndex) => {
      const regions = ["US", "TR"];
      const proxies = Object.fromEntries(regions.map((region, offset) => [
        region,
        this.proxyPools.select(region, task.logs.length + (batchIndex * regions.length) + offset)
      ]));
      const trialStage = task.stages.find((stage) => stage.key === "trial_payment");
      return {
        task,
        proxies,
        proxy: proxies.US,
        previousState: task.state,
        previousStageState: trialStage && trialStage.state || "PENDING",
        prepared: null,
        reportProgress: async (message, details = undefined) => {
          task.updatedAt = new Date().toISOString();
          this.log(task, "info", message, details);
          await this.persist();
        }
      };
    });

    for (const entry of entries) {
      this.running.add(entry.task.id);
      entry.task.state = "REQUESTING_TRIAL";
      entry.task.currentStage = "trial_payment";
      entry.task.updatedAt = new Date().toISOString();
      this.setStage(entry.task, "trial_payment", "RUNNING");
      this.log(entry.task, "info", "Synchronized subscription preparation started: Checkout, billing, Payment Element, and confirmation token.", {
        batchSize: entries.length,
        proxies: Object.fromEntries(Object.entries(entry.proxies).map(([region, selected]) => [
          region,
          summarizeProxy(selected, 0).endpoint
        ]))
      });
    }
    await this.persist();

    const abortBeforeConfirm = async (settled, phase) => {
      const failures = [];
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        const outcome = settled[index];
        if (outcome.status === "rejected") {
          const error = outcome.reason;
          this.applyTrialFailure(entry.task, error);
          failures.push({
            id: entry.task.id,
            error: String(error && error.code || "TRIAL_BATCH_PREPARE_FAILED"),
            message: sanitizeText(error && error.message, 200)
          });
        } else {
          entry.task.state = entry.previousState;
          this.setStage(entry.task, "trial_payment", entry.previousStageState);
          entry.task.updatedAt = new Date().toISOString();
          this.log(entry.task, "warning", "The synchronized batch stopped before release; no confirm request was sent.", {
            phase,
            confirmationsDispatched: 0
          });
        }
      }
      await this.persist();
      return Object.freeze({
        stage: "trial_payment",
        mode: "synchronized_browser_process_barrier",
        confirmationWorkerMode: "isolated_browser_processes",
        status: `${phase}_failed`,
        limit: operationLimit,
        requested: entries.length,
        prepared: entries.filter((entry) => entry.prepared).length,
        confirmationsDispatched: 0,
        confirmationDispatchedAt: null,
        dispatchSkewMs: null,
        failures,
        tasks: entries.map((entry) => this.publicTask(entry.task))
      });
    };

    try {
      const prepared = await Promise.allSettled(entries.map(async (entry) => {
        const task = entry.task;
        if (checkoutRequiresSubscriptionRefresh(task)) {
          await entry.reportProgress("Refreshing the active Checkout concurrently so its live Stripe amount is verified before subscription.");
          const refreshed = await this.adapters.checkoutLink.execute({
            taskId: task.id,
            proxies: entry.proxies,
            accountSession: task.context.accountSession,
            proxySessionId: task.context.checkout_flow_session_id || "",
            checkoutSeed: task.context.checkout_seed,
            reportProgress: entry.reportProgress
          });
          if (!refreshed || !refreshed.checkoutUrl) {
            throw new AppError(502, "TRIAL_CHECKOUT_REFRESH_FAILED", "The refreshed checkout did not include a URL.");
          }
          task.context.checkout_link = refreshed;
          task.context.checkoutUrl = refreshed.checkoutUrl;
          task.updatedAt = new Date().toISOString();
          this.log(task, "success", "The post-binding Checkout was refreshed.");
          await this.persist();
        }
        if (!checkoutUsesBangKaProtocol(task.context.checkout_link)
            && !checkoutHasVerifiedZeroAmount(task.context.checkout_link)) {
          throw new AppError(
            409,
            "TRIAL_PROMOTION_NOT_APPLIED",
            "绑卡后的 Checkout 尚未应用免费优惠；本次未发送订阅确认请求。"
          );
        }
        entry.prepared = await adapter.prepare({
          taskId: task.id,
          proxy: entry.proxy,
          proxies: entry.proxies,
          registration: task.context.registration,
          accountSession: task.context.accountSession,
          checkoutUrl: task.context.checkoutUrl,
          checkoutEvidence: task.context.checkout_link,
          cardProfile: task.context.card_profile,
          cardBinding: task.context.card_binding,
          confirmed: true,
          reportProgress: entry.reportProgress
        });
        return entry.prepared;
      }));
      if (prepared.some((outcome) => outcome.status === "rejected")) {
        return await abortBeforeConfirm(prepared, "prepare");
      }

      for (const entry of entries) {
        this.log(entry.task, "info", `All ${entries.length}/${entries.length} Checkout pages are fully loaded; arming synchronized approval headers.`);
      }
      await this.persist();
      const armed = await Promise.allSettled(entries.map((entry) => adapter.arm(entry.prepared)));
      if (armed.some((outcome) => outcome.status === "rejected")) {
        return await abortBeforeConfirm(armed, "arm");
      }

      const confirmationDispatchedAt = new Date().toISOString();
      const dispatchMarks = [];
      for (const entry of entries) {
        this.log(entry.task, "info", "All isolated Checkout browser processes are ready; confirm requests are released through one synchronized barrier.", {
          confirmationDispatchedAt,
          batchSize: entries.length
        });
      }
      await this.persist();

      const confirmationPromises = entries.map((entry) => {
        if (entry.prepared && entry.prepared.requiresConfirmation !== false) {
          dispatchMarks.push(process.hrtime.bigint());
        }
        return adapter.confirm(entry.prepared);
      });
      const dispatchSkewMs = dispatchMarks.length > 1
        ? Number(dispatchMarks.at(-1) - dispatchMarks[0]) / 1_000_000
        : 0;

      const verified = await Promise.allSettled(entries.map(async (entry, index) => {
        const confirmation = await confirmationPromises[index];
        return adapter.verify(entry.prepared, confirmation);
      }));
      const failures = [];
      let completed = 0;
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        const outcome = verified[index];
        if (outcome.status === "rejected") {
          this.applyTrialFailure(entry.task, outcome.reason);
          failures.push({
            id: entry.task.id,
            error: String(outcome.reason && outcome.reason.code || "TRIAL_PAYMENT_FAILED"),
            message: sanitizeText(outcome.reason && outcome.reason.message, 200)
          });
          continue;
        }
        try {
          entry.task.context.trial_payment = normalizeTrialSubscriptionResult(outcome.value);
          entry.task.state = "TRIAL_ACTIVE";
          entry.task.currentStage = "trial_payment";
          this.setStage(entry.task, "trial_payment", "COMPLETED");
          entry.task.updatedAt = new Date().toISOString();
          this.log(entry.task, "success", "Synchronized subscription completed and Plus entitlement is active.", {
            confirmationDispatchedAt,
            dispatchSkewMs
          });
          completed += 1;
        } catch (error) {
          this.applyTrialFailure(entry.task, error);
          failures.push({
            id: entry.task.id,
            error: String(error && error.code || "TRIAL_PAYMENT_FAILED"),
            message: sanitizeText(error && error.message, 200)
          });
        }
      }
      await this.persist();
      return Object.freeze({
        stage: "trial_payment",
        mode: "synchronized_browser_process_barrier",
        confirmationWorkerMode: "isolated_browser_processes",
        confirmationWorkers: entries.length,
        status: failures.length ? "completed_with_failures" : "completed",
        limit: operationLimit,
        requested: entries.length,
        prepared: entries.length,
        confirmationsDispatched: entries.filter((entry) => entry.prepared && entry.prepared.requiresConfirmation !== false).length,
        completed,
        confirmationDispatchedAt,
        dispatchSkewMs,
        failures,
        tasks: entries.map((entry) => this.publicTask(entry.task))
      });
    } finally {
      await Promise.allSettled(entries
        .filter((entry) => entry.prepared)
        .map((entry) => adapter.close(entry.prepared)));
      for (const entry of entries) this.running.delete(entry.task.id);
    }
  }

  async run(id, input = {}) {
    const task = this.find(id);
    const configuredLimit = this.operationSnapshot().limit;
    const requestedLimit = Number(input.operationLimit);
    const operationLimit = Number.isInteger(requestedLimit) && requestedLimit >= 1 && requestedLimit <= 30
      ? requestedLimit
      : configuredLimit;
    if (this.running.has(id)) throw new AppError(409, "TASK_ALREADY_RUNNING", "任务正在执行。");
    if (this.running.size >= operationLimit) {
      throw new AppError(409, "TASK_CONCURRENCY_LIMIT", `The global concurrency limit is ${operationLimit} accounts.`);
    }
    if (task.state === "TRIAL_ACTIVE") return this.publicTask(task);
    const trialRunnable = ["CARD_BOUND", "TRIAL_PAYMENT_BLOCKED", "TRIAL_PAYMENT_FAILED"].includes(task.state);
    if (trialRunnable && input.confirmed !== true) {
      throw new AppError(
        409,
        "TRIAL_SUBSCRIPTION_CONFIRMATION_REQUIRED",
        "请确认首月优惠与后续自动续费条款后再执行一键订阅。"
      );
    }
    const controller = new AbortController();
    this.abortControllers.set(id, controller);
    this.running.add(id);
    try {
      if (["QUEUED", "REGISTERING_BLOCKED", "REGISTRATION_BLOCKED", "REGISTRATION_FAILED"].includes(task.state)) {
        const registrationMode = input.registrationMode === "roxybrowser"
          ? "roxybrowser"
          : this.operationSnapshot().registrationMode;
        return await this.runStage(task, {
          key: "registration",
          running: "REGISTERING",
          success: "REGISTERED",
          failed: "REGISTRATION_FAILED",
          adapter: this.adapters.registration,
          proxyRegion: registrationMode === "roxybrowser" ? null : "REGISTRATION",
          registrationMode,
          signal: controller.signal
        });
      }
      if (["CHECKOUT_LINK_BLOCKED", "EXTRACTION_FAILED"].includes(task.state)) {
        if (!task.context || !task.context.card_binding) {
          throw new AppError(409, "CARD_BINDING_HOSTED_INPUT_REQUIRED", "Bind and verify a default card before extracting Checkout.");
        }
        return await this.runStage(task, {
          key: "checkout_link",
          running: "EXTRACTING_CHECKOUT_LINK",
          success: "CARD_BOUND",
          failed: "EXTRACTION_FAILED",
          adapter: this.adapters.checkoutLink,
          proxyRegions: ["US", "TR"],
          signal: controller.signal
        });
      }
      if (["REGISTERED", "CARD_BINDING_READY", "CHECKOUT_LINK_READY", "CARD_BINDING_BLOCKED", "CARD_BINDING_FAILED"].includes(task.state)) {
        throw new AppError(
          409,
          "CARD_BINDING_HOSTED_INPUT_REQUIRED",
          "请在任务详情中生成资料，然后点击“开始绑卡”。"
        );
      }
      if (["CARD_BOUND", "TRIAL_PAYMENT_BLOCKED", "TRIAL_PAYMENT_FAILED"].includes(task.state)) {
        return await this.runStage(task, {
          key: "trial_payment",
          running: "REQUESTING_TRIAL",
          success: "TRIAL_ACTIVE",
          failed: "TRIAL_PAYMENT_FAILED",
          adapter: this.adapters.trialPayment,
          proxyRegion: "US",
          proxyRegions: ["US", "TR"],
          refreshCheckoutAfterCardBinding: true,
          confirmed: true,
          signal: controller.signal
        });
      }
      throw new AppError(409, "TASK_STATE_NOT_RUNNABLE", `当前状态不可执行：${task.state}`);
    } finally {
      this.running.delete(id);
      this.abortControllers.delete(id);
      this.terminationRequests.delete(id);
    }
  }

  async runStage(task, definition) {
    const regions = Array.isArray(definition.proxyRegions) && definition.proxyRegions.length
      ? definition.proxyRegions
      : definition.proxyRegion ? [definition.proxyRegion] : [];
    const proxies = Object.fromEntries(regions.map((region, offset) => [
      region,
      this.proxyPools.select(region, task.logs.length + offset)
    ]));
    const proxy = definition.proxyRegion
      ? proxies[definition.proxyRegion] || proxies[regions[0]]
      : null;
    task.state = definition.running;
    task.currentStage = definition.key;
    task.updatedAt = new Date().toISOString();
    this.setStage(task, definition.key, "RUNNING");
    this.log(task, "info", `${definition.adapter.describe().label} 开始`, {
      proxies: Object.fromEntries(Object.entries(proxies).map(([region, selected]) => [
        region,
        summarizeProxy(selected, 0).endpoint
      ]))
    });
    await this.persist();

    try {
      if (definition.signal && definition.signal.aborted) throw definition.signal.reason;
      const reportProgress = async (message, details = undefined) => {
        task.updatedAt = new Date().toISOString();
        this.log(task, "info", message, details);
        await this.persist();
      };
      if (definition.refreshCheckoutAfterCardBinding && checkoutRequiresSubscriptionRefresh(task)) {
        await reportProgress("已绑定默认卡，正在刷新活动 Checkout 以挂载最新 Customer 支付方式");
        const refreshed = await this.adapters.checkoutLink.execute({
          taskId: task.id,
          proxies,
          accountSession: task.context.accountSession,
          proxySessionId: task.context.checkout_flow_session_id || "",
          checkoutSeed: task.context.checkout_seed,
          reportProgress,
          signal: definition.signal
        });
        if (!refreshed || !refreshed.checkoutUrl) {
          throw new AppError(502, "TRIAL_CHECKOUT_REFRESH_FAILED", "The refreshed checkout did not include a URL.");
        }
        task.context.checkout_link = refreshed;
        task.context.checkoutUrl = refreshed.checkoutUrl;
        task.updatedAt = new Date().toISOString();
        this.log(task, "success", "绑卡后的活动 Checkout 已刷新");
        await this.persist();
      }
      if (definition.key === "trial_payment"
          && !checkoutUsesBangKaProtocol(task.context.checkout_link)
          && !checkoutHasVerifiedZeroAmount(task.context.checkout_link)) {
        throw new AppError(
          409,
          "TRIAL_PROMOTION_NOT_APPLIED",
          "绑卡后的 Checkout 尚未应用免费优惠；本次未发送订阅确认请求。"
        );
      }
      const result = await definition.adapter.execute({
        taskId: task.id,
        proxy,
        proxies,
        proxySessionId: task.context.checkout_flow_session_id || "",
        registration: task.context.registration,
        registrationMode: definition.registrationMode || "protocol",
        accountSession: task.context.accountSession,
        checkoutSeed: task.context.checkout_seed,
        checkoutUrl: task.context.checkoutUrl,
        checkoutEvidence: task.context.checkout_link,
        cardProfile: task.context.card_profile,
        cardBinding: task.context.card_binding,
        confirmed: definition.confirmed === true,
        reportProgress,
        signal: definition.signal
      });
      if (definition.signal && definition.signal.aborted) throw definition.signal.reason;
      if (definition.key === "checkout_link" && (!result || !result.checkoutUrl)) {
        throw new AppError(
          502,
          "CHECKOUT_URL_MISSING",
          "Checkout extraction did not return a candidate URL."
        );
      }
      if (definition.key === "registration") {
        task.context.registrationResult = result || {};
        task.context.accountSession = result && result.session ? result.session : null;
        task.context.plus_trial_eligibility = normalizePlusTrialEligibility(result && result.plusEligibility);
      } else {
        task.context[definition.key] = definition.key === "trial_payment"
          ? normalizeTrialSubscriptionResult(result)
          : result || {};
        if (definition.key === "checkout_link") {
          task.context.checkoutUrl = result && result.checkoutUrl || null;
          delete task.context.checkout_flow_session_id;
        }
      }
      task.state = definition.success;
      this.setStage(task, definition.key, "COMPLETED");
      this.log(task, "success", `${definition.adapter.describe().label} 完成`);
    } catch (error) {
      const blocked = Number(error && error.status) === 501 || BLOCKED_STAGE_CODES.has(String(error && error.code || ""));
      task.state = blocked ? `${definition.key.toUpperCase()}_BLOCKED` : definition.failed;
      this.setStage(task, definition.key, blocked ? "BLOCKED" : "FAILED");
      this.log(task, blocked ? "warning" : "error", sanitizeText(error.message, 300), {
        code: error.code || "STAGE_FAILED"
      });
    }
    task.updatedAt = new Date().toISOString();
    await this.persist();
    return this.publicTask(task);
  }

  setStage(task, key, state) {
    const stage = task.stages.find((candidate) => candidate.key === key);
    if (stage) stage.state = state;
  }

  log(task, level, message, details = undefined) {
    task.logs.push({
      at: new Date().toISOString(),
      level,
      message: sanitizeText(message, 500),
      ...(details ? { details } : {})
    });
    if (task.logs.length > 200) task.logs.splice(0, task.logs.length - 200);
  }

  async persist() {
    await this.store.write(structuredClone({ tasks: this.tasks }));
  }

  publicTask(task) {
    const checkout = task.context && task.context.checkout_link;
    const cardProfile = task.context && task.context.card_profile;
    const cardBinding = task.context && task.context.card_binding;
    const trialPayment = task.context && task.context.trial_payment;
    const plusEligibility = normalizePlusTrialEligibility(task.context && (
      task.context.plus_trial_eligibility
      || task.context.registrationResult && task.context.registrationResult.plusEligibility
    ));
    return structuredClone({
      id: task.id,
      state: task.state,
      currentStage: task.currentStage,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      abandonedAt: task.abandonedAt || null,
      account: task.account || null,
      plusEligibility,
      checkoutLink: checkout ? {
        url: checkout.checkoutUrl || "",
        campaignId: checkout.campaignId || "",
        promotionApplied: checkoutHasVerifiedZeroAmount(checkout),
        fullDiscountVerified: checkoutHasVerifiedZeroAmount(checkout),
        zeroAmountVerified: checkoutHasVerifiedZeroAmount(checkout),
        discountPercent: Number.isFinite(checkout.discountPercent) ? checkout.discountPercent : null,
        subtotalMinorUnits: Number.isFinite(checkout.subtotalMinorUnits) ? checkout.subtotalMinorUnits : null,
        discountMinorUnits: Number.isFinite(checkout.discountMinorUnits) ? checkout.discountMinorUnits : null,
        dueTodayMinorUnits: Number.isFinite(checkout.dueTodayMinorUnits) ? checkout.dueTodayMinorUnits : null,
        promotionStatus: checkout.promotionStatus || (checkoutHasVerifiedZeroAmount(checkout)
          ? "applied"
          : "pending_zero_amount_verification"),
        promotionVerification: checkout.promotionVerification || "",
        sessionKind: checkout.sessionKind || "",
        route: checkout.route || "",
        checkoutCountry: checkout.checkoutCountry || "",
        proxyFlow: checkout.proxyFlow || [],
        extractedAt: checkout.extractedAt || null
      } : null,
      cardProfile: cardProfile ? {
        lastName: cardProfile.lastName,
        firstName: cardProfile.firstName,
        postalCode: cardProfile.postalCode,
        fullAddress: cardProfile.fullAddress
      } : null,
      cardBinding: cardBinding ? {
        status: cardBinding.status,
        brand: cardBinding.brand,
        last4: cardBinding.last4,
        expMonth: cardBinding.expMonth,
        expYear: cardBinding.expYear,
        default: cardBinding.default === true,
        proxyRegion: cardBinding.proxyRegion,
        boundAt: cardBinding.boundAt
      } : null,
      trialSubscription: trialPayment ? {
        status: trialPayment.status || "",
        plan: trialPayment.plan || "",
        promotionId: trialPayment.promotionId || "",
        billingCountry: trialPayment.billingCountry || "",
        taxRatePercent: Number.isFinite(trialPayment.taxRatePercent) ? trialPayment.taxRatePercent : null,
        taxMinorUnits: Number.isFinite(trialPayment.taxMinorUnits) ? trialPayment.taxMinorUnits : null,
        dueTodayMinorUnits: Number.isFinite(trialPayment.dueTodayMinorUnits) ? trialPayment.dueTodayMinorUnits : null,
        trial: trialPayment.trial === true,
        expiresAt: trialPayment.expiresAt || null,
        renewsAt: trialPayment.renewsAt || null,
        cancelsAt: trialPayment.cancelsAt || null,
        proxyRegion: trialPayment.proxyRegion || "",
        recovered: trialPayment.recovered === true,
        subscribedAt: trialPayment.subscribedAt || null
      } : null,
      stages: task.stages,
      logs: task.logs
    });
  }
}

function normalizeCardBindingResult(input) {
  const status = String(input && input.status || "");
  const brand = String(input && input.brand || "").trim().toLowerCase();
  const last4 = String(input && input.last4 || "").trim();
  const expMonth = Number(input && input.expMonth);
  const expYear = Number(input && input.expYear);
  const proxyRegion = String(input && input.proxyRegion || "").toUpperCase();
  const boundAt = String(input && input.boundAt || "");
  if (status !== "succeeded" || !/^[a-z0-9 _-]{2,30}$/.test(brand) || !/^\d{4}$/.test(last4)
      || !Number.isInteger(expMonth) || expMonth < 1 || expMonth > 12
      || !Number.isInteger(expYear) || expYear < 2000 || expYear > 9999
      || proxyRegion !== "US" || !Number.isFinite(Date.parse(boundAt))) {
    throw new AppError(502, "CARD_BINDING_RESULT_INVALID", "Card-binding verification returned an invalid redacted result.");
  }
  return Object.freeze({
    status,
    brand,
    last4,
    expMonth,
    expYear,
    default: input.default === true,
    proxyRegion,
    boundAt: new Date(boundAt).toISOString()
  });
}

function normalizeTrialSubscriptionResult(input) {
  const status = String(input && input.status || "").toLowerCase();
  const plan = String(input && input.plan || "").trim().toLowerCase();
  const promotionId = String(input && input.promotionId || "").trim();
  const billingCountry = String(input && input.billingCountry || "").trim().toUpperCase();
  const proxyRegion = String(input && input.proxyRegion || "").trim().toUpperCase();
  const recovered = input && input.recovered === true;
  const subscribedAt = String(input && input.subscribedAt || "");
  const taxRatePercent = input && input.taxRatePercent == null ? null : Number(input.taxRatePercent);
  const taxMinorUnits = input && input.taxMinorUnits == null ? null : Number(input.taxMinorUnits);
  const dueTodayMinorUnits = input && input.dueTodayMinorUnits == null ? null : Number(input.dueTodayMinorUnits);
  if (status !== "active" || !/^[a-z0-9_-]{2,80}$/.test(plan) || !plan.includes("plus")
      || proxyRegion !== "US" || !Number.isFinite(Date.parse(subscribedAt))
      || (promotionId && !/^[A-Za-z0-9_.-]{2,120}$/.test(promotionId))) {
    throw new AppError(502, "TRIAL_SUBSCRIPTION_RESULT_INVALID", "Subscription verification returned an invalid redacted result.");
  }
  if (!recovered && (billingCountry !== "US" || !promotionId || taxRatePercent !== 0
      || taxMinorUnits !== 0 || dueTodayMinorUnits !== 0)) {
    throw new AppError(502, "TRIAL_SUBSCRIPTION_RESULT_INVALID", "Subscription result did not retain the verified US zero-tax trial state.");
  }
  const optionalDate = (value) => {
    if (value == null || value === "") return null;
    if (!Number.isFinite(Date.parse(value))) {
      throw new AppError(502, "TRIAL_SUBSCRIPTION_RESULT_INVALID", "Subscription result contained an invalid date.");
    }
    return new Date(value).toISOString();
  };
  return Object.freeze({
    status,
    plan,
    promotionId,
    billingCountry,
    taxRatePercent,
    taxMinorUnits,
    dueTodayMinorUnits,
    trial: input && input.trial === true,
    expiresAt: optionalDate(input && input.expiresAt),
    renewsAt: optionalDate(input && input.renewsAt),
    cancelsAt: optionalDate(input && input.cancelsAt),
    proxyRegion,
    recovered,
    subscribedAt: new Date(subscribedAt).toISOString()
  });
}

module.exports = {
  ACCOUNT_EXPORT_FORMATS,
  PIPELINE,
  TaskOrchestrator,
  normalizeCardBindingResult,
  normalizePlusTrialEligibility,
  normalizeTrialSubscriptionResult
};
