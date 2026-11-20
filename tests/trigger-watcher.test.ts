import { describe, expect, test } from "vitest";
import { TriggerWatcher } from "../src/trigger-watcher.ts";
import { MemoryRunStore } from "../src/store/memory.ts";
import type { FactoryConfig } from "../src/config.ts";
import type { AutoMergePort, FeedbackPort } from "../src/ports.ts";
import type { Ticket } from "../src/domain/types.ts";
import { Logger } from "../src/logger.ts";

const ticket: Ticket = {
  cardId: "1001",
  number: 7,
  ref: "GH-7",
  title: "Test issue",
  description: "",
  url: "",
  labels: [],
  acceptanceCriteria: [],
  repo: "acme/app",
  repoUrl: "https://github.com/acme/app.git",
};

async function humanReviewRun(store: MemoryRunStore) {
  const project = await store.createProject({
    ownerUserId: "usr_test",
    name: "Acme app",
    repo: "acme/app",
    repoUrl: ticket.repoUrl!,
  });
  if (!project) throw new Error("project was not created");
  const run = await store.createRun(ticket, {
    ownerUserId: "usr_test",
    projectId: project.id,
    repoUrl: ticket.repoUrl!,
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
        ? { prUrl: "https://github.com/acme/app/pull/1" }
        : {}),
    });
  }
  return run;
}

describe("trigger watcher", () => {
  test("enqueues one pr_sync job per PR fingerprint", async () => {
    const store = new MemoryRunStore();
    const run = await humanReviewRun(store);

    const autoMerge = {
      getPullRequestState: async () => ({
        number: 1,
        state: "open",
        draft: false,
        merged: false,
        mergeable: true,
        mergeableState: "clean",
        headSha: "abc123",
      }),
      getPullRequestReviews: async () => [],
      mergePullRequest: async () => undefined,
    } as unknown as AutoMergePort;
    const feedback = {
      getPullRequestReviewComments: async () => [],
      getPullRequestConversationComments: async () => [],
    } as unknown as FeedbackPort;

    const watcher = new TriggerWatcher(
      { pollIntervalMs: 1000 } as FactoryConfig,
      store,
      feedback,
      autoMerge,
      new Logger({}, "error"),
    );

    await watcher.syncNow();
    const job = await store.claimNextJob();
    expect(job?.kind).toBe("pr_sync");
    expect(job?.runId).toBe(run.id);

    await store.completeJob(job!.id);
    await watcher.syncNow();
    expect(await store.claimNextJob()).toBeNull();
  });
});
