import { describe, expect, test } from "bun:test";
import type { FactoryConfig } from "../src/config.ts";
import type {
  AgentRuntimePort,
  AgentRunRequest,
  BacklogPort,
  DeliveryPort,
  WorkspacePort,
} from "../src/ports.ts";
import type {
  AgentRunResult,
  CommitResult,
  Run,
  TestResult,
  Ticket,
} from "../src/domain/types.ts";
import { MemoryRunStore } from "../src/store/memory.ts";
import { Workflow, parseVerdict } from "../src/workflow.ts";
import { Logger } from "../src/logger.ts";

const TICKET: Ticket = {
  cardId: "card-1",
  ref: "GH-1",
  title: "Add login",
  description: "Implement login",
  url: "https://github.com/acme/app/issues/1",
  labels: [],
  acceptanceCriteria: ["Users can log in", "Invalid credentials are rejected"],
  number: 1,
  repo: "acme/app",
  repoUrl: "https://github.com/acme/app.git",
};

function makeConfig(overrides: Partial<FactoryConfig> = {}): FactoryConfig {
  return {
    port: 3000,
    apiToken: null,
    dataDir: "/tmp/software-factory-test",
    pollIntervalMs: 1000,
    workerIntervalMs: 1000,
    stepTimeoutMs: 5000,
    testTimeoutMs: 5000,
    maxRework: 3,
    testCommand: "bun test",
    setupCommand: null,
    deliveryMode: "github",
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
    ...overrides,
  };
}

class FakeBacklog implements BacklogPort {
  comments: string[] = [];
  claimed: string[] = [];
  movedToReview: string[] = [];
  movedToBlocked: string[] = [];
  done = false;

  async validate(): Promise<void> {}
  async claim(ticket: Ticket): Promise<void> {
    this.claimed.push(ticket.cardId);
  }
  async moveToInProgress(ticket: Ticket): Promise<void> {
    this.claimed.push(ticket.cardId);
  }
  async comment(_ticket: Ticket, text: string): Promise<void> {
    this.comments.push(text);
  }
  async moveToReview(): Promise<void> {
    this.movedToReview.push("1");
  }
  async moveToBlocked(): Promise<void> {
    this.movedToBlocked.push("1");
  }
  async isDone(): Promise<boolean> {
    return this.done;
  }
}

class FakeRuntime implements AgentRuntimePort {
  calls: AgentRunRequest[] = [];

  constructor(private readonly responses: Record<string, string[]> = {}) {}

  async run(request: AgentRunRequest): Promise<AgentRunResult> {
    this.calls.push(request);
    const text = this.responses[request.agent]?.shift() ?? "agent output";
    return {
      sessionId: "ses_test",
      text,
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0 },
    };
  }
}

class FakeWorkspace implements WorkspacePort {
  commits: string[] = [];
  pushes = 0;
  testResults: TestResult[] = [];
  commitResults: CommitResult[] = [];

  async prepare(): Promise<{
    directory: string;
    branch: string;
    setupCommand: string | null;
    testCommand: string | null;
  }> {
    return {
      directory: "/tmp/software-factory-test/worktree",
      branch: "factory/x",
      setupCommand: null,
      testCommand: "bun test",
    };
  }

  async commit(_run: Run, message: string): Promise<CommitResult> {
    this.commits.push(message);
    return this.commitResults.shift() ?? { changed: true, sha: "abc" };
  }

  async diffStat(): Promise<string> {
    return "src/login.ts | 10 +++++";
  }

  async runTests(): Promise<TestResult> {
    return (
      this.testResults.shift() ?? {
        skipped: false,
        passed: true,
        exitCode: 0,
        timedOut: false,
        command: "bun test",
        output: "all tests passed",
        durationMs: 10,
      }
    );
  }

  async push(): Promise<void> {
    this.pushes += 1;
  }
}

class FakeDelivery implements DeliveryPort {
  async createPullRequest(): Promise<{ url: string }> {
    return { url: "https://github.com/acme/app/pull/1" };
  }
}

function setup(options: {
  config?: Partial<FactoryConfig>;
  responses?: Record<string, string[]>;
  testResults?: TestResult[];
  commitResults?: CommitResult[];
} = {}) {
  const store = new MemoryRunStore();
  const backlog = new FakeBacklog();
  const runtime = new FakeRuntime(options.responses);
  const workspace = new FakeWorkspace();
  if (options.testResults) workspace.testResults = options.testResults;
  if (options.commitResults) workspace.commitResults = options.commitResults;

  const workflow = new Workflow({
    config: makeConfig(options.config),
    store,
    backlog,
    runtime,
    workspace,
    delivery: new FakeDelivery(),
    feedback: null,
    logger: new Logger({}, "error"),
  });

  return { store, backlog, runtime, workspace, workflow };
}

async function createRun(store: MemoryRunStore): Promise<Run> {
  const run = await store.createRun(TICKET, {
    repoUrl: "https://github.com/acme/app.git",
    baseBranch: "main",
  });
  if (!run) throw new Error("run was not created");
  return run;
}

const failedTests: TestResult = {
  skipped: false,
  passed: false,
  exitCode: 1,
  timedOut: false,
  command: "bun test",
  output: "1 test failed: login rejects invalid credentials",
  durationMs: 20,
};

describe("workflow", () => {
  test("runs planner, builder, QA, tests, review and delivery", async () => {
    const { store, backlog, runtime, workspace, workflow } = setup({
      responses: {
        "factory-planner": ["# Plan\nDo the thing"],
        "factory-builder": ["# Implementation\nDone"],
        "factory-qa": ["# QA\nAll good"],
        "factory-reviewer": ["VERDICT: PASS\nLooks good"],
      },
    });
    const run = await createRun(store);

    await workflow.execute(run.id);

    const final = await store.getRun(run.id);
    expect(final?.state).toBe("HUMAN_REVIEW");
    expect(final?.prUrl).toBe("https://github.com/acme/app/pull/1");
    expect(runtime.calls.map((call) => call.agent)).toEqual([
      "factory-planner",
      "factory-builder",
      "factory-qa",
      "factory-reviewer",
    ]);
    expect(workspace.pushes).toBe(1);
    expect(backlog.movedToReview).toHaveLength(1);

    const artifacts = await store.listArtifacts(run.id);
    expect(artifacts.map((artifact) => artifact.name)).toEqual([
      "plan",
      "build",
      "qa",
      "tests",
      "review",
      "delivery",
    ]);
  });

  test("replays the build when the test gate fails", async () => {
    const { store, runtime, workflow } = setup({
      responses: {
        "factory-planner": ["# Plan"],
        "factory-builder": ["# Build 1", "# Build 2"],
        "factory-qa": ["# QA 1", "# QA 2"],
        "factory-reviewer": ["VERDICT: PASS"],
      },
      testResults: [failedTests, { ...failedTests, passed: true, exitCode: 0 }],
    });
    const run = await createRun(store);

    await workflow.execute(run.id);

    const final = await store.getRun(run.id);
    expect(final?.state).toBe("HUMAN_REVIEW");
    expect(final?.reworkCount).toBe(1);
    expect(runtime.calls.filter((call) => call.agent === "factory-builder")).toHaveLength(2);
    const builderCalls = runtime.calls.filter(
      (call) => call.agent === "factory-builder",
    );
    expect(builderCalls[1]?.prompt).toContain("previous attempt failed");
    expect(builderCalls[1]?.prompt).toContain("login rejects invalid credentials");
  });

  test("replays the build when the reviewer fails the change", async () => {
    const { store, runtime, workflow } = setup({
      responses: {
        "factory-planner": ["# Plan"],
        "factory-builder": ["# Build 1", "# Build 2"],
        "factory-qa": ["# QA 1", "# QA 2"],
        "factory-reviewer": ["VERDICT: FAIL\nMissing validation", "VERDICT: PASS"],
      },
    });
    const run = await createRun(store);

    await workflow.execute(run.id);

    const final = await store.getRun(run.id);
    expect(final?.state).toBe("HUMAN_REVIEW");
    expect(final?.reworkCount).toBe(1);
    const builderCalls = runtime.calls.filter(
      (call) => call.agent === "factory-builder",
    );
    expect(builderCalls).toHaveLength(2);
    expect(builderCalls[1]?.prompt).toContain("failed code review");
    expect(builderCalls[1]?.prompt).toContain("Missing validation");
  });

  test("triages a comment without action and returns to human review", async () => {
    const { store, runtime, workflow } = setup({
      responses: {
        "factory-feedback-triage": [
          JSON.stringify({
            comments: [
              {
                commentId: 1,
                decision: "NO_ACTION",
                reason: "It is just an acknowledgement.",
                tasks: [],
              },
            ],
          }),
        ],
      },
    });
    const run = await createRun(store);
    for (const state of [
      "PLANNING",
      "PLANNED",
      "BUILDING",
      "QA",
      "TESTING",
      "REVIEWING",
      "DELIVERY",
      "HUMAN_REVIEW",
      "TRIAGING",
    ] as const) {
      await store.transition(run.id, state);
    }
    for (const name of ["plan", "build", "review"]) {
      await store.addArtifact(run.id, {
        name,
        agent: null,
        content: `${name} content`,
      });
    }
    await store.addArtifact(run.id, {
      name: "triage-input",
      agent: null,
      content: "- id=1 @alice: GOOD",
      metadata: {
        commentIds: [1],
        conversationCommentIds: [1],
        inlineCommentIds: [],
        reviewIds: [],
        authors: ["alice"],
        reviewers: [],
      },
    });

    await workflow.execute(run.id);

    const final = await store.getRun(run.id);
    expect(final?.state).toBe("HUMAN_REVIEW");
    expect(await store.hasProcessedFeedback(run.id, "comment:1")).toBe(true);
    expect(runtime.calls.some((call) => call.agent === "factory-feedback-triage")).toBe(true);
  });

  test("blocks when the builder produces no changes", async () => {
    const { store, backlog, workflow } = setup({
      responses: {
        "factory-planner": ["# Plan"],
        "factory-builder": ["# Nothing"],
      },
      commitResults: [{ changed: false, sha: null }],
    });
    const run = await createRun(store);

    await workflow.execute(run.id);

    const final = await store.getRun(run.id);
    expect(final?.state).toBe("BLOCKED");
    expect(final?.blockReason).toContain("no changes");
    expect(backlog.movedToBlocked).toHaveLength(1);
  });

  test("blocks after the rework budget is exhausted", async () => {
    const { store, workflow } = setup({
      config: { maxRework: 1 },
      responses: {
        "factory-planner": ["# Plan"],
        "factory-builder": ["# Build 1", "# Build 2"],
        "factory-qa": ["# QA 1", "# QA 2"],
      },
      testResults: [failedTests, failedTests],
    });
    const run = await createRun(store);

    await workflow.execute(run.id);

    const final = await store.getRun(run.id);
    expect(final?.state).toBe("BLOCKED");
    expect(final?.blockReason).toContain("Maximum rework cycles reached");
  });
});

describe("verdict parsing", () => {
  test("accepts PASS and FAIL with surrounding whitespace", () => {
    expect(parseVerdict("  VERDICT: PASS\nok")).toBe("PASS");
    expect(parseVerdict("VERDICT: FAIL\nno")).toBe("FAIL");
  });

  test("treats an explicit negative verdict as FAIL", () => {
    expect(parseVerdict("VERDICT: PASS_WITH_COMMENTS")).toBe("FAIL");
  });

  test("treats a missing verdict as FAIL", () => {
    expect(parseVerdict("Looks fine to me")).toBe("FAIL");
  });
});
