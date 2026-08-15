"use strict";

const http = require("node:http");
const { AppError } = require("../lib/errors");
const { openProxyTunnel } = require("../lib/proxy-request");

function parseConnectTarget(authority) {
  const value = String(authority || "").trim();
  let host = "";
  let portText = "";
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end > 1 && value[end + 1] === ":") {
      host = value.slice(1, end);
      portText = value.slice(end + 2);
    }
  } else {
    const separator = value.lastIndexOf(":");
    if (separator > 0) {
      host = value.slice(0, separator);
      portText = value.slice(separator + 1);
    }
  }
  const port = Number(portText);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new AppError(400, "INVALID_CONNECT_TARGET", "Browser requested an invalid CONNECT target.");
  }
  return { host, port };
}

class BrowserProxyRelay {
  constructor(proxy, options = {}) {
    this.proxy = proxy;
    this.host = options.host || "127.0.0.1";
    this.timeoutMs = Number(options.timeoutMs) || 30_000;
    this.tunnelOptions = {
      ...(Object.hasOwn(options, "firstHop") ? { firstHop: options.firstHop } : {}),
      firstHopRequired: options.firstHopRequired !== false
    };
    this.lastTunnelFailure = null;
    this.sockets = new Set();
    this.server = http.createServer((_request, response) => {
      response.writeHead(501, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("HTTPS CONNECT only");
    });
    this.server.on("connect", (request, clientSocket, head) => {
      void this.openTunnel(request.url, clientSocket, head);
    });
    this.server.on("clientError", (_error, socket) => socket.destroy());
  }

  track(socket) {
    if (!socket || socket.destroyed) return socket;
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    // Either side of a CONNECT tunnel may close first.  A late pipe write then
    // emits EPIPE/ECONNRESET; keep that per-tunnel failure from terminating the
    // local API process and let the browser retry the request normally.
    socket.on("error", () => {
      if (!socket.destroyed) socket.destroy();
    });
    return socket;
  }

  async openTunnel(authority, clientSocket, head) {
    this.track(clientSocket);
    let upstream;
    try {
      const target = parseConnectTarget(authority);
      const opened = await openProxyTunnel(target.host, target.port, this.proxy, {
        ...this.tunnelOptions,
        timeoutMs: this.timeoutMs
      });
      this.lastTunnelFailure = null;
      upstream = this.track(opened.socket);
      clientSocket.write("HTTP/1.1 200 Connection Established\r\nProxy-Agent: Plus-Extractor-Local\r\n\r\n");
      const remainder = upstream.__localWebRemainder;
      upstream.__localWebRemainder = null;
      if (remainder && remainder.length) clientSocket.write(remainder);
      if (head && head.length) upstream.write(head);
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
      upstream.resume();
    } catch (error) {
      const statusMatch = String(error && error.message || "").match(/HTTP\s+(\d{3})/i);
      this.lastTunnelFailure = Object.freeze({
        code: String(error && error.code || "PROXY_TUNNEL_FAILED").slice(0, 80),
        status: Number(error && error.status) || 502,
        upstreamStatus: statusMatch ? Number(statusMatch[1]) : null,
        atMs: Date.now()
      });
      if (!clientSocket.destroyed) {
        clientSocket.end("HTTP/1.1 502 Proxy Chain Failed\r\nConnection: close\r\n\r\n");
      }
      if (upstream && !upstream.destroyed) upstream.destroy();
    }
  }

  async start() {
    if (this.server.listening) return this.url();
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        resolve();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(0, this.host);
    });
    return this.url();
  }

  url() {
    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new AppError(503, "BROWSER_PROXY_NOT_READY", "Browser proxy relay is not listening.");
    }
    return `http://${this.host}:${address.port}`;
  }

  reconfigure(proxy) {
    if (!proxy || typeof proxy !== "object") {
      throw new AppError(400, "BROWSER_PROXY_REQUIRED", "A configured proxy is required.");
    }
    const previous = this.proxy;
    this.proxy = proxy;
    this.lastTunnelFailure = null;
    const socketsReset = this.sockets.size;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    return Object.freeze({ previous, current: proxy, socketsReset });
  }

  getLastTunnelFailure() {
    return this.lastTunnelFailure;
  }

  async close() {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (!this.server.listening) return;
    await new Promise((resolve) => this.server.close(resolve));
  }
}

module.exports = { BrowserProxyRelay, parseConnectTarget };
