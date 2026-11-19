import { afterAll, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitWorkspace } from "../src/scm/git.ts";
import type { FactoryConfig } from "../src/config.ts";
import type { Run } from "../src/domain/types.ts";
import { Logger } from "../src/logger.ts";

const root = mkdtempSync(join(tmpdir(), "sf-git-test-"));
const origin = join(root, "origin");

function makeConfig(dataDir: string): FactoryConfig {
  return {
    port: 0,
    apiToken: null,
    dataDir,
    pollIntervalMs: 1000,
    workerIntervalMs: 1000,
    stepTimeoutMs: 5000,
    testTimeoutMs: 5000,
    maxRework: 3,
    testCommand: "true",
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
      token: null,
    },
  };
}

function run(cmd: string[], cwd: string): void {
  try {
    execFileSync(cmd[0]!, cmd.slice(1), { cwd, stdio: "pipe" });
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString() ?? "";
    throw new Error(`${cmd.join(" ")} failed: ${stderr}`);
  }
}

function makeRun(repoUrl: string): Run {
  return {
    id: "1234abcd-0000-0000-0000-000000000000",
    ticket: {
      cardId: "1",
      number: 1,
      ref: "GH-1",
      title: "Test",
      description: "",
      url: "https://github.com/acme/app/issues/1",
      labels: [],
      acceptanceCriteria: [],
      repo: "acme/app",
      repoUrl,
    },
    state: "CLAIMED",
    repoUrl,
    baseBranch: "main",
    setupCommand: null,
    testCommand: null,
    branch: null,
    worktree: null,
    reworkCount: 0,
    prUrl: null,
    blockReason: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    finishedAt: null,
  };
}

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("git workspace per-repo", () => {
  test("clones the run repo and creates an isolated worktree", async () => {
    mkdirSync(join(origin, "src"), { recursive: true });
    writeFileSync(join(origin, "src", "main.txt"), "hello\n");
    run(["git", "init", "-q", "-b", "main"], origin);
    run(["git", "config", "user.email", "test@example.com"], origin);
    run(["git", "config", "user.name", "Test"], origin);
    run(["git", "add", "-A"], origin);
    run(["git", "commit", "-q", "-m", "initial"], origin);

    const workspace = new GitWorkspace(makeConfig(root), new Logger({}, "error"));
    const prepared = await workspace.prepare(makeRun(origin));

    expect(prepared.directory).toContain("/worktrees/");
    expect(prepared.branch.startsWith("factory/gh-1-")).toBe(true);
    expect(existsSync(join(prepared.directory, "src", "main.txt"))).toBe(true);
  });
});
