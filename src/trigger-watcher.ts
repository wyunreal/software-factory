import type { FactoryConfig } from "./config.ts";
import { repositoryFromUrl } from "./config.ts";
import type {
  AutoMergePort,
  FeedbackPort,
  RunStore,
} from "./ports.ts";
import type { Logger } from "./logger.ts";
import { nowIso } from "./util.ts";
import { pullRequestNumberFromUrl } from "./scm/approvals.ts";

export type TriggerWatcherStats = {
  syncs: number;
  jobsEnqueued: number;
  errors: number;
};

/**
 * Detects that a run needs work and enqueues a job. It never touches the
 * target repository and never changes a run state.
 */
export class TriggerWatcher {
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private syncing = false;
  private stopped = false;
  private lastSyncAt: string | null = null;
  private readonly startedAt = nowIso();
  private readonly stats: TriggerWatcherStats = {
    syncs: 0,
    jobsEnqueued: 0,
    errors: 0,
  };

  constructor(
    private readonly config: FactoryConfig,
    private readonly store: RunStore,
    private readonly feedback: FeedbackPort | null,
    private readonly autoMerge: AutoMergePort | null,
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.stopped = false;
    if (!this.config.prPolling) return;
    this.syncTimer = setInterval(() => {
      void this.syncNow();
    }, this.config.pollIntervalMs);
    this.syncTimer.unref?.();
    void this.syncNow();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.syncTimer = null;
  }

  status(): Record<string, unknown> {
    return {
      startedAt: this.startedAt,
      lastSyncAt: this.lastSyncAt,
      syncing: this.syncing,
      polling: this.config.prPolling,
      stats: this.stats,
    };
  }

  async syncNow(): Promise<void> {
    if (this.syncing || this.stopped || !this.autoMerge) return;
    this.syncing = true;
    try {
      this.lastSyncAt = nowIso();
      this.stats.syncs += 1;
      const runs = await this.store.listRunsByState("HUMAN_REVIEW");
      for (const run of runs) {
        try {
          await this.enqueueIfChanged(run.id);
        } catch (error) {
          this.stats.errors += 1;
          this.logger.warn("trigger scan failed", {
            run: run.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      this.syncing = false;
    }
  }

  private async enqueueIfChanged(runId: string): Promise<void> {
    const run = await this.store.getRun(runId);
    if (!run?.prUrl || !this.autoMerge) return;
    const repository = run.ticket.repo ?? repositoryFromUrl(run.repoUrl);
    const prNumber = pullRequestNumberFromUrl(run.prUrl);
    if (!repository || !prNumber) return;

    const pr = await this.autoMerge.getPullRequestState(repository, prNumber);
    const reviews = await this.autoMerge.getPullRequestReviews(
      repository,
      prNumber,
    );
    const reviewComments = this.feedback
      ? await this.feedback.getPullRequestReviewComments(repository, prNumber)
      : [];
    const conversationComments = this.feedback
      ? await this.feedback.getPullRequestConversationComments(
          repository,
          prNumber,
        )
      : [];

    const latestReview = maxId(reviews.map((review) => review.id));
    const latestComment = maxId([
      ...reviewComments.map((comment) => comment.id),
      ...conversationComments.map((comment) => comment.id),
    ]);
    const fingerprint = [
      pr.state,
      pr.merged ? "merged" : "open",
      pr.headSha,
      latestReview,
      latestComment,
    ].join(":");

    const job = await this.store.enqueueJob({
      kind: "pr_sync",
      runId: run.id,
      repo: repository,
      issueNumber: run.ticket.number ?? null,
      prNumber,
      dedupKey: `pr_sync:${run.id}:${fingerprint}`,
      payload: { repository, prNumber, fingerprint },
    });
    if (job) {
      this.stats.jobsEnqueued += 1;
      this.logger.info("trigger enqueued", {
        run: run.id,
        kind: job.kind,
        fingerprint,
      });
    }
  }
}

function maxId(ids: number[]): number {
  return ids.reduce((max, id) => (id > max ? id : max), 0);
}
