"use strict";

const net = require("node:net");
const tls = require("node:tls");
const zlib = require("node:zlib");
const { AppError } = require("./errors");

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_PROXY_CONNECT_RESPONSE_TIMEOUT_MS = 10_000;
const PROXY_ACCESS_DIAGNOSTIC_URL = "http://mayips.com/";

function appError(status, code, message, cause) {
  const error = new AppError(status, code, message);
  if (cause) error.cause = cause;
  return error;
}

function connectToEndpoint(endpoint, timeoutMs, errorPrefix, label) {
  return new Promise((resolve, reject) => {
    const socket = endpoint.scheme === "https"
      ? tls.connect({
        host: endpoint.host,
        port: endpoint.port,
        servername: endpoint.host,
        rejectUnauthorized: true,
        ALPNProtocols: ["http/1.1"]
      })
      : net.createConnection({ host: endpoint.host, port: endpoint.port });
    const readyEvent = endpoint.scheme === "https" ? "secureConnect" : "connect";
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(appError(504, `${errorPrefix}_TIMEOUT`, `${label} connection timed out.`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off(readyEvent, onReady);
      socket.off("error", onError);
    };
    const onReady = () => {
      cleanup();
      resolve(socket);
    };
    const onError = (error) => {
      cleanup();
      socket.destroy();
      reject(appError(502, `${errorPrefix}_FAILED`, `${label} connection failed: ${error.code || "NETWORK_ERROR"}`, error));
    };
    socket.once(readyEvent, onReady);
    socket.once("error", onError);
  });
}

function parseFirstHop(value) {
  if (value === false || value === null || String(value || "").toLowerCase() === "off") return null;
  if (value && typeof value === "object") {
    return {
      scheme: value.scheme === "https" ? "https" : "http",
      host: String(value.host || "127.0.0.1"),
      port: Number(value.port) || 7897,
      username: String(value.username || ""),
      password: String(value.password || "")
    };
  }
  let url;
  try {
    url = new URL(String(value || "http://127.0.0.1:7897"));
  } catch {
    throw appError(500, "INVALID_FIRST_HOP", "LOCAL_WEB_FIRST_HOP is invalid.");
  }
  const scheme = url.protocol.slice(0, -1).toLowerCase();
  if (!["http", "https"].includes(scheme) || !url.hostname || !url.port || url.pathname !== "/") {
    throw appError(500, "INVALID_FIRST_HOP", "LOCAL_WEB_FIRST_HOP must be an HTTP or HTTPS proxy URL.");
  }
  return {
    scheme,
    host: url.hostname,
    port: Number(url.port),
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password)
  };
}

function resolveFirstHop(options = {}) {
  if (Object.hasOwn(options, "firstHop")) return parseFirstHop(options.firstHop);
  return parseFirstHop(process.env.LOCAL_WEB_FIRST_HOP || "http://127.0.0.1:7897");
}

function connectRequest(host, port, credentials) {
  const lines = [
    `CONNECT ${host}:${port} HTTP/1.1`,
    `Host: ${host}:${port}`,
    "Proxy-Connection: keep-alive"
  ];
  if (credentials && (credentials.username || credentials.password)) {
    const encoded = Buffer.from(`${credentials.username}:${credentials.password}`, "utf8").toString("base64");
    lines.push(`Proxy-Authorization: Basic ${encoded}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}

async function openProxySocket(proxy, options = {}) {
  if (!["http", "https"].includes(proxy.scheme)) {
    throw appError(
      501,
      "PROXY_TRANSPORT_PENDING",
      `The local HTTP client currently supports HTTP and HTTPS proxy gateways; received ${proxy.scheme}.`
    );
  }
  const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const firstHop = resolveFirstHop(options);
  if (firstHop) {
    let firstHopSocket;
    try {
      firstHopSocket = await connectToEndpoint(firstHop, Math.min(timeoutMs, 3_000), "FIRST_HOP_CONNECT", "Local first-hop proxy");
    } catch (error) {
      if (!options.firstHopRequired && ["FIRST_HOP_CONNECT_FAILED", "FIRST_HOP_CONNECT_TIMEOUT"].includes(error.code)) {
        const socket = await connectToEndpoint(proxy, timeoutMs, "PROXY_CONNECT", "US proxy gateway");
        return { socket, route: "direct", firstHop: null };
      }
      throw error;
    }
    try {
      firstHopSocket.write(connectRequest(proxy.host, proxy.port, firstHop));
      const header = await readHttpHeader(
        firstHopSocket,
        64 * 1024,
        timeoutMs,
        "FIRST_HOP_CONNECT_RESPONSE_TIMEOUT"
      );
      const response = parseHeaderBlock(header);
      if (response.status !== 200) {
        throw appError(502, "FIRST_HOP_CONNECT_REJECTED", `Local first-hop proxy rejected the gateway tunnel with HTTP ${response.status}.`);
      }
      if (proxy.scheme === "https") {
        firstHopSocket.__localWebRemainder = null;
        const secureProxySocket = tls.connect({
          socket: firstHopSocket,
          servername: proxy.host,
          rejectUnauthorized: true,
          ALPNProtocols: ["http/1.1"]
        });
        firstHopSocket.resume();
        await waitForSecureConnect(secureProxySocket, timeoutMs);
        return {
          socket: secureProxySocket,
          route: "first_hop",
          firstHop: `${firstHop.host}:${firstHop.port}`
        };
      }
      return {
        socket: firstHopSocket,
        route: "first_hop",
        firstHop: `${firstHop.host}:${firstHop.port}`
      };
    } catch (error) {
      firstHopSocket.destroy();
      throw error;
    }
  }
  const socket = await connectToEndpoint(proxy, timeoutMs, "PROXY_CONNECT", "US proxy gateway");
  return { socket, route: "direct", firstHop: null };
}

async function openProxyTunnel(host, port, proxy, options = {}) {
  const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const opened = await openProxySocket(proxy, { ...options, timeoutMs });
  try {
    opened.socket.write(connectRequest(host, port, proxy));
    const responseTimeoutMs = Math.min(
      timeoutMs,
      Number(options.proxyConnectResponseTimeoutMs) || DEFAULT_PROXY_CONNECT_RESPONSE_TIMEOUT_MS
    );
    const header = await readHttpHeader(
      opened.socket,
      64 * 1024,
      responseTimeoutMs,
      "PROXY_CONNECT_RESPONSE_TIMEOUT"
    );
    const response = parseHeaderBlock(header);
    if (response.status !== 200) {
      throw appError(
        502,
        "PROXY_CONNECT_REJECTED",
        `Configured proxy rejected the HTTPS tunnel with HTTP ${response.status}.`
      );
    }
    return opened;
  } catch (error) {
    opened.socket.destroy();
    if (options.diagnoseProxyAccess !== false && [
      "PROXY_CONNECT_RESPONSE_TIMEOUT",
      "PROXY_STREAM_FAILED",
      "PROXY_STREAM_CLOSED"
    ].includes(error && error.code)) {
      const diagnostic = await diagnoseDirectProxyAccess(proxy, Math.min(timeoutMs, 5_000)).catch(() => null);
      if (diagnostic && diagnostic.code === "PROXY_SOURCE_IP_FORBIDDEN") {
        const mapped = appError(
          502,
          diagnostic.code,
          `Proxy provider rejected source IP ${diagnostic.sourceIp}; update the provider access policy or use a supported outbound route.`
        );
        mapped.details = Object.freeze({
          sourceIp: diagnostic.sourceIp,
          providerStatus: diagnostic.status,
          attemptedRoute: opened.route
        });
        throw mapped;
      }
      if (diagnostic && diagnostic.code === "PROXY_AUTH_REJECTED") {
        throw appError(502, diagnostic.code, "Proxy provider rejected the configured username or password.");
      }
      if (opened.route === "first_hop" && diagnostic && diagnostic.reachable === true) {
        return openProxyTunnel(host, port, proxy, {
          ...options,
          firstHop: false,
          diagnoseProxyAccess: false,
          timeoutMs
        });
      }
    }
    throw error;
  }
}

async function diagnoseDirectProxyAccess(proxy, timeoutMs = 5_000) {
  let opened;
  try {
    opened = await openProxySocket(proxy, {
      firstHop: false,
      timeoutMs: Math.min(Number(timeoutMs) || 5_000, 5_000)
    });
    const target = new URL(PROXY_ACCESS_DIAGNOSTIC_URL);
    const credentials = proxy && (proxy.username || proxy.password)
      ? Buffer.from(`${proxy.username || ""}:${proxy.password || ""}`, "utf8").toString("base64")
      : "";
    const lines = [
      `GET ${target.href} HTTP/1.1`,
      `Host: ${target.host}`,
      "User-Agent: Plus-Extractor-Proxy-Diagnostic/1.0",
      "Connection: close"
    ];
    if (credentials) lines.push(`Proxy-Authorization: Basic ${credentials}`);
    opened.socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    const header = await readHttpHeader(
      opened.socket,
      64 * 1024,
      Math.min(Number(timeoutMs) || 5_000, 5_000),
      "PROXY_DIAGNOSTIC_RESPONSE_TIMEOUT"
    );
    const response = parseHeaderBlock(header);
    const body = await collectToEnd(opened.socket, 64 * 1024, Math.min(Number(timeoutMs) || 5_000, 5_000));
    const text = body.toString("utf8").slice(0, 4_096);
    const forbidden = text.match(/forbidden\s+ip=([0-9a-f:.]+)\s+not\s+supported/i);
    if (response.status === 403 && forbidden) {
      return Object.freeze({
        reachable: false,
        code: "PROXY_SOURCE_IP_FORBIDDEN",
        status: response.status,
        sourceIp: forbidden[1]
      });
    }
    if (response.status === 407) {
      return Object.freeze({ reachable: false, code: "PROXY_AUTH_REJECTED", status: response.status });
    }
    return Object.freeze({
      reachable: response.status >= 200 && response.status < 400,
      code: "",
      status: response.status,
      sourceIp: null
    });
  } finally {
    if (opened && opened.socket && !opened.socket.destroyed) opened.socket.destroy();
  }
}

function readUntil(socket, delimiter, maxBytes, timeoutMs, timeoutCode) {
  return new Promise((resolve, reject) => {
    let buffer = socket.__localWebRemainder || Buffer.alloc(0);
    socket.__localWebRemainder = null;
    const timer = setTimeout(() => {
      cleanup();
      reject(appError(504, timeoutCode, "Proxy response timed out."));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
    };
    const inspect = () => {
      const boundary = buffer.indexOf(delimiter);
      if (boundary < 0) {
        if (buffer.length > maxBytes) {
          cleanup();
          reject(appError(502, "PROXY_HEADER_TOO_LARGE", "Proxy response header is too large."));
        }
        return false;
      }
      cleanup();
      const end = boundary + delimiter.length;
      socket.pause();
      socket.__localWebRemainder = buffer.subarray(end);
      resolve(buffer.subarray(0, end));
      return true;
    };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      inspect();
    };
    const onError = (error) => {
      cleanup();
      reject(appError(502, "PROXY_STREAM_FAILED", `Proxy stream failed: ${error.code || "NETWORK_ERROR"}`, error));
    };
    const onEnd = () => {
      cleanup();
      reject(appError(502, "PROXY_STREAM_CLOSED", "Proxy gateway closed the connection early."));
    };
    if (inspect()) return;
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
    socket.resume();
  });
}

function readHttpHeader(socket, maxBytes, timeoutMs, timeoutCode) {
  return new Promise((resolve, reject) => {
    let buffer = socket.__localWebRemainder || Buffer.alloc(0);
    socket.__localWebRemainder = null;
    const timer = setTimeout(() => {
      cleanup();
      reject(appError(504, timeoutCode, "Proxy response timed out."));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
    };
    const inspect = () => {
      const crlfBoundary = buffer.indexOf(Buffer.from("\r\n\r\n"));
      const lfBoundary = buffer.indexOf(Buffer.from("\n\n"));
      let boundary = -1;
      let delimiterLength = 0;
      if (crlfBoundary >= 0 && (lfBoundary < 0 || crlfBoundary <= lfBoundary)) {
        boundary = crlfBoundary;
        delimiterLength = 4;
      } else if (lfBoundary >= 0) {
        boundary = lfBoundary;
        delimiterLength = 2;
      }
      if (boundary < 0) {
        if (buffer.length > maxBytes) {
          cleanup();
          reject(appError(502, "PROXY_HEADER_TOO_LARGE", "Proxy response header is too large."));
        }
        return false;
      }
      cleanup();
      const end = boundary + delimiterLength;
      socket.pause();
      socket.__localWebRemainder = buffer.subarray(end);
      resolve(buffer.subarray(0, end));
      return true;
    };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      inspect();
    };
    const onError = (error) => {
      cleanup();
      reject(appError(502, "PROXY_STREAM_FAILED", `Proxy stream failed: ${error.code || "NETWORK_ERROR"}`, error));
    };
    const onEnd = () => {
      if (inspect()) return;
      cleanup();
      reject(appError(502, "PROXY_STREAM_CLOSED", "Proxy gateway closed the connection early."));
    };
    if (inspect()) return;
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
    socket.resume();
  });
}

function collectToEnd(socket, maxBytes, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const remainder = socket.__localWebRemainder;
    socket.__localWebRemainder = null;
    if (remainder && remainder.length) {
      chunks.push(remainder);
      size += remainder.length;
    }
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(appError(504, "UPSTREAM_RESPONSE_TIMEOUT", "Mailbox response timed out."));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onError);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        cleanup();
        socket.destroy();
        reject(appError(502, "UPSTREAM_RESPONSE_TOO_LARGE", "Mailbox response exceeded the local size limit."));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks));
    };
    const onError = (error) => {
      cleanup();
      reject(appError(502, "UPSTREAM_RESPONSE_FAILED", `Mailbox response failed: ${error.code || "NETWORK_ERROR"}`, error));
    };
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("error", onError);
    socket.resume();
  });
}

function parseHeaderBlock(headerBuffer) {
  const lines = headerBuffer.toString("latin1").split(/\r?\n/);
  const statusMatch = lines.shift().match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+(.*))?$/i);
  if (!statusMatch) throw appError(502, "INVALID_HTTP_RESPONSE", "Upstream returned an invalid HTTP status line.");
  const headers = {};
  for (const line of lines) {
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
  }
  return { status: Number(statusMatch[1]), statusText: statusMatch[2] || "", headers };
}

function decodeChunked(buffer) {
  const chunks = [];
  let offset = 0;
  while (offset < buffer.length) {
    const lineEnd = buffer.indexOf("\r\n", offset, "latin1");
    if (lineEnd < 0) throw appError(502, "INVALID_CHUNKED_RESPONSE", "Mailbox response has an incomplete chunk header.");
    const sizeText = buffer.subarray(offset, lineEnd).toString("ascii").split(";", 1)[0].trim();
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isFinite(size) || size < 0) throw appError(502, "INVALID_CHUNKED_RESPONSE", "Mailbox response has an invalid chunk size.");
    offset = lineEnd + 2;
    if (size === 0) return Buffer.concat(chunks);
    if (offset + size + 2 > buffer.length) throw appError(502, "INVALID_CHUNKED_RESPONSE", "Mailbox response ended inside a chunk.");
    chunks.push(buffer.subarray(offset, offset + size));
    offset += size;
    if (buffer.subarray(offset, offset + 2).toString("ascii") !== "\r\n") {
      throw appError(502, "INVALID_CHUNKED_RESPONSE", "Mailbox response has an invalid chunk terminator.");
    }
    offset += 2;
  }
  throw appError(502, "INVALID_CHUNKED_RESPONSE", "Mailbox response did not contain a final chunk.");
}

function decodeContent(buffer, headers) {
  let body = /\bchunked\b/i.test(headers["transfer-encoding"] || "") ? decodeChunked(buffer) : buffer;
  const encoding = String(headers["content-encoding"] || "").toLowerCase();
  try {
    if (encoding === "gzip") body = zlib.gunzipSync(body);
    if (encoding === "deflate") body = zlib.inflateSync(body);
    if (encoding === "br") body = zlib.brotliDecompressSync(body);
  } catch (error) {
    throw appError(502, "UPSTREAM_DECOMPRESSION_FAILED", "Mailbox response decompression failed.", error);
  }
  return body;
}

function waitForSecureConnect(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(appError(504, "UPSTREAM_TLS_TIMEOUT", "Mailbox TLS handshake timed out."));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("secureConnect", onSecure);
      socket.off("error", onError);
    };
    const onSecure = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(appError(502, "UPSTREAM_TLS_FAILED", `Mailbox TLS handshake failed: ${error.code || "TLS_ERROR"}`, error));
    };
    socket.once("secureConnect", onSecure);
    socket.once("error", onError);
  });
}

async function requestOnce(target, proxy, options) {
  const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const maxBytes = Number(options.maxBytes) || DEFAULT_MAX_BYTES;
  let proxySocket;
  let upstreamSocket;
  let proxyRoute;
  try {
    const port = Number(target.port) || 443;
    proxyRoute = await openProxyTunnel(target.hostname, port, proxy, { ...options, timeoutMs });
    proxySocket = proxyRoute.socket;

    upstreamSocket = tls.connect({
      socket: proxySocket,
      servername: target.hostname,
      rejectUnauthorized: true,
      ALPNProtocols: ["http/1.1"]
    });
    proxySocket.resume();
    await waitForSecureConnect(upstreamSocket, timeoutMs);
    const requestHeaders = {
      Host: target.host,
      Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
      "Accept-Encoding": "gzip, deflate, br",
      "Accept-Language": "en-US,en;q=0.8",
      "User-Agent": "Plus-Extractor-Local/registration-mailbox",
      Connection: "close",
      ...(options.headers || {})
    };
    const path = `${target.pathname || "/"}${target.search || ""}`;
    const lines = [`GET ${path} HTTP/1.1`];
    for (const [name, value] of Object.entries(requestHeaders)) lines.push(`${name}: ${value}`);
    upstreamSocket.write(`${lines.join("\r\n")}\r\n\r\n`);
    const message = await collectToEnd(upstreamSocket, maxBytes + 128 * 1024, timeoutMs);
    const boundary = message.indexOf("\r\n\r\n");
    if (boundary < 0) throw appError(502, "INVALID_HTTP_RESPONSE", "Mailbox response did not contain HTTP headers.");
    const parsed = parseHeaderBlock(message.subarray(0, boundary + 4));
    const body = decodeContent(message.subarray(boundary + 4), parsed.headers);
    if (body.length > maxBytes) throw appError(502, "UPSTREAM_RESPONSE_TOO_LARGE", "Mailbox response exceeded the local size limit.");
    return {
      ...parsed,
      body,
      url: target.href,
      route: proxyRoute.route,
      firstHop: proxyRoute.firstHop
    };
  } finally {
    if (upstreamSocket && !upstreamSocket.destroyed) upstreamSocket.destroy();
    if (proxySocket && !proxySocket.destroyed) proxySocket.destroy();
  }
}

async function requestTextThroughProxy(input, proxy, options = {}) {
  if (!proxy || typeof proxy !== "object") throw appError(409, "US_PROXY_REQUIRED", "A configured US proxy is required.");
  let target;
  try {
    target = new URL(String(input || ""));
  } catch {
    throw appError(400, "INVALID_UPSTREAM_URL", "Mailbox URL is invalid.");
  }
  if (target.protocol !== "https:") throw appError(400, "HTTPS_UPSTREAM_REQUIRED", "Mailbox URL must use HTTPS.");
  const originalOrigin = target.origin;
  const maxRedirects = Number.isInteger(options.maxRedirects) ? options.maxRedirects : 2;
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const response = await requestOnce(target, proxy, options);
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return {
        status: response.status,
        headers: response.headers,
        text: response.body.toString("utf8"),
        url: response.url,
        route: response.route,
        firstHop: response.firstHop
      };
    }
    const location = response.headers.location;
    if (!location) throw appError(502, "UPSTREAM_REDIRECT_MISSING_LOCATION", "Mailbox redirect did not include a destination.");
    target = new URL(location, target);
    if (target.protocol !== "https:" || target.origin !== originalOrigin) {
      throw appError(502, "UPSTREAM_REDIRECT_REJECTED", "Mailbox redirect left the configured HTTPS origin.");
    }
  }
  throw appError(502, "UPSTREAM_REDIRECT_LIMIT", "Mailbox redirect limit exceeded.");
}

module.exports = {
  decodeChunked,
  diagnoseDirectProxyAccess,
  openProxySocket,
  openProxyTunnel,
  parseHeaderBlock,
  resolveFirstHop,
  requestTextThroughProxy
};
