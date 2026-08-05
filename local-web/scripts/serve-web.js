"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const webRoot = path.resolve(__dirname, "../web");
const host = process.env.LOCAL_WEB_HOST || "127.0.0.1";
const port = Number(process.env.LOCAL_WEB_PORT) || 17891;
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function createStaticServer() {
  return http.createServer((request, response) => {
    const requestPath = decodeURIComponent(String(request.url || "/").split("?")[0]);
    if (requestPath === "/healthz") {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      response.end(JSON.stringify({ ok: true, service: "plus-extractor-web" }));
      return;
    }

    const relative = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
    const filePath = path.resolve(webRoot, relative);
    if (filePath !== webRoot && !filePath.startsWith(`${webRoot}${path.sep}`)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }
    fs.readFile(filePath, (error, data) => {
      if (error) {
        response.writeHead(error.code === "ENOENT" ? 404 : 500);
        response.end(error.code === "ENOENT" ? "Not Found" : "Server Error");
        return;
      }
      response.writeHead(200, {
        "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      });
      response.end(data);
    });
  });
}

if (require.main === module) {
  const server = createStaticServer();
  server.listen(port, host, () => console.log(`[local-web] http://${host}:${port}`));
  const shutdown = () => server.close(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

module.exports = { createStaticServer };
