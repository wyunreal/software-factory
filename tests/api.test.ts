import { describe, expect, test } from "bun:test";
import { startApi, type ApiDependencies } from "../src/api.ts";
import type { FactoryConfig } from "../src/config.ts";
import type { GitHubIssuesBacklog } from "../src/backlog/github.ts";
import { MemoryRunStore } from "../src/store/memory.ts";
import { Logger } from "../src/logger.ts";
import type { Orchestrator } from "../src/orchestrator.ts";
import type { Ticket } from "../src/domain/types.ts";

function makeConfig(port: number): FactoryConfig {
  return {
    port,
    apiToken: null,
    dataDir: "/tmp/software-factory-api-test",
    pollIntervalMs: 1000,
    workerIntervalMs: 1000,
    stepTimeoutMs: 5000,
    testTimeoutMs: 5000,
    maxRework: 3,
    testCommand: "bun test",
    setupCommand: null,
    deliveryMode: "local",
    autoMerge: false,
    mergeMethod: "squash",
    reworkOnChangesRequested: true,
    triagePrComments: true,
    feedbackUsers: [],
    databaseUrl: "postgres://localhost/test",
    opencode: {
      url: "http://localhost:4096",
      username: "opencode",
      password: "secret",
      model: null,
      autoApprovePermissions: true,
      startupTimeoutMs: 1000,
    },
    github: {
      token: "token",
      apiUrl: "https://api.github.com",
      draft: false,
      labels: {
        inProgress: "factory:in-progress",
        inReview: "factory:in-review",
        blocked: "factory:blocked",
        ready: null,
        skip: ["factory:skip"],
      },
    },
    git: {
      authorName: "Factory",
      authorEmail: "factory@example.com",
      token: "token",
    },
  };
}

function makeTicket(): Ticket {
  return {
    cardId: "1001",
    number: 7,
    ref: "GH-7",
    title: "Test issue",
    description: "Do it",
    url: "https://github.com/acme/app/issues/7",
    labels: [],
    acceptanceCriteria: ["It works"],
    repo: "acme/app",
    repoUrl: "https://github.com/acme/app.git",
  };
}

function setup(port: number) {
  const store = new MemoryRunStore();
  const backlog = {
    getTicket: async () => makeTicket(),
    claim: async () => undefined,
  } as unknown as GitHubIssuesBacklog;
  const orchestrator = {
    workOnce: async () => undefined,
    status: () => ({}),
    syncNow: async () => undefined,  } as unknown as Orchestrator;
  const runtime = { health: async () => undefined } as unknown as ApiDependencies["runtime"];

  const server = startApi({
    config: makeConfig(port),
    store,
    orchestrator,
    runtime,
    backlog,
    logger: new Logger({}, "error"),
  });
  return { server, store };
}

describe("POST /api/runs", () => {
  test("creates a run from repo + issue URL", async () => {
    const port = 19100 + Math.floor(Math.random() * 500);
    const { server, store } = setup(port);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repoUrl: "https://github.com/acme/app",
          issueUrl: "https://github.com/acme/app/issues/7",
          baseBranch: "main",
        }),
      });
      expect(response.status).toBe(201);
      const body = (await response.json()) as { data: { id: string } };
      const run = await store.getRun(body.data.id);
      expect(run?.repoUrl).toBe("https://github.com/acme/app.git");
      expect(run?.ticket.repo).toBe("acme/app");
      expect(run?.state).toBe("CLAIMED");
    } finally {
      server.stop(true);
    }
  });

  test("rejects a repo that does not match the issue", async () => {
    const port = 19650 + Math.floor(Math.random() * 300);
    const { server } = setup(port);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/runs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repoUrl: "https://github.com/acme/other",
          issueUrl: "https://github.com/acme/app/issues/7",
        }),
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("mismatch");
    } finally {
      server.stop(true);
    }
  });
});
