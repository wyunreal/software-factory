import type { FactoryConfig } from "./config.ts";
import type { RunStore } from "./ports.ts";
import type { Logger } from "./logger.ts";
import type { Workflow } from "./workflow.ts";
import { nowIso } from "./util.ts";

export type RunWorkerStats = {
  jobsProcessed: number;
  jobsFailed: number;
};

const MAX_JOB_ATTEMPTS = 3;
const RETRY_DELAY_MS = 5_000;

/**
 * Claims queued jobs and hands them to the workflow. It does not inspect
 * GitHub or run commands in the target repository.
 */
export class RunWorker {
  private workerTimer: ReturnType<typeof setInterval> | null = null;
  private working = false;
  private stopped = false;
  private readonly startedAt = nowIso();
  private readonly stats: RunWorkerStats = {
    jobsProcessed: 0,
    jobsFailed: 0,
  };

  constructor(
    private readonly config: FactoryConfig,
    private readonly store: RunStore,
    private readonly workflow: Workflow,
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.stopped = false;
    this.workerTimer = setInterval(() => {
      void this.workOnce();
    }, this.config.workerIntervalMs);
    this.workerTimer.unref?.();
    void this.workOnce();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.workerTimer) clearInterval(this.workerTimer);
    this.workerTimer = null;
  }

  status(): Record<string, unknown> {
    return {
      startedAt: this.startedAt,
      working: this.working,
      stats: this.stats,
    };
  }

  async workOnce(): Promise<void> {
    if (this.working || this.stopped) return;
    this.working = true;
    try {
      const job = await this.store.claimNextJob();
      if (!job) return;

      try {
        await this.workflow.handleJob(job.runId, job);
        await this.store.completeJob(job.id);
        this.stats.jobsProcessed += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (job.attempts >= MAX_JOB_ATTEMPTS) {
          await this.store.failJob(job.id, message);
          this.stats.jobsFailed += 1;
          this.logger.error("job failed permanently", {
            job: job.id,
            kind: job.kind,
            run: job.runId,
            error: message,
          });
        } else {
          await this.store.retryJob(job.id, message, RETRY_DELAY_MS);
          this.logger.warn("job failed; retrying", {
            job: job.id,
            kind: job.kind,
            run: job.runId,
            attempts: job.attempts,
            error: message,
          });
        }
      }
    } finally {
      this.working = false;
    }
  }
}
