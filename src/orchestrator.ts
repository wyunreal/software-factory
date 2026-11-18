import type {
  AutoMergePort,
  BacklogPort,
  FeedbackPort,
  PullRequestConversationComment,
  PullRequestReview,
  PullRequestReviewComment,
  RunStore,
} from "./ports.ts";
import type { Run } from "./domain/types.ts";
import type { FactoryConfig } from "./config.ts";
import { repositoryFromUrl } from "./config.ts";
import type { Logger } from "./logger.ts";
import type { Workflow } from "./workflow.ts";
import {
  hasApprovedReview,
  latestChangesRequestedReviews,
  pullRequestNumberFromUrl,
} from "./scm/approvals.ts";
import { nowIso, truncate } from "./util.ts";

export type OrchestratorStats = {
  polls: number;
  ticketsDiscovered: number;
  runsStarted: number;
  runsCompleted: number;
  errors: number;
};

export class Orchestrator {
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private workerTimer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private working = false;
  private stopped = false;
  private lastPollAt: string | null = null;
  private readonly startedAt = nowIso();
  private readonly stats: OrchestratorStats = {
    polls: 0,
    ticketsDiscovered: 0,
    runsStarted: 0,
    runsCompleted: 0,
    errors: 0,
  };

  constructor(
    private readonly config: FactoryConfig,
    private readonly store: RunStore,
    private readonly backlog: BacklogPort,
    private readonly workflow: Workflow,
    private readonly autoMerge: AutoMergePort | null,
    private readonly feedback: FeedbackPort | null,
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.stopped = false;
    this.pollTimer = setInterval(() => {
      void this.pollNow();
    }, this.config.pollIntervalMs);
    this.workerTimer = setInterval(() => {
      void this.workOnce();
    }, this.config.workerIntervalMs);
    this.pollTimer.unref?.();
    this.workerTimer.unref?.();
    void this.pollNow().then(() => this.workOnce());
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.workerTimer) clearInterval(this.workerTimer);
    this.pollTimer = null;
    this.workerTimer = null;
  }

  status(): Record<string, unknown> {
    return {
      startedAt: this.startedAt,
      lastPollAt: this.lastPollAt,
      polling: this.polling,
      working: this.working,
      stats: this.stats,
    };
  }

  async pollNow(): Promise<{ discovered: number; claimed: number }> {
    if (this.polling || this.stopped) return { discovered: 0, claimed: 0 };
    this.polling = true;
    let discovered = 0;
    let claimed = 0;

    try {
      const tickets = await this.backlog.fetchReadyTickets();
      discovered = tickets.length;
      this.stats.polls += 1;
      this.stats.ticketsDiscovered += tickets.length;
      this.lastPollAt = nowIso();

      for (const ticket of tickets) {
        const repoUrl = ticket.repoUrl ?? this.config.git.repoUrl;
        if (!repoUrl) {
          this.logger.warn("ticket has no repository URL", {
            ticket: ticket.ref,
          });
          continue;
        }
        const run = await this.store.createRun(ticket, {
          repoUrl,
          baseBranch: this.config.git.baseBranch,
        });
        if (!run) continue;
        try {
          await this.backlog.claim(ticket, run);
          await this.store.addEvent(run.id, "backlog.claimed", {
            cardId: ticket.cardId,
            ref: ticket.ref,
          });
          claimed += 1;
          this.stats.runsStarted += 1;
          this.logger.info("ticket claimed", {
            run: run.id,
            ticket: ticket.ref,
            title: ticket.title,
          });
        } catch (error) {
          this.stats.errors += 1;
          const message = truncate(
            error instanceof Error ? error.message : String(error),
            2_000,
          );
          this.logger.error("failed to claim ticket", {
            ticket: ticket.ref,
            error: message,
          });
          await this.store.transition(run.id, "BLOCKED", {
            blockReason: `Could not claim issue in GitHub: ${message}`,
            finishedAt: nowIso(),
          });
        }
      }

      await this.syncDeliveredRuns();
    } catch (error) {
      this.stats.errors += 1;
      this.logger.error("backlog poll failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.polling = false;
    }

    return { discovered, claimed };
  }

  async workOnce(): Promise<void> {
    if (this.working || this.stopped) return;
    this.working = true;
    try {
      const run = await this.store.claimNext();
      if (!run) return;
      this.logger.info("processing run", {
        run: run.id,
        ticket: run.ticket.ref,
        state: run.state,
      });
      await this.workflow.execute(run.id);
      const finished = await this.store.getRun(run.id);
      if (finished?.state === "HUMAN_REVIEW") this.stats.runsCompleted += 1;
    } catch (error) {
      this.stats.errors += 1;
      this.logger.error("worker failed", {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
    } finally {
      this.working = false;
    }
  }

  private async syncDeliveredRuns(): Promise<void> {
    const delivered = await this.store.listRunsByState("HUMAN_REVIEW");
    for (const run of delivered) {
      try {
        if (await this.maybeReworkFromFeedback(run)) continue;
        if (await this.maybeTriageComments(run)) continue;
        try {
          await this.maybeAutoMerge(run);
        } catch (error) {
          this.logger.warn("auto-merge check failed", {
            run: run.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        if (!(await this.backlog.isDone(run.ticket))) continue;
        await this.store.transition(run.id, "DONE");
        await this.store.addEvent(run.id, "run.done", {
          source: "github",
        });
        this.logger.info("run marked done", {
          run: run.id,
          ticket: run.ticket.ref,
        });
      } catch (error) {
        this.stats.errors += 1;
        this.logger.warn("failed to sync delivered run", {
          run: run.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async maybeTriageComments(run: Run): Promise<boolean> {
    if (
      !this.config.triagePrComments ||
      !this.feedback ||
      !this.autoMerge ||
      !run.prUrl
    ) {
      return false;
    }

    const repository = run.ticket.repo ?? repositoryFromUrl(run.repoUrl);
    const number = pullRequestNumberFromUrl(run.prUrl);
    if (!repository || !number) return false;

    const pr = await this.autoMerge.getPullRequestState(repository, number);
    if (pr.merged || pr.state !== "open") return false;

    const [reviews, reviewComments, conversationComments, factoryComments] =
      await Promise.all([
        this.autoMerge.getPullRequestReviews(repository, number),
        this.feedback.getPullRequestReviewComments(repository, number),
        this.feedback.getPullRequestConversationComments(repository, number),
        this.factoryCommentIds(run.id),
      ]);

    const reviewsById = new Map(reviews.map((review) => [review.id, review]));
    const commentIds: number[] = [];
    const conversationCommentIds: number[] = [];
    const inlineCommentIds: number[] = [];
    const reviewIds: number[] = [];
    const authors = new Set<string>();
    const reviewers = new Set<string>();
    const sections: string[] = ["# New pull-request comments", ""];
    const general: string[] = [];
    const inline: string[] = [];
    const reviewSummaries: string[] = [];

    const considered = async (
      id: number,
      user: string,
      association: string,
      body: string,
      processedId: string,
    ): Promise<boolean> => {
      if (!id || !body.trim() || factoryComments.has(id)) return false;
      if (looksLikeFactoryComment(body)) return false;
      if (!this.isAllowedFeedbackAuthor(user, association)) return false;
      if (await this.store.hasProcessedFeedback(run.id, processedId)) {
        return false;
      }
      return true;
    };

    for (const comment of conversationComments) {
      if (
        !(await considered(
          comment.id,
          comment.user,
          comment.authorAssociation,
          comment.body,
          `comment:${comment.id}`,
        ))
      ) {
        continue;
      }
      commentIds.push(comment.id);
      conversationCommentIds.push(comment.id);
      authors.add(comment.user);
      general.push(
        `- id=${comment.id} @${comment.user} (${comment.authorAssociation || "UNKNOWN"}): ${truncate(comment.body.trim(), 3_000)}`,
      );
    }

    for (const comment of reviewComments) {
      const review = reviewsById.get(comment.reviewId);
      if (review?.state === "APPROVED" || review?.state === "CHANGES_REQUESTED") {
        continue;
      }
      if (
        !(await considered(
          comment.id,
          comment.user,
          comment.authorAssociation,
          comment.body,
          `comment:${comment.id}`,
        ))
      ) {
        continue;
      }
      commentIds.push(comment.id);
      authors.add(comment.user);
      inlineCommentIds.push(comment.id);
      if (comment.reviewId) {
        reviewIds.push(comment.reviewId);
        if (review?.user) reviewers.add(review.user);
      }
      const location = comment.path
        ? `${comment.path}${comment.line ? `:${comment.line}` : ""}`
        : "(general)";
      inline.push(
        `- id=${comment.id} @${comment.user} on ${location}: ${truncate(comment.body.trim(), 3_000)}`,
      );
    }

    for (const review of reviews) {
      if (review.state !== "COMMENTED" || !review.body.trim()) continue;
      if (
        !(await considered(
          review.id,
          review.user,
          "COLLABORATOR",
          review.body,
          `review:${review.id}`,
        ))
      ) {
        continue;
      }
      reviewIds.push(review.id);
      authors.add(review.user);
      reviewers.add(review.user);
      reviewSummaries.push(
        `- id=${review.id} @${review.user}: ${truncate(review.body.trim(), 3_000)}`,
      );
    }

    if (commentIds.length === 0 && reviewIds.length === 0) return false;

    if (general.length > 0) {
      sections.push("## General comments", "", ...general, "");
    }
    if (inline.length > 0) {
      sections.push("## Inline review comments", "", ...inline, "");
    }
    if (reviewSummaries.length > 0) {
      sections.push("## Review summaries", "", ...reviewSummaries, "");
    }

    const content = sections.join("\n").trim();
    const uniqueReviewIds = [...new Set(reviewIds)];
    const uniqueCommentIds = [...new Set(commentIds)];
    const uniqueAuthors = [...authors];

    await this.store.addArtifact(run.id, {
      name: "triage-input",
      agent: null,
      content,
      metadata: {
        commentIds: uniqueCommentIds,
        conversationCommentIds,
        inlineCommentIds,
        reviewIds: uniqueReviewIds,
        authors: uniqueAuthors,
        reviewers: [...reviewers],
      },
    });
    await this.store.transition(run.id, "TRIAGING", {
      finishedAt: null,
      blockReason: null,
    });
    await this.store.addEvent(run.id, "triage.requested", {
      comments: uniqueCommentIds.length,
      reviews: uniqueReviewIds.length,
      authors: uniqueAuthors,
    });
    this.logger.info("pull-request comments queued for triage", {
      run: run.id,
      comments: uniqueCommentIds.length,
      reviews: uniqueReviewIds.length,
    });
    return true;
  }

  private isAllowedFeedbackAuthor(user: string, association: string): boolean {
    if (this.config.feedbackUsers.length > 0) {
      return this.config.feedbackUsers.includes(user.toLowerCase());
    }
    return ["OWNER", "MEMBER", "COLLABORATOR"].includes(association);
  }

  private async factoryCommentIds(runId: string): Promise<Set<number>> {
    const events = await this.store.listEvents(runId);
    const ids = new Set<number>();
    for (const event of events) {
      if (event.type !== "factory.comment" || !isRecord(event.data)) continue;
      const id = Number(event.data.id);
      if (Number.isInteger(id) && id > 0) ids.add(id);
    }
    return ids;
  }

  private async maybeReworkFromFeedback(run: Run): Promise<boolean> {
    if (
      !this.config.reworkOnChangesRequested ||
      !this.feedback ||
      !this.autoMerge ||
      !run.prUrl
    ) {
      return false;
    }

    const repository = run.ticket.repo ?? repositoryFromUrl(run.repoUrl);
    const number = pullRequestNumberFromUrl(run.prUrl);
    if (!repository || !number) return false;

    const pr = await this.autoMerge.getPullRequestState(repository, number);
    if (pr.merged || pr.state !== "open") return false;

    const reviews = await this.autoMerge.getPullRequestReviews(repository, number);
    const pendingReviews: PullRequestReview[] = [];
    for (const review of latestChangesRequestedReviews(reviews)) {
      if (await this.store.hasProcessedFeedback(run.id, `review:${review.id}`)) {
        continue;
      }
      pendingReviews.push(review);
    }
    if (pendingReviews.length === 0) return false;

    const reviewIds = new Set(pendingReviews.map((review) => review.id));
    const comments = await this.feedback.getPullRequestReviewComments(
      repository,
      number,
    );
    const feedbackComments = comments.filter((comment) =>
      reviewIds.has(comment.reviewId),
    );
    const reviewers = [...new Set(pendingReviews.map((review) => review.user))];
    const content = formatFeedback(pendingReviews, feedbackComments);

    if (run.reworkCount >= this.config.maxRework) {
      for (const review of pendingReviews) {
        await this.store.markFeedbackProcessed(
          run.id,
          `review:${review.id}`,
          "changes_requested",
        );
      }
      await this.store.transition(run.id, "BLOCKED", {
        blockReason: `Maximum rework cycles reached (${this.config.maxRework}) after human review feedback`,
        finishedAt: nowIso(),
      });
      await this.store.addEvent(run.id, "run.blocked", {
        reason: "Maximum rework cycles reached after human feedback",
        reviewIds: [...reviewIds],
      });
      try {
        await this.backlog.comment(
          run.ticket,
          "⛔ **Software Factory: rework budget exhausted**\n\n" +
            "A human requested changes but the maximum rework count was reached. " +
            "A human needs to take over.",
        );
        await this.backlog.moveToBlocked(run.ticket);
      } catch (error) {
        this.logger.warn("failed to update issue after feedback budget", {
          run: run.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return true;
    }

    const inlineCommentIds = feedbackComments.map((comment) => comment.id);
    await this.store.addArtifact(run.id, {
      name: "feedback",
      agent: null,
      content,
      metadata: {
        reviewIds: [...reviewIds],
        reviewers,
        authors: reviewers,
        commentIds: inlineCommentIds,
        inlineCommentIds,
        conversationCommentIds: [],
        feedbackKey: buildFeedbackKey([...reviewIds].map(String), inlineCommentIds, []),
      },
    });
    await this.store.transition(run.id, "REWORK", {
      finishedAt: null,
      reworkCount: run.reworkCount + 1,
      blockReason: null,
    });
    for (const review of pendingReviews) {
      await this.store.markFeedbackProcessed(
        run.id,
        `review:${review.id}`,
        "changes_requested",
      );
    }
    for (const commentId of inlineCommentIds) {
      await this.store.markFeedbackProcessed(
        run.id,
        `comment:${commentId}`,
        "review_comment",
      );
    }
    await this.store.addEvent(run.id, "feedback.rework_requested", {
      repository,
      pullRequest: number,
      reviewers,
      reviewIds: [...reviewIds],
      commentIds: feedbackComments.map((comment) => comment.id),
    });

    try {
      await this.backlog.moveToInProgress(run.ticket);
    } catch (error) {
      this.logger.warn("failed to move issue back to in-progress", {
        run: run.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      const ack = await this.feedback.commentPullRequest(
        repository,
        number,
        "🛠️ **Software Factory**\n\nI've picked up the requested changes and will update this PR. " +
          "The requested items will be addressed in a new commit.",
      );
      await this.store.addEvent(run.id, "factory.comment", {
        id: ack.id,
        kind: "changes_requested.ack",
      });
    } catch (error) {
      this.logger.warn("failed to acknowledge review feedback", {
        run: run.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    this.logger.info("rework requested from human review", {
      run: run.id,
      repository,
      pullRequest: number,
      reviewers,
      reworkCount: run.reworkCount + 1,
    });
    return true;
  }

  private async maybeAutoMerge(run: {
    id: string;
    prUrl: string | null;
    ticket: { repo?: string };
    repoUrl: string;
  }): Promise<void> {
    if (!this.config.autoMerge || !this.autoMerge || !run.prUrl) return;
    const repository =
      run.ticket.repo ?? repositoryFromUrl(run.repoUrl);
    const number = pullRequestNumberFromUrl(run.prUrl);
    if (!repository || !number) return;

    const pr = await this.autoMerge.getPullRequestState(repository, number);
    if (pr.merged || pr.state !== "open" || pr.draft) return;
    if (pr.mergeable !== true || pr.mergeableState !== "clean") return;

    const reviews = await this.autoMerge.getPullRequestReviews(
      repository,
      number,
    );
    if (!hasApprovedReview(reviews)) return;

    await this.autoMerge.mergePullRequest(
      repository,
      number,
      this.config.mergeMethod,
      pr.headSha,
    );
    await this.store.addEvent(run.id, "run.auto_merged", {
      repository,
      pullRequest: number,
      method: this.config.mergeMethod,
      sha: pr.headSha,
    });
    this.logger.info("pull request auto-merged", {
      run: run.id,
      repository,
      pullRequest: number,
      method: this.config.mergeMethod,
    });
  }
}

function formatFeedback(
  reviews: PullRequestReview[],
  comments: PullRequestReviewComment[],
): string {
  const parts = ["# Human review feedback", ""];
  for (const review of reviews) {
    parts.push(
      `## Review by @${review.user} — CHANGES_REQUESTED`,
      "",
      truncate(review.body.trim() || "(no summary body)", 8_000),
      "",
    );
    const related = comments.filter(
      (comment) => comment.reviewId === review.id,
    );
    if (related.length > 0) {
      parts.push("### Inline comments", "");
      for (const comment of related) {
        const location = comment.path
          ? `\`${comment.path}${comment.line ? `:${comment.line}` : ""}\``
          : "(general)";
        parts.push(
          `- ${location} by @${comment.user}: ${truncate(comment.body.trim(), 2_000)}`,
        );
      }
      parts.push("");
    }
  }
  return parts.join("\n").trim();
}

function buildFeedbackKey(
  reviewIds: string[],
  commentIds: number[],
  conversationCommentIds: number[],
): string {
  return [
    ...reviewIds.map((id) => `review:${id}`),
    ...commentIds.map((id) => `comment:${id}`),
    ...conversationCommentIds.map((id) => `conversation:${id}`),
  ]
    .sort()
    .join(",");
}

function looksLikeFactoryComment(body: string): boolean {
  const text = body.trim();
  return (
    /^[🤖✅🛠️]\s*\*\*Software Factory\*\*/.test(text) ||
    text.startsWith("Addressed in the latest commit") ||
    text.startsWith("Ready for re-review")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
