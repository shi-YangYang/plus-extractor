"use strict";

const crypto = require("node:crypto");
const { AppError } = require("../lib/errors");
const { requestTextThroughProxy } = require("../lib/proxy-request");

const ALLOWED_MAILBOX_HOSTS = new Set(["mail.ai1998.xyz", "icloud.biubiu007.com", "icloud-api.top"]);
const MAILBOX_PROVIDER = Object.freeze({
  "mail.ai1998.xyz": "messages_path",
  "icloud.biubiu007.com": "open_php",
  "icloud-api.top": "share_path"
});

function terminationError(signal) {
  if (signal && signal.reason instanceof AppError) return signal.reason;
  return new AppError(409, "TASK_TERMINATED", "The current task was terminated by the user.");
}

function throwIfTerminated(signal) {
  if (signal && signal.aborted) throw terminationError(signal);
}

async function waitWithSignal(promise, signal) {
  throwIfTerminated(signal);
  if (!signal) return promise;
  let onAbort;
  const aborted = new Promise((resolve, reject) => {
    onAbort = () => reject(terminationError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function decodeHtml(text) {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"'
  };
  return String(text || "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const normalized = entity.toLowerCase();
    if (normalized.startsWith("#x")) return String.fromCodePoint(Number.parseInt(normalized.slice(2), 16));
    if (normalized.startsWith("#")) return String.fromCodePoint(Number.parseInt(normalized.slice(1), 10));
    return Object.hasOwn(named, normalized) ? named[normalized] : match;
  });
}

function visibleText(html) {
  const decoded = decodeHtml(String(html || ""));
  return decodeHtml(decoded
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function maskEmail(email) {
  const [local, domain] = String(email || "").split("@");
  if (!local || !domain) return "[email]";
  const shown = local.length <= 2 ? local[0] : local.slice(0, 2);
  return `${shown}${"*".repeat(Math.max(3, Math.min(8, local.length - shown.length)))}@${domain}`;
}

function rotateMailboxProxySession(proxy) {
  if (!proxy || typeof proxy !== "object") return proxy;
  const password = String(proxy.password || "");
  const match = password.match(/-([A-Z]{2})(?:-[A-Za-z0-9]{8})?$/i);
  if (!match) return proxy;
  const suffix = `-${match[1].toUpperCase()}-${crypto.randomBytes(4).toString("hex")}`;
  const nextPassword = password.replace(/-[A-Z]{2}(?:-[A-Za-z0-9]{8})?$/i, suffix);
  return Object.freeze({ ...proxy, password: nextPassword });
}

function parseAccountLine(value) {
  const line = String(value || "").trim();
  const match = line.match(/^(\S+@icloud\.com)\s*-{3,}\s*(https:\/\/.+)$/i);
  if (!match) {
    throw new AppError(400, "INVALID_ACCOUNT_SOURCE", "Account source must use one line per account: iCloud email---mailbox URL");
  }
  return {
    email: match[1].trim(),
    inboxUrl: match[2].trim()
  };
}

function normalizeMailboxInput(input = {}) {
  const source = input.accountLine ? parseAccountLine(input.accountLine) : input;
  const email = String(source.email || "").trim().toLowerCase();
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@icloud\.com$/i.test(email)) {
    throw new AppError(400, "INVALID_ICLOUD_EMAIL", "A valid @icloud.com address is required.");
  }

  let inboxUrl;
  try {
    inboxUrl = new URL(String(source.inboxUrl || "").trim());
  } catch {
    throw new AppError(400, "INVALID_MAILBOX_URL", "Mailbox URL is invalid.");
  }
  const hostname = inboxUrl.hostname.toLowerCase().replace(/\.$/, "");
  if (inboxUrl.protocol !== "https:" || inboxUrl.username || inboxUrl.password || inboxUrl.hash) {
    throw new AppError(400, "INVALID_MAILBOX_URL", "Mailbox URL must be credential-free HTTPS.");
  }
  if (!ALLOWED_MAILBOX_HOSTS.has(hostname)) {
    throw new AppError(400, "MAILBOX_HOST_NOT_ALLOWED", "Mailbox URL host is not configured for this adapter.");
  }
  const provider = MAILBOX_PROVIDER[hostname];
  if (provider === "messages_path") {
    const pathParts = inboxUrl.pathname.split("/").filter(Boolean);
    if (pathParts.length !== 3 || pathParts[0] !== "messages" || pathParts[1].length < 8) {
      throw new AppError(400, "INVALID_MAILBOX_PATH", "Mailbox URL path does not match the message platform contract.");
    }
    let pathEmail;
    try {
      pathEmail = decodeURIComponent(pathParts[2]).toLowerCase();
    } catch {
      throw new AppError(400, "INVALID_MAILBOX_PATH", "Mailbox URL contains an invalid encoded address.");
    }
    if (pathEmail !== email) {
      throw new AppError(400, "MAILBOX_EMAIL_MISMATCH", "Mailbox URL and iCloud address do not match.");
    }
    inboxUrl.search = "";
    inboxUrl.searchParams.set("all", "1");
  } else if (provider === "open_php") {
    if (inboxUrl.pathname !== "/console/open.php") {
      throw new AppError(400, "INVALID_MAILBOX_PATH", "Mailbox URL path does not match the open.php contract.");
    }
    const queryEmail = String(inboxUrl.searchParams.get("mail") || "").trim().toLowerCase();
    const password = String(inboxUrl.searchParams.get("pwd") || "");
    const limit = String(inboxUrl.searchParams.get("limit") || "1");
    if (queryEmail !== email) {
      throw new AppError(400, "MAILBOX_EMAIL_MISMATCH", "Mailbox URL and iCloud address do not match.");
    }
    if (!password || password.length > 512 || /[\u0000-\u001f\u007f]/.test(password)) {
      throw new AppError(400, "INVALID_MAILBOX_CREDENTIAL", "Mailbox URL contains an invalid pwd value.");
    }
    if (!/^\d{1,3}$/.test(limit) || Number(limit) < 1 || Number(limit) > 100) {
      throw new AppError(400, "INVALID_MAILBOX_LIMIT", "Mailbox URL limit must be between 1 and 100.");
    }
    inboxUrl.searchParams.set("limit", limit);
  } else if (provider === "share_path") {
    const pathParts = inboxUrl.pathname.split("/").filter(Boolean);
    if (pathParts.length !== 3 || pathParts[0] !== "s" || !/^[A-Za-z0-9_-]{16,256}$/.test(pathParts[1])) {
      throw new AppError(400, "INVALID_MAILBOX_PATH", "Mailbox URL path does not match the share-path contract.");
    }
    let pathEmail;
    try {
      pathEmail = decodeURIComponent(pathParts[2]).toLowerCase();
    } catch {
      throw new AppError(400, "INVALID_MAILBOX_PATH", "Mailbox URL contains an invalid encoded address.");
    }
    if (pathEmail !== email) {
      throw new AppError(400, "MAILBOX_EMAIL_MISMATCH", "Mailbox URL and iCloud address do not match.");
    }
    if (inboxUrl.search) {
      throw new AppError(400, "INVALID_MAILBOX_URL", "Share-path mailbox URLs must not contain query parameters.");
    }
  }
  return Object.freeze({ email, inboxUrl: inboxUrl.href, mailboxHost: hostname, mailboxProvider: provider });
}

function extractVerificationCode(text) {
  const keywords = "verification code|security code|one[- ]time code|verify(?:ing)? code|验证码|驗證碼|校验码|代碼|代码";
  const forward = new RegExp(`(?:${keywords})[^0-9]{0,48}([0-9]{6})`, "i");
  const backward = new RegExp(`([0-9]{6})[^0-9]{0,48}(?:${keywords})`, "i");
  const strong = text.match(forward) || text.match(backward);
  if (strong) return strong[1];
  if (!/(?:openai|chatgpt)/i.test(text)) return "";
  const candidates = [...text.matchAll(/(?:^|\D)(\d{6})(?!\d)/g)].map((match) => match[1]);
  const unique = [...new Set(candidates)];
  return unique.length === 1 ? unique[0] : "";
}

function parseMailboxPage(html) {
  const source = String(html || "");
  let json = null;
  try { json = JSON.parse(source); } catch {}
  const jsonStrings = [];
  const jsonCounts = [];
  const jsonMessageArrays = [];
  const jsonTimes = [];
  if (json && typeof json === "object") {
    const queue = [{ value: json, key: "root", depth: 0 }];
    let inspected = 0;
    while (queue.length && inspected < 1000) {
      const { value, key, depth } = queue.shift();
      inspected += 1;
      if (typeof value === "string") {
        jsonStrings.push(value);
        if (/(?:time|date|created|received|sent|timestamp)/i.test(key)) {
          const parsed = Date.parse(value);
          if (Number.isFinite(parsed)) jsonTimes.push(parsed);
        }
        continue;
      }
      if (typeof value === "number" && /^(?:count|total|total_count|message_count)$/i.test(key)
          && Number.isInteger(value) && value >= 0 && value <= 100000) {
        jsonCounts.push(value);
      }
      if (!value || typeof value !== "object" || depth >= 8) continue;
      if (Array.isArray(value) && /(?:mail|message|list|data|record|result)/i.test(key)) {
        jsonMessageArrays.push(value.length);
      }
      for (const [childKey, child] of Object.entries(value)) {
        if (child && typeof child === "object" || typeof child === "string" || typeof child === "number") {
          queue.push({ value: child, key: childKey, depth: depth + 1 });
        }
      }
    }
  }
  const text = jsonStrings.length ? visibleText(jsonStrings.join(" ")) : visibleText(source);
  const countMatch = text.match(/(?:本页显示|page shows?)\s*(\d+)\s*(?:封|messages?)/i);
  const articleCount = (source.match(/<article\b/gi) || []).length;
  const cardCount = (source.match(/class=["'][^"']*\bmail-card\b[^"']*["']/gi) || []).length;
  const timeMatches = [...source.matchAll(/<time\b[^>]*datetime=["']([^"']+)["']/gi)]
    .map((match) => Date.parse(match[1]))
    .filter(Number.isFinite);
  const code = extractVerificationCode(text);
  const detectedCount = Math.max(0, ...jsonCounts, ...jsonMessageArrays, articleCount, cardCount);
  const messageCount = countMatch ? Number(countMatch[1]) : detectedCount;
  const allTimes = [...timeMatches, ...jsonTimes];
  return Object.freeze({
    messageCount,
    empty: /(?:暂无邮件|no messages?|empty mailbox)/i.test(text) || messageCount === 0,
    verificationCode: code,
    codeAvailable: Boolean(code),
    latestMessageAt: allTimes.length ? new Date(Math.max(...allTimes)).toISOString() : null
  });
}

function publicMailboxSnapshot(config, snapshot) {
  return Object.freeze({
    account: maskEmail(config.email),
    mailboxHost: config.mailboxHost,
    mailboxProvider: config.mailboxProvider,
    messageCount: snapshot.messageCount,
    empty: snapshot.empty,
    codeAvailable: snapshot.codeAvailable,
    latestMessageAt: snapshot.latestMessageAt,
    checkedAt: snapshot.checkedAt
  });
}

class MailboxCodeReader {
  constructor(options = {}) {
    this.requestText = options.requestText || requestTextThroughProxy;
    this.now = options.now || (() => new Date());
    this.sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async fetchSnapshot(input = {}) {
    const config = normalizeMailboxInput(input);
    const requestText = typeof input.requestText === "function" ? input.requestText : this.requestText;
    let response = null;
    let lastError = null;
    const attempts = Math.max(1, Math.min(Number(input.requestAttempts) || 3, 3));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      throwIfTerminated(input.signal);
      try {
        response = await waitWithSignal(requestText(config.inboxUrl, rotateMailboxProxySession(input.proxy), {
          timeoutMs: input.timeoutMs || 20_000,
          maxBytes: 2 * 1024 * 1024
        }), input.signal);
        const status = Number(response && response.status) || 0;
        if ((status === 429 || status >= 500) && attempt + 1 < attempts) {
          await waitWithSignal(this.sleep(1_500 * (attempt + 1)), input.signal);
          continue;
        }
        break;
      } catch (error) {
        if (error && error.code === "TASK_TERMINATED") throw error;
        lastError = error;
        if (attempt + 1 < attempts) {
          await waitWithSignal(this.sleep(1_500 * (attempt + 1)), input.signal);
        }
      }
    }
    if (!response) {
      throw new AppError(502, "MAILBOX_NETWORK_ERROR", "Mailbox network request failed after bounded retries.", lastError);
    }
    if (response.status !== 200) {
      throw new AppError(502, "MAILBOX_HTTP_ERROR", `Mailbox platform returned HTTP ${response.status}.`);
    }
    const parsed = parseMailboxPage(response.text);
    return Object.freeze({
      ...parsed,
      email: config.email,
      mailboxHost: config.mailboxHost,
      mailboxProvider: config.mailboxProvider,
      checkedAt: this.now().toISOString()
    });
  }

  async probe(input = {}) {
    const config = normalizeMailboxInput(input);
    const snapshot = await this.fetchSnapshot({ ...config, proxy: input.proxy, timeoutMs: input.timeoutMs });
    return publicMailboxSnapshot(config, snapshot);
  }

  async waitForCode(input = {}) {
    const config = normalizeMailboxInput(input);
    const timeoutMs = Math.max(5_000, Math.min(Number(input.timeoutMs) || 120_000, 10 * 60_000));
    const pollIntervalMs = Math.max(1_000, Math.min(Number(input.pollIntervalMs) || 3_000, 30_000));
    const hasMessageBaseline = Object.hasOwn(input, "afterMessageCount")
      && Number.isFinite(Number(input.afterMessageCount));
    const afterMessageCount = hasMessageBaseline ? Number(input.afterMessageCount) : null;
    const parsedLatestBaseline = Date.parse(String(input.afterLatestMessageAt || ""));
    const hasLatestBaseline = Number.isFinite(parsedLatestBaseline);
    const hasCodeBaseline = Object.hasOwn(input, "afterVerificationCode");
    const afterVerificationCode = hasCodeBaseline ? String(input.afterVerificationCode || "") : "";
    const deadline = Date.now() + timeoutMs;
    let successfulSnapshots = 0;
    let lastTransientError = null;
    do {
      throwIfTerminated(input.signal);
      try {
        const snapshot = await this.fetchSnapshot({
          ...config,
          proxy: input.proxy,
          requestText: input.requestText,
          signal: input.signal,
          timeoutMs: Math.min(20_000, timeoutMs)
        });
        successfulSnapshots += 1;
        lastTransientError = null;
        const parsedLatest = Date.parse(String(snapshot.latestMessageAt || ""));
        const isFresh = (!hasMessageBaseline && !hasLatestBaseline && !hasCodeBaseline)
          || (hasMessageBaseline && snapshot.messageCount > afterMessageCount)
          || (hasLatestBaseline && Number.isFinite(parsedLatest) && parsedLatest > parsedLatestBaseline)
          || (hasCodeBaseline && snapshot.verificationCode && snapshot.verificationCode !== afterVerificationCode);
        if (snapshot.verificationCode && isFresh) return snapshot.verificationCode;
      } catch (error) {
        if (!["MAILBOX_HTTP_ERROR", "MAILBOX_NETWORK_ERROR"].includes(error && error.code)) throw error;
        lastTransientError = error;
      }
      if (Date.now() >= deadline) break;
      await waitWithSignal(this.sleep(Math.min(pollIntervalMs, deadline - Date.now())), input.signal);
    } while (Date.now() <= deadline);
    if (!successfulSnapshots && lastTransientError) {
      throw new AppError(
        502,
        "MAILBOX_UNAVAILABLE_AFTER_RETRIES",
        "Mailbox platform remained unavailable throughout bounded polling.",
        lastTransientError
      );
    }
    throw new AppError(504, "VERIFICATION_CODE_TIMEOUT", "No verification code arrived before the polling deadline.");
  }
}

module.exports = {
  ALLOWED_MAILBOX_HOSTS,
  MAILBOX_PROVIDER,
  MailboxCodeReader,
  extractVerificationCode,
  maskEmail,
  normalizeMailboxInput,
  parseAccountLine,
  parseMailboxPage,
  publicMailboxSnapshot,
  rotateMailboxProxySession,
  visibleText
};
