import { mkdirSync } from "node:fs";
import { loadConfig, ConfigError } from "./config.ts";
import { Logger, logLevelFromEnv, errorMessage } from "./logger.ts";
import { PostgresRunStore } from "./store/postgres.ts";
import { GitHubIssuesBacklog } from "./backlog/github.ts";
import { OpencodeRuntime } from "./runtime/opencode.ts";
import { GitWorkspace } from "./scm/git.ts";
import { GitHubDelivery, LocalDelivery } from "./scm/github.ts";
import { Workflow } from "./workflow.ts";
import { Orchestrator } from "./orchestrator.ts";
import { startApi } from "./api.ts";
import { retry } from "./util.ts";

const logger = new Logger({ service: "software-factory" }, logLevelFromEnv(process.env.LOG_LEVEL));

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  mkdirSync(config.dataDir, { recursive: true });

  const log = logger.child({
    delivery: config.deliveryMode,
    model: config.opencode.model
      ? `${config.opencode.model.providerID}/${config.opencode.model.id}`
      : "opencode-default",
  });

  const store = new PostgresRunStore(config.databaseUrl, logger);
  await retry(20, 2_000, "database migration", () => store.migrate());

  const runtime = new OpencodeRuntime(config.opencode, logger);
  await waitForOpencode(runtime, config.opencode.startupTimeoutMs, logger);
  await retry(10, 2_000, "opencode agent discovery", () =>
    runtime.verifyAgents(
      [
        "factory-planner",
        "factory-builder",
        "factory-qa",
        "factory-reviewer",
        "factory-feedback-triage",
      ],
      config.dataDir,
    ),
  );
  if (config.opencode.model) {
    await retry(10, 2_000, "model verification", () =>
      runtime.verifyModel(config.opencode.model!),
    );
  }

  const backlog = new GitHubIssuesBacklog(config.github, logger);
  await retry(5, 3_000, "GitHub Issues validation", () => backlog.validate());

  const workspace = new GitWorkspace(config, logger);

  const githubDelivery =
    config.deliveryMode === "github"
      ? new GitHubDelivery(config.github, logger)
      : null;
  const delivery = githubDelivery ?? new LocalDelivery();

  const workflow = new Workflow({
    config,
    store,
    backlog,
    runtime,
    workspace,
    delivery,
    feedback: githubDelivery,
    logger,
  });
  const orchestrator = new Orchestrator(
    config,
    store,
    backlog,
    workflow,
    githubDelivery,
    githubDelivery,
    logger,
  );

  const server = startApi({ config, store, orchestrator, runtime, backlog, logger });
  runtime.start();
  orchestrator.start();

  log.info("software factory started", {
    port: config.port,
    labels: config.github.labels,
    api: `http://localhost:${config.port}`,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down", { signal });
    await orchestrator.stop();
    runtime.stop();
    server.stop(true);
    await store.close();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    log.error("unhandled rejection", { error: errorMessage(reason) });
  });
}

async function waitForOpencode(
  runtime: OpencodeRuntime,
  timeoutMs: number,
  logger: Logger,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await runtime.health();
      logger.info("OpenCode server is ready");
      return;
    } catch (error) {
      lastError = error;
      await Bun.sleep(2_000);
    }
  }
  throw new Error(
    `OpenCode server was not ready after ${Math.round(timeoutMs / 1000)}s: ${errorMessage(lastError)}`,
  );
}

main().catch((error) => {
  logger.error("fatal startup error", {
    error: errorMessage(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});
