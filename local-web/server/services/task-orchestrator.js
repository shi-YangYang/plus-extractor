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

function checkoutCreatedAfterCardBinding(task) {
  const checkoutAt = Date.parse(task && task.context && task.context.checkout_link
    && task.context.checkout_link.extractedAt || "");
  const boundAt = Date.parse(task && task.context && task.context.card_binding
    && task.context.card_binding.boundAt || "");
  return Number.isFinite(checkoutAt) && Number.isFinite(boundAt) && checkoutAt > boundAt;
}

class TaskOrchestrator {
  constructor({ store, proxyPools, adapters, profileAddressGenerator = null, sessionDirectory = null, accountExportClient = null }) {
    this.store = store;
    this.proxyPools = proxyPools;
    this.adapters = adapters;
    this.profileAddressGenerator = profileAddressGenerator;
    this.sessionDirectory = sessionDirectory ? path.resolve(sessionDirectory) : null;
    this.accountExportClient = accountExportClient;
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
    this.log(task, "info", "任务已创建，等待执行注册阶段");
    this.tasks.push(task);
    await this.persist();
    return this.publicTask(task);
  }

  async run(id, input = {}) {
    const task = this.find(id);
    if (this.running.has(id)) throw new AppError(409, "TASK_ALREADY_RUNNING", "任务正在执行。");
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
    await this.store.write({ tasks: this.tasks });
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
