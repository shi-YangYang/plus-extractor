"use strict";

const { createApplication } = require("./app");

const host = process.env.LOCAL_API_HOST || "127.0.0.1";
const port = Number(process.env.LOCAL_API_PORT) || 17890;

async function main() {
  const application = await createApplication();
  const server = application.createServer();
  server.listen(port, host, () => {
    console.log(`[local-api] http://${host}:${port}`);
    console.log(`[local-api] health http://${host}:${port}/api/health`);
  });

  const shutdown = () => server.close(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("[local-api] startup failed", error);
  process.exitCode = 1;
});
