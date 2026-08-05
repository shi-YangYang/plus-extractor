"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { AppError } = require("../lib/errors");
const { sanitizeText } = require("../lib/sanitize");
const { summarizeProxy } = require("../lib/proxy");

const PIPELINE = Object.freeze([
  { key: "registration", label: "iCloud 注册 ChatGPT", proxy: "US", state: "PENDING" },
  { key: "checkout_link", label: "自动提取结账链接", proxy: "US → TR", state: "READY" },
  { key: "card_binding", label: "自动绑卡", proxy: "US", state: "PENDING" },
  { key: "trial_payment", label: "US 账单与一键订阅", proxy: "US", state: "PENDING" }
]);
const CARD_BINDABLE_STATES = new Set([
  "CHECKOUT_LINK_READY",
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
const MAX_IMPORT_ACCOUNTS = 500;
const MAX_BATCH_TASKS = 10;
const MAX_BATCH_RETRIES = 10;
const DEFAULT_BATCH_RETRY_DELAY_MS = 5_000;
const BATCH_RUN_STATES = Object.freeze({
  registration: new Set(["QUEUED", "REGISTERING_BLOCKED", "REGISTRATION_BLOCKED", "REGISTRATION_FAILED"]),
  checkout_link: new Set(["REGISTERED", "CHECKOUT_LINK_BLOCKED", "EXTRACTION_FAILED"]),
  trial_payment: new Set(["CARD_BOUND", "TRIAL_PAYMENT_BLOCKED", "TRIAL_PAYMENT_FAILED"])
});
const BATCH_SUCCESS_STATES = Object.freeze({
  registration: "REGISTERED",
  checkout_link: "CHECKOUT_LINK_READY",
  trial_payment: "TRIAL_ACTIVE"
});

function checkoutCreatedAfterCardBinding(task) {
  const checkoutAt = Date.parse(task && task.context && task.context.checkout_link
    && task.context.checkout_link.extractedAt || "");
  const boundAt = Date.parse(task && task.context && task.context.card_binding
    && task.context.card_binding.boundAt || "");
  return Number.isFinite(checkoutAt) && Number.isFinite(boundAt) && checkoutAt > boundAt;
}

class TaskOrchestrator {
  constructor({
    store,
    proxyPools,
    adapters,
    profileAddressGenerator = null,
    sessionDirectory = null,
    accountExportClient = null,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    batchRetryDelayMs = DEFAULT_BATCH_RETRY_DELAY_MS
  }) {
    this.store = store;
    this.proxyPools = proxyPools;
    this.adapters = adapters;
    this.profileAddressGenerator = profileAddressGenerator;
    this.sessionDirectory = sessionDirectory ? path.resolve(sessionDirectory) : null;
    this.accountExportClient = accountExportClient;
    this.sleep = sleep;
    const parsedRetryDelay = Number(batchRetryDelayMs);
    this.batchRetryDelayMs = Number.isFinite(parsedRetryDelay)
      ? Math.max(0, Math.min(parsedRetryDelay, 60_000))
      : DEFAULT_BATCH_RETRY_DELAY_MS;
    this.tasks = [];
    this.running = new Set();
  }

  async init() {
    const stored = await this.store.read();
    this.tasks = Array.isArray(stored.tasks) ? stored.tasks : [];
    let migrated = false;
    for (const task of this.tasks) {
      const lastError = [...(task.logs || [])].reverse().find((entry) => entry.level === "error");
      const code = String(lastError && lastError.details && lastError.details.code || "");
      if (task.state === "TRIAL_PAYMENT_FAILED" && BLOCKED_STAGE_CODES.has(code)) {
        task.state = "TRIAL_PAYMENT_BLOCKED";
        const stage = (task.stages || []).find((candidate) => candidate.key === "trial_payment");
        if (stage) stage.state = "BLOCKED";
        task.updatedAt = new Date().toISOString();
        migrated = true;
      }
    }
    if (migrated) await this.persist();
  }

  pipeline() {
    return PIPELINE.map((stage) => ({ ...stage }));
  }

  batchConfiguration() {
    return Object.freeze({
      maxConcurrency: MAX_BATCH_TASKS,
      maxImportSize: MAX_IMPORT_ACCOUNTS,
      maxRetries: MAX_BATCH_RETRIES,
      defaultRetries: 2,
      retryDelayMs: this.batchRetryDelayMs,
      stages: ["registration", "checkout_link", "trial_payment"],
      subscriptionMode: "synchronized_barrier"
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
    for (let index = 0; index < selected.length; index += 1) {
      const task = selected[index];
      try {
        if (format === "email_url") {
          const registration = task.context && task.context.registration;
          const email = String(registration && registration.email || "").trim();
          const inboxUrl = String(registration && registration.inboxUrl || "").trim();
          if (!email || !inboxUrl) {
            throw new AppError(409, "ACCOUNT_EXPORT_SOURCE_MISSING", "The account is missing its email or mailbox URL.");
          }
          lines.push(`${email}---${inboxUrl}`);
        } else {
          if (!this.accountExportClient || typeof this.accountExportClient.readAccessToken !== "function") {
            throw new AppError(503, "ACCOUNT_EXPORT_CLIENT_MISSING", "The access-token export client is not initialized.");
          }
          const accountSession = task.context && task.context.accountSession;
          const proxy = this.proxyPools.select("US", task.logs.length + index);
          lines.push(await this.accountExportClient.readAccessToken({
            taskId: task.id,
            accountSession,
            proxy
          }));
        }
      } catch (error) {
        failures.push({
          id: task.id,
          account: task.account && task.account.account || task.id,
          error: String(error && error.code || "ACCOUNT_EXPORT_FAILED"),
          message: sanitizeText(error && error.message, 200)
        });
      }
    }
    if (!lines.length) {
      throw new AppError(409, "ACCOUNT_EXPORT_EMPTY", failures[0] && failures[0].message || "No accounts were exported.");
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return Object.freeze({
      format,
      filename: `plus-extractor-${format}-${stamp}.txt`,
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

  async removeSavedSession(task) {
    const sessionPath = this.savedSessionPath(task);
    if (!sessionPath) return false;
    try {
      await fs.unlink(sessionPath);
      return true;
    } catch (error) {
      if (error && error.code === "ENOENT") return false;
      return false;
    }
  }

  async generateCardProfile(id) {
    const task = this.find(id);
    const checkoutStage = task.stages.find((stage) => stage.key === "checkout_link");
    if (!checkoutStage || checkoutStage.state !== "COMPLETED") {
      throw new AppError(409, "CHECKOUT_LINK_REQUIRED", "Complete checkout-link extraction before generating card profile data.");
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
      task.context.card_binding = null;
      task.context.trial_payment = null;
      task.state = "CHECKOUT_LINK_READY";
      this.setStage(task, "card_binding", "READY");
      this.setStage(task, "trial_payment", "PENDING");
      task.updatedAt = new Date().toISOString();
      this.log(task, "success", replacingExistingCard
        ? "重新绑卡会话已准备；旧支付方式摘要已清除，等待 Stripe 托管输入"
        : "一次性绑卡会话已准备；卡资料不会经过本地 API", {
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
      throw new AppError(409, "CARD_BINDING_STATE_INVALID", `当前状态不能完成绑卡：${task.state}`);
    }
    this.running.add(id);
    const proxy = this.proxyPools.select("US", task.logs.length);
    task.state = "BINDING_CARD";
    task.currentStage = "card_binding";
    task.updatedAt = new Date().toISOString();
    this.setStage(task, "card_binding", "RUNNING");
    this.log(task, "info", "Stripe 已返回确认结果，正在通过 US 会话核验", {
      proxies: { US: summarizeProxy(proxy, 0).endpoint }
    });
    await this.persist();
    try {
      const result = await this.adapters.cardBinding.complete({
        taskId: task.id,
        proxy,
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
      delete task.context.trial_payment;
      task.state = "CARD_BOUND";
      this.setStage(task, "card_binding", "COMPLETED");
      this.setStage(task, "trial_payment", "PENDING");
      this.log(task, "success", "自动绑卡完成；仅保存卡品牌、尾号和有效期");
      task.updatedAt = new Date().toISOString();
      await this.persist();
      return this.publicTask(task);
    } catch (error) {
      task.state = "CARD_BINDING_FAILED";
      this.setStage(task, "card_binding", "FAILED");
      this.log(task, "error", sanitizeText(error && error.message, 300), {
        code: error && error.code || "CARD_BINDING_FAILED"
      });
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
      task.updatedAt = new Date().toISOString();
      this.log(task, "info", "一次性绑卡会话已关闭；请重新点击开始绑卡以创建新会话");
      await this.persist();
    }
    return result;
  }

  async create(input = {}) {
    this.proxyPools.requireConfigured();
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

  async importAccounts(input = {}) {
    this.proxyPools.requireConfigured();
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
      count: tasks.length,
      tasks: tasks.map((task) => this.publicTask(task))
    });
  }

  normalizeBatchRequest(input = {}) {
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
    if (ids.length > MAX_BATCH_TASKS) {
      throw new AppError(400, "TASK_BATCH_TOO_LARGE", `At most ${MAX_BATCH_TASKS} tasks can run concurrently.`);
    }
    const tasks = ids.map((id) => this.find(id));
    if (this.running.size + tasks.length > MAX_BATCH_TASKS) {
      throw new AppError(409, "TASK_CONCURRENCY_LIMIT", `The global concurrency limit is ${MAX_BATCH_TASKS} tasks.`);
    }
    for (const task of tasks) {
      if (this.running.has(task.id)) {
        throw new AppError(409, "TASK_ALREADY_RUNNING", `Task ${task.id} is already running.`);
      }
      if (!BATCH_RUN_STATES[stage].has(task.state)) {
        throw new AppError(409, "TASK_BATCH_STATE_INVALID", `Task ${task.id} is ${task.state}, which is not ready for ${stage}.`);
      }
    }
    return { stage, ids, tasks };
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
      return this.runSynchronizedTrialBatch(batch.tasks);
    }
    const attemptsByTask = new Map(batch.tasks.map((task) => [task.id, 0]));
    let pending = [...batch.tasks];
    let retryRounds = 0;
    let retryExecutions = 0;
    while (pending.length) {
      const round = await Promise.allSettled(pending.map(async (task) => {
        attemptsByTask.set(task.id, attemptsByTask.get(task.id) + 1);
        return this.run(task.id);
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
      limit: MAX_BATCH_TASKS,
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

  async runSynchronizedTrialBatch(tasks) {
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
        mode: "synchronized_barrier",
        status: `${phase}_failed`,
        limit: MAX_BATCH_TASKS,
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
        if (!checkoutCreatedAfterCardBinding(task)) {
          await entry.reportProgress("Refreshing the active Checkout concurrently after card binding.");
          const refreshed = await this.adapters.checkoutLink.execute({
            taskId: task.id,
            proxies: entry.proxies,
            accountSession: task.context.accountSession,
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
        entry.prepared = await adapter.prepare({
          taskId: task.id,
          proxy: entry.proxy,
          proxies: entry.proxies,
          registration: task.context.registration,
          accountSession: task.context.accountSession,
          checkoutUrl: task.context.checkoutUrl,
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
        this.log(entry.task, "info", "All accounts are ready; confirm requests are released in one event-loop batch.", {
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
        mode: "synchronized_barrier",
        status: failures.length ? "completed_with_failures" : "completed",
        limit: MAX_BATCH_TASKS,
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
    if (this.running.has(id)) throw new AppError(409, "TASK_ALREADY_RUNNING", "任务正在执行。");
    if (this.running.size >= MAX_BATCH_TASKS) {
      throw new AppError(409, "TASK_CONCURRENCY_LIMIT", `The global concurrency limit is ${MAX_BATCH_TASKS} tasks.`);
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
    this.running.add(id);
    try {
      if (["QUEUED", "REGISTERING_BLOCKED", "REGISTRATION_BLOCKED", "REGISTRATION_FAILED"].includes(task.state)) {
        return await this.runStage(task, {
          key: "registration",
          running: "REGISTERING",
          success: "REGISTERED",
          failed: "REGISTRATION_FAILED",
          adapter: this.adapters.registration,
          proxyRegion: "US"
        });
      }
      if (["REGISTERED", "CHECKOUT_LINK_BLOCKED", "EXTRACTION_FAILED"].includes(task.state)) {
        return await this.runStage(task, {
          key: "checkout_link",
          running: "EXTRACTING_CHECKOUT_LINK",
          success: "CHECKOUT_LINK_READY",
          failed: "EXTRACTION_FAILED",
          adapter: this.adapters.checkoutLink,
          proxyRegions: ["US", "TR"]
        });
      }
      if (["CHECKOUT_LINK_READY", "CARD_BINDING_BLOCKED", "CARD_BINDING_FAILED"].includes(task.state)) {
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
          confirmed: true
        });
      }
      throw new AppError(409, "TASK_STATE_NOT_RUNNABLE", `当前状态不可执行：${task.state}`);
    } finally {
      this.running.delete(id);
    }
  }

  async runStage(task, definition) {
    const regions = Array.isArray(definition.proxyRegions) && definition.proxyRegions.length
      ? definition.proxyRegions
      : [definition.proxyRegion];
    const proxies = Object.fromEntries(regions.map((region, offset) => [
      region,
      this.proxyPools.select(region, task.logs.length + offset)
    ]));
    const proxy = proxies[definition.proxyRegion] || proxies[regions[0]];
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
      const reportProgress = async (message, details = undefined) => {
        task.updatedAt = new Date().toISOString();
        this.log(task, "info", message, details);
        await this.persist();
      };
      if (definition.refreshCheckoutAfterCardBinding && !checkoutCreatedAfterCardBinding(task)) {
        await reportProgress("已绑定默认卡，正在刷新活动 Checkout 以挂载最新 Customer 支付方式");
        const refreshed = await this.adapters.checkoutLink.execute({
          taskId: task.id,
          proxies,
          accountSession: task.context.accountSession,
          reportProgress
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
      const result = await definition.adapter.execute({
        taskId: task.id,
        proxy,
        proxies,
        registration: task.context.registration,
        accountSession: task.context.accountSession,
        checkoutUrl: task.context.checkoutUrl,
        cardProfile: task.context.card_profile,
        cardBinding: task.context.card_binding,
        confirmed: definition.confirmed === true,
        reportProgress
      });
      if (definition.key === "registration") {
        task.context.registrationResult = result || {};
        task.context.accountSession = result && result.session ? result.session : null;
      } else {
        task.context[definition.key] = definition.key === "trial_payment"
          ? normalizeTrialSubscriptionResult(result)
          : result || {};
        if (definition.key === "checkout_link") {
          task.context.checkoutUrl = result && result.checkoutUrl || null;
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
    return structuredClone({
      id: task.id,
      state: task.state,
      currentStage: task.currentStage,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      abandonedAt: task.abandonedAt || null,
      account: task.account || null,
      checkoutLink: checkout ? {
        url: checkout.checkoutUrl || "",
        campaignId: checkout.campaignId || "",
        promotionApplied: checkout.promotionApplied === true,
        promotionStatus: checkout.promotionStatus || (checkout.promotionApplied === true ? "applied" : "not_offered"),
        route: checkout.route || "",
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
  normalizeTrialSubscriptionResult
};
