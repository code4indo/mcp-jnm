#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const serverPath = path.join(__dirname, "../dist/server.cjs");
const port = process.env.PORT || "3000";

console.log("🚀 Starting MCP Connection...");
console.log(`🌐 Dashboard running at: http://localhost:${port}`);

const child = spawn("node", [serverPath], {
  stdio: "inherit",
  env: { ...process.env, PORT: port }
});

child.on("exit", (code) => {
  process.exit(code || 0);
});
