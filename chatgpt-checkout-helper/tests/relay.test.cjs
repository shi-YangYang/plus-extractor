const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const {
  createRelayServers,
  isSuccessfulConnect,
  sanitizeDiagnosticEnvelope,
  statusLine
} = require("../relay/local-relay.js");

function readHeader(socket) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const boundary = buffer.indexOf("\r\n\r\n");
      if (boundary === -1) return;
      cleanup();
      const end = boundary + 4;
      resolve({ header: buffer.subarray(0, end), rest: buffer.subarray(end) });
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
    };
    socket.on("data", onData);
    socket.once("error", onError);
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function postJson(port, path, body) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path,
      method: "POST",
      headers: { "Content-Type": "application/json" }
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
    });
    request.on("error", reject);
    request.end(JSON.stringify(body));
  });
}

test("relay recognizes successful CONNECT responses", () => {
  const header = Buffer.from("HTTP/1.1 200 Connection established\r\n\r\n");
  assert.equal(isSuccessfulConnect(header), true);
  assert.equal(statusLine(header), "HTTP/1.1 200 Connection established");
  assert.equal(isSuccessfulConnect(Buffer.from("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n")), false);
});

test("relay diagnostics keep response shape and redact values", () => {
  const diagnostic = sanitizeDiagnosticEnvelope({
    event: "checkout_response",
    details: {
      shape: "checkout_session_id:string(64), publishable_key:string(107)",
      requestShape: "plan_name,billing_details,promo_campaign",
      promotion: "{\"promo_campaign\":{\"eligible\":false}}",
      message: "Bearer secret-token user:pass@gateway.example:1000",
      ignored: "raw checkout response"
    }
  });
  assert.deepEqual(diagnostic, {
    name: "checkout_response",
    shape: "checkout_session_id:string(64), publishable_key:string(107)",
    requestShape: "plan_name,billing_details,promo_campaign",
    promotion: "{\"promo_campaign\":{\"eligible\":false}}",
    message: "Bearer [已脱敏] [代理凭据已脱敏]"
  });
  assert.doesNotMatch(JSON.stringify(diagnostic), /secret-token|user:pass|raw checkout response/);
});

test("relay performs two CONNECT hops before exposing the tunnel", async (t) => {
  let firstConnect = "";
  let secondConnect = "";
  const mockFirstHop = net.createServer(async (socket) => {
    const first = await readHeader(socket);
    firstConnect = first.header.toString("latin1");
    socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
    const second = await readHeader(socket);
    secondConnect = second.header.toString("latin1");
    socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
    socket.on("data", (chunk) => socket.write(chunk));
  });
  const firstHopPort = await listen(mockFirstHop);
  const relay = createRelayServers({
    listenHost: "127.0.0.1",
    proxyPort: 0,
    controlPort: 0,
    firstHopHost: "127.0.0.1",
    firstHopPort,
    connectTimeoutMs: 2000
  });
  const { proxyServer, controlServer } = await relay.start();
  const proxyPort = proxyServer.address().port;
  const controlPort = controlServer.address().port;

  t.after(async () => {
    await Promise.all([close(proxyServer), close(controlServer), close(mockFirstHop)]);
  });
  const configured = await postJson(controlPort, "/configure", {
    phase: "create",
    proxy: "user:pass@gateway.example:1000"
  });
  assert.equal(configured.ok, true);

  const client = net.createConnection({ host: "127.0.0.1", port: proxyPort });
  await new Promise((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });
  client.write("CONNECT target.example:443 HTTP/1.1\r\nHost: target.example:443\r\n\r\n");
  const response = await readHeader(client);
  assert.match(response.header.toString("latin1"), /^HTTP\/1\.1 200/);

  const echoed = new Promise((resolve) => client.once("data", resolve));
  client.write("PING");
  assert.equal((await echoed).toString("utf8"), "PING");
  client.destroy();

  assert.match(firstConnect, /^CONNECT gateway\.example:1000 HTTP\/1\.1/m);
  assert.match(secondConnect, /^CONNECT target\.example:443 HTTP\/1\.1/m);
  assert.match(secondConnect, /Proxy-Authorization: Basic dXNlcjpwYXNz/);
  assert.doesNotMatch(firstConnect, /user|pass/);
});

test("relay destroys existing CONNECT tunnels when switching proxy phases", async (t) => {
  const upstreamAuthorizations = [];
  const mockFirstHop = net.createServer(async (socket) => {
    try {
      await readHeader(socket);
      socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
      const second = await readHeader(socket);
      const text = second.header.toString("latin1");
      upstreamAuthorizations.push(text.match(/Proxy-Authorization:\s*Basic\s+([^\r\n]+)/i)?.[1] || "");
      socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
      socket.on("data", (chunk) => socket.write(chunk));
    } catch {
      socket.destroy();
    }
  });
  const firstHopPort = await listen(mockFirstHop);
  const relay = createRelayServers({
    listenHost: "127.0.0.1",
    proxyPort: 0,
    controlPort: 0,
    firstHopHost: "127.0.0.1",
    firstHopPort,
    connectTimeoutMs: 2000
  });
  const { proxyServer, controlServer } = await relay.start();
  const proxyPort = proxyServer.address().port;
  const controlPort = controlServer.address().port;

  t.after(async () => {
    await Promise.all([close(proxyServer), close(controlServer), close(mockFirstHop)]);
  });

  async function connectClient(host) {
    const client = net.createConnection({ host: "127.0.0.1", port: proxyPort });
    await new Promise((resolve, reject) => {
      client.once("connect", resolve);
      client.once("error", reject);
    });
    client.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
    const response = await readHeader(client);
    assert.match(response.header.toString("latin1"), /^HTTP\/1\.1 200/);
    return client;
  }

  await postJson(controlPort, "/configure", {
    phase: "create",
    proxy: "user:pass-US@gateway.example:1000"
  });
  const createClient = await connectClient("create.example");
  const createClosed = new Promise((resolve) => createClient.once("close", resolve));

  const reconfigured = await postJson(controlPort, "/configure", {
    phase: "apply",
    proxy: "user:pass-TR@gateway.example:1000"
  });
  assert.equal(reconfigured.previousPhase, "create");
  assert.ok(reconfigured.tunnelsReset >= 2);
  await createClosed;

  const applyClient = await connectClient("apply.example");
  applyClient.destroy();

  assert.deepEqual(upstreamAuthorizations, [
    Buffer.from("user:pass-US").toString("base64"),
    Buffer.from("user:pass-TR").toString("base64")
  ]);
});

test("macOS relay scripts install and control the launchd service", () => {
  const relayDirectory = path.resolve(__dirname, "..", "relay");
  const install = fs.readFileSync(path.join(relayDirectory, "install-relay.sh"), "utf8");
  const start = fs.readFileSync(path.join(relayDirectory, "start-relay.sh"), "utf8");
  const stop = fs.readFileSync(path.join(relayDirectory, "stop-relay.sh"), "utf8");
  const uninstall = fs.readFileSync(path.join(relayDirectory, "uninstall-relay.sh"), "utf8");

  assert.match(install, /^#!\/usr\/bin\/env bash/);
  assert.match(install, /com\.plus-extractor\.relay/);
  assert.match(install, /launchctl bootstrap/);
  assert.match(install, /launchctl kickstart -k/);
  assert.match(install, /127\.0\.0\.1:17898\/status/);
  assert.match(start, /RELAY_ALREADY_RUNNING/);
  assert.match(stop, /launchctl bootout/);
  assert.match(stop, /17898\/shutdown/);
  assert.match(uninstall, /rm -f "\$PLIST"/);
});
