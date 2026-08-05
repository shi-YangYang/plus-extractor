"use strict";

const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");
const { JsonStore } = require("./lib/json-store");
const { AppError } = require("./lib/errors");
const { publicError } = require("./lib/sanitize");
const { ProxyPoolService } = require("./services/proxy-pool-service");
const { TaskOrchestrator } = require("./services/task-orchestrator");
const { RegistrationAdapter } = require("./adapters/registration-adapter");
const { CheckoutLinkAdapter } = require("./adapters/checkout-link-adapter");
const { CardBindingAdapter } = require("./adapters/card-binding-adapter");
const { TrialPaymentAdapter } = require("./adapters/trial-payment-adapter");
const { ChatGptProtocolRegistrationClient } = require("./services/chatgpt-protocol-registration-client");
const { ChatGptCheckoutLinkClient } = require("./services/chatgpt-checkout-link-client");
const { ChatGptCardBindingClient } = require("./services/chatgpt-card-binding-client");
const { ChatGptTrialSubscriptionClient } = require("./services/chatgpt-trial-subscription-client");
const { ProfileAddressGenerator } = require("./services/profile-address-generator");
const { AccountExportService } = require("./services/account-export-service");

const MAX_BODY_BYTES = 1_000_000;
const ALLOWED_ORIGINS = new Set([
  "http://127.0.0.1:17891",
  "http://localhost:17891"
]);

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(body);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new AppError(413, "BODY_TOO_LARGE", "请求体过大");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AppError(400, "INVALID_JSON", "请求体不是有效 JSON");
  }
}

function rejectRawCardData(input) {
  const forbidden = new Set([
    "cardnumber",
    "pan",
    "primaryaccountnumber",
    "cvc",
    "cvv",
    "securitycode",
    "expiry",
    "expiration",
    "expmonth",
    "expyear"
  ]);
  const queue = input && typeof input === "object" ? [input] : [];
  while (queue.length) {
    const value = queue.shift();
    for (const [key, nested] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (forbidden.has(normalizedKey)) {
        throw new AppError(
          400,
          "RAW_CARD_DATA_NOT_ACCEPTED",
          "Card number, expiry and security code must stay inside the Stripe hosted element."
        );
      }
      if (nested && typeof nested === "object") queue.push(nested);
    }
  }
}

function applyCors(request, response) {
  const origin = String(request.headers.origin || "");
  if (!origin) return;
  if (!ALLOWED_ORIGINS.has(origin)) {
    throw new AppError(403, "ORIGIN_NOT_ALLOWED", "请求来源不受信任");
  }
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET,PUT,POST,DELETE,OPTIONS");
}

async function createApplication(options = {}) {
  const dataDirectory = path.resolve(options.dataDirectory || process.env.LOCAL_WEB_DATA_DIR || path.join(__dirname, "../data"));
  const proxyPools = new ProxyPoolService(new JsonStore(path.join(dataDirectory, "proxy-pools.json"), { US: "", TR: "" }));
  await proxyPools.init();

  const registrationClient = Object.hasOwn(options, "registrationClient")
    ? options.registrationClient
    : Object.hasOwn(options, "registrationDriver")
    ? options.registrationDriver
    : new ChatGptProtocolRegistrationClient({
      sessionDirectory: path.join(dataDirectory, "sessions")
    });
  const checkoutClient = Object.hasOwn(options, "checkoutClient")
    ? options.checkoutClient
    : new ChatGptCheckoutLinkClient();
  const cardBindingClient = Object.hasOwn(options, "cardBindingClient")
    ? options.cardBindingClient
    : new ChatGptCardBindingClient();
  const trialPaymentClient = Object.hasOwn(options, "trialPaymentClient")
    ? options.trialPaymentClient
    : new ChatGptTrialSubscriptionClient();
  const profileAddressGenerator = Object.hasOwn(options, "profileAddressGenerator")
    ? options.profileAddressGenerator
    : new ProfileAddressGenerator();
  const accountExportClient = Object.hasOwn(options, "accountExportClient")
    ? options.accountExportClient
    : new AccountExportService();
  const adapters = {
    registration: new RegistrationAdapter({
      mailboxReader: options.mailboxReader,
      registrationClient
    }),
    checkoutLink: new CheckoutLinkAdapter({ checkoutClient }),
    cardBinding: new CardBindingAdapter({ cardBindingClient }),
    trialPayment: new TrialPaymentAdapter({ trialPaymentClient })
  };
  const tasks = new TaskOrchestrator({
    store: new JsonStore(path.join(dataDirectory, "tasks.json"), { tasks: [] }),
    proxyPools,
    adapters,
    profileAddressGenerator,
    sessionDirectory: path.join(dataDirectory, "sessions"),
    accountExportClient,
    sleep: options.taskSleep,
    batchRetryDelayMs: options.batchRetryDelayMs
  });
  await tasks.init();

  const handler = async (request, response) => {
    try {
      applyCors(request, response);
      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }

      const url = new URL(request.url, "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/api/health") {
        sendJson(response, 200, {
          ok: true,
          service: "plus-extractor-local-api",
          now: new Date().toISOString()
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/bootstrap") {
        sendJson(response, 200, {
          ok: true,
          deprecatedPlugin: true,
          proxyPools: proxyPools.summary(),
          pipeline: tasks.pipeline(),
          adapters: tasks.adapterStatus(),
          accountExport: { formats: ["email_url", "access_token"], maxBatchSize: 500 },
          batch: tasks.batchConfiguration(),
          tasks: tasks.list()
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/proxy-pools") {
        sendJson(response, 200, { ok: true, proxyPools: proxyPools.summary() });
        return;
      }

      if (request.method === "PUT" && url.pathname === "/api/proxy-pools") {
        const body = await readJson(request);
        const summary = await proxyPools.replace({ US: body.US, TR: body.TR });
        sendJson(response, 200, { ok: true, proxyPools: summary });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/proxy-pools/probe") {
        const body = await readJson(request);
        sendJson(response, 200, await proxyPools.probe(body.region, body.index));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/mailbox/probe") {
        const body = await readJson(request);
        const proxy = proxyPools.select("US", Number(body.proxyIndex) || 0);
        const mailbox = await adapters.registration.probe({ ...body, proxy });
        sendJson(response, 200, { ok: true, mailbox });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/tasks") {
        sendJson(response, 200, { ok: true, tasks: tasks.list() });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/tasks") {
        const body = await readJson(request);
        sendJson(response, 201, { ok: true, task: await tasks.create(body) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/tasks/import") {
        const body = await readJson(request);
        sendJson(response, 201, { ok: true, import: await tasks.importAccounts(body) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/tasks/batch/run") {
        const body = await readJson(request);
        sendJson(response, 200, { ok: true, batch: await tasks.runBatch(body) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/tasks/export") {
        const body = await readJson(request);
        sendJson(response, 200, { ok: true, export: await tasks.exportAccounts(body) });
        return;
      }

      const taskMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)$/i);
      if (request.method === "GET" && taskMatch) {
        sendJson(response, 200, { ok: true, task: tasks.get(taskMatch[1]) });
        return;
      }

      if (request.method === "DELETE" && taskMatch) {
        sendJson(response, 200, { ok: true, deletion: await tasks.delete(taskMatch[1]) });
        return;
      }

      const abandonMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/abandon$/i);
      if (request.method === "POST" && abandonMatch) {
        sendJson(response, 200, { ok: true, task: await tasks.abandon(abandonMatch[1]) });
        return;
      }

      const runMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/run$/i);
      if (request.method === "POST" && runMatch) {
        const body = await readJson(request);
        sendJson(response, 200, { ok: true, task: await tasks.run(runMatch[1], body) });
        return;
      }

      const cardProfileMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/card-profile$/i);
      if (request.method === "POST" && cardProfileMatch) {
        sendJson(response, 200, { ok: true, task: await tasks.generateCardProfile(cardProfileMatch[1]) });
        return;
      }

      const cardBindingPrepareMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/card-binding\/prepare$/i);
      if (request.method === "POST" && cardBindingPrepareMatch) {
        sendJson(response, 200, {
          ok: true,
          preparation: await tasks.prepareCardBinding(cardBindingPrepareMatch[1])
        });
        return;
      }

      const cardBindingCompleteMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/card-binding\/complete$/i);
      if (request.method === "POST" && cardBindingCompleteMatch) {
        const body = await readJson(request);
        rejectRawCardData(body);
        sendJson(response, 200, {
          ok: true,
          task: await tasks.completeCardBinding(cardBindingCompleteMatch[1], body)
        });
        return;
      }

      const cardBindingCancelMatch = url.pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/card-binding\/cancel$/i);
      if (request.method === "POST" && cardBindingCancelMatch) {
        const body = await readJson(request);
        sendJson(response, 200, {
          ok: true,
          ...(await tasks.cancelCardBinding(cardBindingCancelMatch[1], body))
        });
        return;
      }

      throw new AppError(404, "NOT_FOUND", "接口不存在");
    } catch (error) {
      const status = Number(error && error.status) || 500;
      if (status >= 500 && !(error instanceof AppError)) console.error(error);
      sendJson(response, status, publicError(error));
    }
  };

  return {
    handler,
    services: { proxyPools, tasks, profileAddressGenerator, cardBindingClient, trialPaymentClient, accountExportClient },
    createServer: () => http.createServer(handler)
  };
}

module.exports = { createApplication, rejectRawCardData };
