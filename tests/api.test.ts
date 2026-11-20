import { describe, expect, test } from "vitest";
import { startApi, type ApiDependencies } from "../src/api.ts";
import type { FactoryConfig } from "../src/config.ts";
import type { GitHubIssuesBacklog } from "../src/backlog/github.ts";
import { MemoryRunStore } from "../src/store/memory.ts";
import { Logger } from "../src/logger.ts";
import type { TriggerWatcher } from "../src/trigger-watcher.ts";
import type { RunWorker } from "../src/run-worker.ts";
import type { Ticket } from "../src/domain/types.ts";

function makeConfig(port: number): FactoryConfig {
  return {
    port,
    apiToken: "test-api-token-123456",
    dataDir: "/tmp/software-factory-api-test",
    pollIntervalMs: 1000,
    prPolling: false,
    workerIntervalMs: 1000,
    stepTimeoutMs: 5000,
    testTimeoutMs: 5000,
    maxRework: 3,
    testCommand: "npm test",
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
      appId: "123456",
      privateKey: "test-key",
      slug: "software-factory-test",
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

async function setup(port: number, options: { installationId?: number | null } = {}) {
  const store = new MemoryRunStore();
  const backlog = {
    getTicket: async () => makeTicket(),
    claim: async () => undefined,
  } as unknown as GitHubIssuesBacklog;
  const watcher = {
    syncNow: async () => undefined,
    status: () => ({}),
  } as unknown as TriggerWatcher;
  const worker = {
    workOnce: async () => undefined,
    status: () => ({}),
  } as unknown as RunWorker;
  const runtime = { health: async () => undefined } as unknown as ApiDependencies["runtime"];
  const githubAuth = {
    validate: async () => undefined,
    installationIdForRepository: async () =>
      "installationId" in options ? (options.installationId ?? null) : 1,
    tokenForRepository: async () => "test-token",
  } as unknown as ApiDependencies["githubAuth"];

  const server = await startApi({
    config: makeConfig(port),
    store,
    githubAuth,
    watcher,
    worker,
    runtime,
    backlog,
    logger: new Logger({}, "error"),
  });
  return { server, store };
}

const TOKEN = "test-api-token-123456";
const USER_A = "usr_test_a";
const USER_B = "usr_test_b";
const AUTH_HEADERS = {
  authorization: `Bearer ${TOKEN}`,
  "content-type": "application/json",
  "x-factory-user-id": USER_A,
};

function headersFor(userId: string): Record<string, string> {
  return { ...AUTH_HEADERS, "x-factory-user-id": userId };
}

async function createProject(
  store: MemoryRunStore,
  userId: string,
  name = "Acme app",
  repo = "acme/app",
) {
  const project = await store.createProject({
    ownerUserId: userId,
    name,
    repo,
    repoUrl: `https://github.com/${repo}.git`,
  });
  if (!project) throw new Error("project was not created");
  return project;
}

async function humanReviewRun(store: MemoryRunStore, projectId: string) {
  const run = await store.createRun(makeTicket(), {
    ownerUserId: USER_A,
    projectId,
    repoUrl: "https://github.com/acme/app.git",
    baseBranch: "main",
  });
  if (!run) throw new Error("run was not created");
  for (const state of [
    "PLANNING",
    "PLANNED",
    "BUILDING",
    "QA",
    "TESTING",
    "REVIEWING",
    "DELIVERY",
    "HUMAN_REVIEW",
  ] as const) {
    await store.transition(run.id, state, {
      ...(state === "HUMAN_REVIEW"
        ? { prUrl: "https://github.com/acme/app/pull/42" }
        : {}),
    });
  }
  return run;
}

describe("API authentication", () => {
  test("rejects requests without a bearer token", async () => {
    const port = 19000 + Math.floor(Math.random() * 300);
    const { server } = await setup(port);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/runs`);
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
    } finally {
      server.stop(true);
    }
  });

  test("rejects a wrong token even on public-looking routes", async () => {
    const port = 19400 + Math.floor(Math.random() * 200);
    const { server } = await setup(port);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { authorization: "Bearer wrong-token-wrong-token" },
      });
      expect(response.status).toBe(401);
    } finally {
      server.stop(true);
    }
  });

  test("accepts the configured token on health and root", async () => {
    const port = 19800 + Math.floor(Math.random() * 150);
    const { server } = await setup(port);
    try {
      const headers = { authorization: `Bearer ${TOKEN}` };
      const health = await fetch(`http://127.0.0.1:${port}/health`, { headers });
      expect(health.status).toBe(200);

      const root = await fetch(`http://127.0.0.1:${port}/`, { headers });
      expect(root.status).toBe(200);
    } finally {
      server.stop(true);
    }
  });

  test("requires a user context for run data", async () => {
    const port = 19200 + Math.floor(Math.random() * 150);
    const { server } = await setup(port);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/runs`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("user");
    } finally {
      server.stop(true);
    }
  });
});

describe("projects", () => {
  test("returns 428 until the GitHub App is installed", async () => {
    const port = 18300 + Math.floor(Math.random() * 90);
    const { server } = await setup(port, { installationId: null });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/projects`, {
        method: "POST",
        headers: headersFor(USER_A),
        body: JSON.stringify({
          name: "Acme app",
          repoUrl: "https://github.com/acme/app",
        }),
      });
      expect(response.status).toBe(428);
      const body = (await response.json()) as { code: string; repo: string };
      expect(body.code).toBe("github_app_not_installed");
      expect(body.repo).toBe("acme/app");
    } finally {
      server.stop(true);
    }
  });

  test("creates the project after the installation callback", async () => {
    const port = 18400 + Math.floor(Math.random() * 90);
    const { server } = await setup(port);
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/api/github/installations`,
        {
          method: "POST",
          headers: headersFor(USER_A),
          body: JSON.stringify({
            installationId: 1,
            name: "Acme app",
            repoUrl: "https://github.com/acme/app",
          }),
        },
      );
      expect(response.status).toBe(201);
      const body = (await response.json()) as {
        data: { repo: string; ownerUserId: string };
      };
      expect(body.data.repo).toBe("acme/app");
      expect(body.data.ownerUserId).toBe(USER_A);
    } finally {
      server.stop(true);
    }
  });

  test("creates projects per user and lists only the owner's projects", async () => {
    const port = 18900 + Math.floor(Math.random() * 90);
    const { server } = await setup(port);
    try {
      const created = await fetch(`http://127.0.0.1:${port}/api/projects`, {
        method: "POST",
        headers: headersFor(USER_A),
        body: JSON.stringify({
          name: "Acme app",
          repoUrl: "https://github.com/acme/app",
        }),
      });
      expect(created.status).toBe(201);
      const body = (await created.json()) as {
        data: { id: string; repo: string; ownerUserId: string };
      };
      expect(body.data.repo).toBe("acme/app");
      expect(body.data.ownerUserId).toBe(USER_A);

      const duplicate = await fetch(`http://127.0.0.1:${port}/api/projects`, {
        method: "POST",
        headers: headersFor(USER_A),
        body: JSON.stringify({
          name: "Another name",
          repoUrl: "https://github.com/acme/app",
        }),
      });
      expect(duplicate.status).toBe(409);

      const own = await fetch(`http://127.0.0.1:${port}/api/projects`, {
        headers: headersFor(USER_A),
      });
      const ownBody = (await own.json()) as { data: { id: string }[] };
      expect(ownBody.data.map((project) => project.id)).toEqual([
        body.data.id,
      ]);

      const other = await fetch(`http://127.0.0.1:${port}/api/projects`, {
        headers: headersFor(USER_B),
      });
      const otherBody = (await other.json()) as { data: { id: string }[] };
      expect(otherBody.data).toEqual([]);
    } finally {
      server.stop(true);
    }
  });
});

describe("GitHub events", () => {
  test("enqueues a pr_sync for a run matching the webhook PR", async () => {
    const port = 18700 + Math.floor(Math.random() * 90);
    const { server, store } = await setup(port);
    try {
      const project = await createProject(store, USER_A);
      const run = await humanReviewRun(store, project.id);

      const response = await fetch(
        `http://127.0.0.1:${port}/api/github/events`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${TOKEN}`,
            "content-type": "application/json",
            "x-github-event": "pull_request",
            "x-github-delivery": "delivery-1",
          },
          body: JSON.stringify({
            action: "synchronize",
            repository: { full_name: "acme/app" },
            pull_request: { number: 42 },
          }),
        },
      );
      expect(response.status).toBe(202);
      const body = (await response.json()) as { enqueued: number };
      expect(body.enqueued).toBe(1);

      const job = await store.claimNextJob();
      expect(job?.kind).toBe("pr_sync");
      expect(job?.runId).toBe(run.id);
      expect(job?.prNumber).toBe(42);
    } finally {
      server.stop(true);
    }
  });

  test("ignores events with no matching run or unsupported kind", async () => {
    const port = 18500 + Math.floor(Math.random() * 90);
    const { server } = await setup(port);
    try {
      const unsupported = await fetch(
        `http://127.0.0.1:${port}/api/github/events`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${TOKEN}`,
            "content-type": "application/json",
            "x-github-event": "push",
            "x-github-delivery": "delivery-2",
          },
          body: JSON.stringify({ repository: { full_name: "acme/app" } }),
        },
      );
      expect(unsupported.status).toBe(202);
      const body = (await unsupported.json()) as { ignored: boolean };
      expect(body.ignored).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});

describe("POST /api/runs", () => {
  test("creates a run from a project + issue URL", async () => {
    const port = 19100 + Math.floor(Math.random() * 500);
    const { server, store } = await setup(port);
    try {
      const project = await createProject(store, USER_A);
      const response = await fetch(`http://127.0.0.1:${port}/api/runs`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          projectId: project.id,
          issueUrl: "https://github.com/acme/app/issues/7",
          baseBranch: "main",
        }),
      });
      expect(response.status).toBe(201);
      const body = (await response.json()) as { data: { id: string } };
      const run = await store.getRun(body.data.id);
      expect(run?.repoUrl).toBe("https://github.com/acme/app.git");
      expect(run?.ticket.repo).toBe("acme/app");
      expect(run?.projectId).toBe(project.id);
      expect(run?.state).toBe("CLAIMED");

      const job = await store.claimNextJob();
      expect(job?.kind).toBe("start_issue");
      expect(job?.runId).toBe(run?.id);
    } finally {
      server.stop(true);
    }
  });

  test("rejects an issue that does not belong to the project", async () => {
    const port = 19650 + Math.floor(Math.random() * 300);
    const { server, store } = await setup(port);
    try {
      const project = await createProject(store, USER_A);
      const response = await fetch(`http://127.0.0.1:${port}/api/runs`, {
        method: "POST",
        headers: AUTH_HEADERS,
        body: JSON.stringify({
          projectId: project.id,
          issueUrl: "https://github.com/acme/other/issues/7",
        }),
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("not to project repository");
    } finally {
      server.stop(true);
    }
  });
});

describe("per-user isolation", () => {
  test("does not expose one user's runs to another", async () => {
    const port = 19900 + Math.floor(Math.random() * 80);
    const { server, store } = await setup(port);
    try {
      const project = await createProject(store, USER_A);
      const created = await fetch(`http://127.0.0.1:${port}/api/runs`, {
        method: "POST",
        headers: headersFor(USER_A),
        body: JSON.stringify({
          projectId: project.id,
          issueUrl: "https://github.com/acme/app/issues/7",
        }),
      });
      expect(created.status).toBe(201);
      const body = (await created.json()) as { data: { id: string } };
      const run = await store.getRun(body.data.id);
      expect(run?.ownerUserId).toBe(USER_A);

      const ownList = await fetch(`http://127.0.0.1:${port}/api/runs`, {
        headers: headersFor(USER_A),
      });
      const own = (await ownList.json()) as { data: { id: string }[] };
      expect(own.data.map((item) => item.id)).toEqual([body.data.id]);

      const otherList = await fetch(`http://127.0.0.1:${port}/api/runs`, {
        headers: headersFor(USER_B),
      });
      const other = (await otherList.json()) as { data: { id: string }[] };
      expect(other.data).toEqual([]);

      const otherRun = await fetch(
        `http://127.0.0.1:${port}/api/runs/${encodeURIComponent(body.data.id)}`,
        { headers: headersFor(USER_B) },
      );
      expect(otherRun.status).toBe(404);

      const ownRun = await fetch(
        `http://127.0.0.1:${port}/api/runs/${encodeURIComponent(body.data.id)}`,
        { headers: headersFor(USER_A) },
      );
      expect(ownRun.status).toBe(200);
    } finally {
      server.stop(true);
    }
  });

  test("allows two users to have active runs for the same issue", async () => {
    const port = 19990 - Math.floor(Math.random() * 60);
    const { server, store } = await setup(port);
    try {
      const projectA = await createProject(store, USER_A);
      const projectB = await createProject(store, USER_B);
      const payload = (projectId: string) =>
        JSON.stringify({
          projectId,
          issueUrl: "https://github.com/acme/app/issues/7",
        });

      const first = await fetch(`http://127.0.0.1:${port}/api/runs`, {
        method: "POST",
        headers: headersFor(USER_A),
        body: payload(projectA.id),
      });
      expect(first.status).toBe(201);

      const duplicate = await fetch(`http://127.0.0.1:${port}/api/runs`, {
        method: "POST",
        headers: headersFor(USER_A),
        body: payload(projectA.id),
      });
      expect(duplicate.status).toBe(409);

      const second = await fetch(`http://127.0.0.1:${port}/api/runs`, {
        method: "POST",
        headers: headersFor(USER_B),
        body: payload(projectB.id),
      });
      expect(second.status).toBe(201);
    } finally {
      server.stop(true);
    }
  });
});
