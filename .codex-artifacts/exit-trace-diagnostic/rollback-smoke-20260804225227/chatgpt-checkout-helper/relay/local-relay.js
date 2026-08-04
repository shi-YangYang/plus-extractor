"use strict";

const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const core = require(path.join(__dirname, "..", "core.js"));

const SETTINGS = Object.freeze({
  listenHost: process.env.PLUS_RELAY_HOST || "127.0.0.1",
  proxyPort: Number(process.env.PLUS_RELAY_PROXY_PORT) || 17897,
  controlPort: Number(process.env.PLUS_RELAY_CONTROL_PORT) || 17898,
  firstHopHost: process.env.PLUS_RELAY_FIRST_HOP_HOST || "127.0.0.1",
  firstHopPort: Number(process.env.PLUS_RELAY_FIRST_HOP_PORT) || 7897,
  connectTimeoutMs: Number(process.env.PLUS_RELAY_TIMEOUT_MS) || 20_000
});

function now() {
  return new Date().toISOString();
}

function log(event, details = {}) {
  process.stdout.write(`${JSON.stringify({ timestamp: now(), event, ...details })}\n`);
}

function statusLine(header) {
  return header.toString("latin1").split("\r\n", 1)[0];
}

function isSuccessfulConnect(header) {
  return /^HTTP\/1\.[01] 200\b/i.test(statusLine(header));
}

function waitForConnect(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("FIRST_HOP_CONNECT_TIMEOUT"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("error", onError);
    };
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

function readHttpHeader(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = socket.__plusRelayRemainder || Buffer.alloc(0);
    socket.__plusRelayRemainder = null;
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("PROXY_RESPONSE_TIMEOUT"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
    };
    const inspect = () => {
      const boundary = buffer.indexOf("\r\n\r\n");
      if (boundary === -1) {
        if (buffer.length > 64 * 1024) {
          cleanup();
          reject(new Error("PROXY_RESPONSE_HEADER_TOO_LARGE"));
        }
        return false;
      }
      cleanup();
      const end = boundary + 4;
      socket.__plusRelayRemainder = buffer.subarray(end);
      resolve(buffer.subarray(0, end));
      return true;
    };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      inspect();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onEnd = () => {
      cleanup();
      reject(new Error("PROXY_CONNECTION_CLOSED"));
    };
    if (inspect()) return;
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
  });
}

function connectRequest(host, port, extraHeaders = {}) {
  const lines = [
    `CONNECT ${host}:${port} HTTP/1.1`,
    `Host: ${host}:${port}`,
    "Proxy-Connection: keep-alive"
  ];
  for (const [name, value] of Object.entries(extraHeaders)) {
    lines.push(`${name}: ${value}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}

const ALLOWED_DIAGNOSTIC_EVENTS = new Set([
  "checkout_response",
  "checkout_existing_session",
  "checkout_baseline",
  "checkout_provider_attempts",
  "checkout_route",
  "checkout_error",
  "checkout_contract",
  "account_promotion_context",
  "payment_methods_preflight",
  "promotion_eligibility",
  "sentinel_checkout",
  "checkout_attempt_state"
]);

function sanitizeDiagnosticEnvelope(body) {
  const source = body && typeof body === "object" ? body : {};
  const event = typeof source.event === "string" && ALLOWED_DIAGNOSTIC_EVENTS.has(source.event)
    ? source.event
    : "checkout_error";
  const details = source.details && typeof source.details === "object" ? source.details : {};
  const output = { name: event };
  for (const key of ["shape", "requestShape", "identifiers", "route", "sessionKind", "promotion", "message"]) {
    if (typeof details[key] === "string" && details[key].trim()) {
      const limit = key === "promotion" ? 2400 : (key === "message" ? 200 : 320);
      output[key] = core.sanitizeDiagnosticText(details[key], limit);
    }
  }
  if (typeof details.httpStatus === "number" && Number.isInteger(details.httpStatus)) {
    output.httpStatus = details.httpStatus;
  }
  return output;
}

function readJsonBody(request, maxBytes = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("REQUEST_BODY_TOO_LARGE"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("INVALID_JSON"));
      }
    });
    request.on("error", reject);
  });
}

function createRelayServers(settings = SETTINGS) {
  let activeProxy = null;
  let shuttingDown = false;
  const tunnelSockets = new Set();

  function trackTunnelSocket(socket) {
    if (!socket || socket.destroyed) return socket;
    tunnelSockets.add(socket);
    socket.once("close", () => tunnelSockets.delete(socket));
    return socket;
  }

  function resetTunnels(reason) {
    let closed = 0;
    for (const socket of tunnelSockets) {
      if (!socket.destroyed) {
        socket.destroy();
        closed += 1;
      }
    }
    tunnelSockets.clear();
    if (closed > 0) log("tunnels_reset", { reason, sockets: closed });
    return closed;
  }

  async function openTunnel(targetHost, targetPort, clientSocket, head) {
    const proxy = activeProxy;
    if (!proxy) {
      clientSocket.end("HTTP/1.1 503 Relay Not Configured\r\nConnection: close\r\n\r\n");
      return;
    }

    trackTunnelSocket(clientSocket);
    const firstHop = trackTunnelSocket(net.createConnection({
      host: settings.firstHopHost,
      port: settings.firstHopPort
    }));
    let streamFailureLogged = false;
    const failStream = (side, error) => {
      if (!streamFailureLogged) {
        streamFailureLogged = true;
        log("tunnel_stream_error", {
          phase: proxy.phase,
          target: `${targetHost}:${targetPort}`,
          side,
          error: core.sanitizeDiagnosticText(error && error.message, 160)
        });
      }
      if (side !== "upstream" && !firstHop.destroyed) firstHop.destroy();
      if (side !== "client" && !clientSocket.destroyed) clientSocket.destroy();
    };
    firstHop.on("error", (error) => failStream("upstream", error));
    clientSocket.on("error", (error) => failStream("client", error));
    firstHop.setNoDelay(true);
    try {
      await waitForConnect(firstHop, settings.connectTimeoutMs);
      firstHop.write(connectRequest(proxy.host, proxy.port));
      const firstResponse = await readHttpHeader(firstHop, settings.connectTimeoutMs);
      if (!isSuccessfulConnect(firstResponse)) {
        throw new Error(`FIRST_HOP_${statusLine(firstResponse).replace(/\s+/g, "_")}`);
      }

      const authorization = Buffer.from(`${proxy.username}:${proxy.password}`, "utf8").toString("base64");
      firstHop.write(connectRequest(targetHost, targetPort, {
        "Proxy-Authorization": `Basic ${authorization}`
      }));
      const secondResponse = await readHttpHeader(firstHop, settings.connectTimeoutMs);
      if (!isSuccessfulConnect(secondResponse)) {
        throw new Error(`UPSTREAM_${statusLine(secondResponse).replace(/\s+/g, "_")}`);
      }

      clientSocket.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: Plus-Extractor-Relay/1.0\r\n\r\n");
      const upstreamRemainder = firstHop.__plusRelayRemainder;
      firstHop.__plusRelayRemainder = null;
      if (upstreamRemainder && upstreamRemainder.length) clientSocket.write(upstreamRemainder);
      if (head && head.length) firstHop.write(head);
      clientSocket.pipe(firstHop);
      firstHop.pipe(clientSocket);
      log("tunnel_ready", {
        phase: proxy.phase,
        target: `${targetHost}:${targetPort}`,
        gateway: core.formatProxyEndpoint(proxy)
      });
    } catch (error) {
      log("tunnel_error", {
        phase: proxy.phase,
        target: `${targetHost}:${targetPort}`,
        error: core.sanitizeDiagnosticText(error && error.message, 160)
      });
      if (!clientSocket.destroyed) {
        clientSocket.end("HTTP/1.1 502 Relay Chain Failed\r\nConnection: close\r\n\r\n");
      }
      firstHop.destroy();
    }
  }

  const proxyServer = http.createServer((request, response) => {
    response.writeHead(501, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("HTTPS CONNECT only");
  });
  proxyServer.on("connect", (request, clientSocket, head) => {
    const separator = request.url.lastIndexOf(":");
    const host = separator > 0 ? request.url.slice(0, separator) : request.url;
    const port = separator > 0 ? Number(request.url.slice(separator + 1)) : 443;
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      clientSocket.end("HTTP/1.1 400 Invalid CONNECT Target\r\nConnection: close\r\n\r\n");
      return;
    }
    void openTunnel(host, port, clientSocket, head);
  });
  proxyServer.on("clientError", (_error, socket) => socket.destroy());

  const controlServer = http.createServer(async (request, response) => {
    const origin = String(request.headers.origin || "");
    if (origin && !origin.startsWith("chrome-extension://")) {
      response.writeHead(403, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: "ORIGIN_NOT_ALLOWED" }));
      return;
    }
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    try {
      if (request.method === "GET" && request.url === "/status") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          ok: true,
          ready: true,
          configured: Boolean(activeProxy),
          phase: activeProxy ? activeProxy.phase : null,
          endpoint: activeProxy ? core.formatProxyEndpoint(activeProxy) : null,
          proxyHost: settings.listenHost,
          proxyPort: settings.proxyPort,
          firstHop: `${settings.firstHopHost}:${settings.firstHopPort}`,
          activeTunnelSockets: tunnelSockets.size
        }));
        return;
      }

      if (request.method === "POST" && request.url === "/configure") {
        const body = await readJsonBody(request);
        const parsed = core.parseProxyLine(body.proxy);
        if (!parsed.username) throw new Error("UPSTREAM_PROXY_CREDENTIALS_REQUIRED");
        const previousPhase = activeProxy ? activeProxy.phase : null;
        const tunnelsReset = resetTunnels("reconfigure");
        activeProxy = {
          phase: body.phase === "apply" ? "apply" : "create",
          scheme: parsed.scheme,
          host: parsed.host,
          port: parsed.port,
          username: parsed.username,
          password: parsed.password
        };
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          ok: true,
          configured: true,
          phase: activeProxy.phase,
          endpoint: core.formatProxyEndpoint(activeProxy),
          proxyHost: settings.listenHost,
          proxyPort: settings.proxyPort,
          previousPhase,
          tunnelsReset
        }));
        log("configured", {
          phase: activeProxy.phase,
          previousPhase,
          endpoint: core.formatProxyEndpoint(activeProxy),
          tunnelsReset
        });
        return;
      }

      if (request.method === "POST" && request.url === "/clear") {
        const tunnelsReset = resetTunnels("clear");
        activeProxy = null;
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true, configured: false, tunnelsReset }));
        log("cleared", { tunnelsReset });
        return;
      }

      if (request.method === "POST" && request.url === "/diagnostic") {
        const diagnostic = sanitizeDiagnosticEnvelope(await readJsonBody(request, 8 * 1024));
        log("extension_diagnostic", diagnostic);
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true, recorded: true, event: diagnostic.name }));
        return;
      }

      if (request.method === "POST" && request.url === "/shutdown") {
        resetTunnels("shutdown");
        activeProxy = null;
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: true, shuttingDown: true }));
        setImmediate(() => shutdown());
        return;
      }

      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: "NOT_FOUND" }));
    } catch (error) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        ok: false,
        error: core.sanitizeDiagnosticText(error && error.message, 160)
      }));
    }
  });

  function listen(server, port) {
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, settings.listenHost, () => {
        server.off("error", reject);
        resolve();
      });
    });
  }

  async function start() {
    await listen(proxyServer, settings.proxyPort);
    try {
      await listen(controlServer, settings.controlPort);
    } catch (error) {
      proxyServer.close();
      throw error;
    }
    log("ready", {
      proxy: `${settings.listenHost}:${settings.proxyPort}`,
      control: `${settings.listenHost}:${settings.controlPort}`,
      firstHop: `${settings.firstHopHost}:${settings.firstHopPort}`
    });
    return { proxyServer, controlServer };
  }

  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    resetTunnels("shutdown");
    activeProxy = null;
    proxyServer.close();
    controlServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  }

  return { start, shutdown, settings };
}

if (require.main === module) {
  const relay = createRelayServers();
  relay.start().catch((error) => {
    log("startup_error", { error: core.sanitizeDiagnosticText(error && error.message, 160) });
    process.exitCode = 1;
  });
  process.on("SIGINT", relay.shutdown);
  process.on("SIGTERM", relay.shutdown);
}

module.exports = {
  createRelayServers,
  SETTINGS,
  isSuccessfulConnect,
  sanitizeDiagnosticEnvelope,
  statusLine
};
