"use strict";

const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const children = [
  spawn(process.execPath, [path.join(root, "server/index.js")], { cwd: root, stdio: "inherit" }),
  spawn(process.execPath, [path.join(root, "scripts/serve-web.js")], { cwd: root, stdio: "inherit" })
];

let stopping = false;
function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(exitCode), 150).unref();
}

for (const child of children) {
  child.once("exit", (code, signal) => {
    if (!stopping) {
      console.error(`[dev] child stopped (${signal || code})`);
      stop(Number(code) || 1);
    }
  });
  child.once("error", (error) => {
    console.error("[dev] child failed", error);
    stop(1);
  });
}

process.once("SIGINT", () => stop(0));
process.once("SIGTERM", () => stop(0));
