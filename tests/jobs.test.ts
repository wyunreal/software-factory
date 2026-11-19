import { describe, expect, test } from "vitest";
import { MemoryRunStore } from "../src/store/memory.ts";
import type { Ticket } from "../src/domain/types.ts";

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

async function seededStore() {
  const store = new MemoryRunStore();
  const run = await store.createRun(ticket, {
    ownerUserId: "usr_test",
    repoUrl: ticket.repoUrl!,
    baseBranch: "main",
  });
  if (!run) throw new Error("run was not created");
  return { store, run };
}

describe("run jobs", () => {
  test("deduplicates by dedup key", async () => {
    const { store, run } = await seededStore();
    const input = {
      kind: "start_issue" as const,
      runId: run.id,
      repo: "acme/app",
      issueNumber: 7,
      dedupKey: "start_issue:1",
    };

    const first = await store.enqueueJob(input);
    const second = await store.enqueueJob(input);

    expect(first?.kind).toBe("start_issue");
    expect(second).toBeNull();
  });

  test("claims one job at a time and completes it", async () => {
    const { store, run } = await seededStore();
    await store.enqueueJob({
      kind: "start_issue",
      runId: run.id,
      repo: "acme/app",
      dedupKey: "start_issue:1",
    });

    const claimed = await store.claimNextJob();
    expect(claimed?.status).toBe("running");
    expect(claimed?.attempts).toBe(1);
    expect(await store.claimNextJob()).toBeNull();

    await store.completeJob(claimed!.id);
    expect(await store.claimNextJob()).toBeNull();
  });

  test("retries after the backoff and can fail permanently", async () => {
    const { store, run } = await seededStore();
    const job = await store.enqueueJob({
      kind: "pr_sync",
      runId: run.id,
      repo: "acme/app",
      dedupKey: "pr_sync:1",
    });
    const claimed = await store.claimNextJob();
    await store.retryJob(claimed!.id, "boom", 60_000);
    expect(await store.claimNextJob()).toBeNull();

    await store.retryJob(claimed!.id, "boom", 0);
    const retried = await store.claimNextJob();
    expect(retried?.attempts).toBe(2);

    expect(await store.resetRunningJobs()).toBe(1);
    expect((await store.claimNextJob())?.attempts).toBe(3);

    await store.failJob(job!.id, "permanent");
    expect(await store.claimNextJob()).toBeNull();
  });
});
