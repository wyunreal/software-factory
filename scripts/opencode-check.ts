import { OpencodeRuntime } from "../src/runtime/opencode.ts";
import { Logger } from "../src/logger.ts";
import { mkdirSync } from "node:fs";

const logger = new Logger({ script: "opencode-check" }, "info");
const dataDir = process.env.FACTORY_DATA_DIR ?? "/data";
mkdirSync(dataDir, { recursive: true });

const url = process.env.FACTORY_OPENCODE_URL?.trim();
const password = process.env.OPENCODE_SERVER_PASSWORD?.trim();
if (!url) {
  console.error(
    "FACTORY_OPENCODE_URL is required. Inside docker compose it is set to http://opencode:4096. " +
      "This check never falls back to your local OpenCode runtime.",
  );
  process.exit(1);
}
if (!password) {
  console.error("OPENCODE_SERVER_PASSWORD is required");
  process.exit(1);
}

console.log(`Checking isolated Factory runtime at ${url}`);

const runtime = new OpencodeRuntime(
  {
    url: url.replace(/\/+$/, ""),
    username: process.env.OPENCODE_SERVER_USERNAME ?? "opencode",
    password,
    model: null,
    autoApprovePermissions: true,
    startupTimeoutMs: 30_000,
  },
  logger,
);

try {
  await runtime.health();
  await runtime.verifyAgents(
    ["factory-planner", "factory-builder", "factory-qa", "factory-reviewer"],
    dataDir,
  );
  console.log("\nOpenCode runtime OK. Agents are registered.");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
