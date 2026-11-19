import type { Artifact, Run, TestResult } from "./domain/types.ts";
import type { FactoryConfig } from "./config.ts";
import { repositoryFromUrl } from "./config.ts";
import type {
  AgentRuntimePort,
  BacklogPort,
  DeliveryPort,
  FeedbackPort,
  RunStore,
  WorkspacePort,
} from "./ports.ts";
import type { Logger } from "./logger.ts";
import { BlockedError } from "./errors.ts";
import { assertTransition } from "./domain/state.ts";
import {
  hasRework,
  parseTriageResult,
  type TriageResult,
} from "./domain/triage.ts";
import {
  blockedComment,
  builderPrompt,
  deliveryComment,
  planningPrompt,
  pullRequestBody,
  qaPrompt,
  reviewPrompt,
  triagePrompt,
} from "./squad/prompts.ts";
import { nowIso, truncate } from "./util.ts";
import { pullRequestNumberFromUrl } from "./scm/approvals.ts";

export const AGENTS = {
  planner: "factory-planner",
  builder: "factory-builder",
  qa: "factory-qa",
  reviewer: "factory-reviewer",
  triage: "factory-feedback-triage",
} as const;

export type WorkflowDependencies = {
  config: FactoryConfig;
  store: RunStore;
  backlog: BacklogPort;
  runtime: AgentRuntimePort;
  workspace: WorkspacePort;
  delivery: DeliveryPort;
  feedback: FeedbackPort | null;
  logger: Logger;
};

export class Workflow {
  private readonly log: Logger;

  constructor(private readonly deps: WorkflowDependencies) {
    this.log = deps.logger.child({ component: "workflow" });
  }

  async execute(runId: string): Promise<void> {
    let run = await this.deps.store.getRun(runId);
    if (!run) throw new Error(`Run not found: ${runId}`);

    const log = this.log.child({ run: run.id, ticket: run.ticket.ref });
    try {
      log.info("run started", { state: run.state, title: run.ticket.title });
      const prepared = await this.deps.workspace.prepare(run);
      run = await this.deps.store.updateRun(run.id, {
        worktree: prepared.directory,
        branch: prepared.branch,
        setupCommand: prepared.setupCommand,
        testCommand: prepared.testCommand,
      });
      await this.deps.store.addEvent(run.id, "workspace.ready", prepared);

      let iterations = 0;
      while (true) {
        if (++iterations > 30) {
          throw new BlockedError("Workflow did not converge after 30 transitions");
        }

        const current = await this.deps.store.getRun(run.id);
        if (!current) throw new BlockedError("Run disappeared from the database");
        run = current;
        switch (run.state) {
          case "CLAIMED":
          case "PLANNING":
            await this.plan(run);
            break;
          case "PLANNED":
          case "BUILDING":
            await this.build(run);
            break;
          case "QA":
            await this.qa(run);
            break;
          case "TESTING":
            await this.test(run);
            break;
          case "REVIEWING":
            await this.review(run);
            break;
          case "REWORK":
            await this.startRework(run);
            break;
          case "TRIAGING":
            await this.triage(run);
            break;
          case "DELIVERY":
            await this.deliver(run);
            return;
          case "HUMAN_REVIEW":
          case "DONE":
          case "BLOCKED":
            return;
          default:
            throw new BlockedError(`Unhandled run state: ${run.state}`);
        }
      }
    } catch (error) {
      await this.block(run, error);
    }
  }

  private async plan(run: Run): Promise<void> {
    run = await this.ensureTransition(run, "PLANNING");
    const result = await this.runAgent(
      run,
      AGENTS.planner,
      planningPrompt(run.ticket, run.baseBranch),
      "Plan the ticket. Do not modify the working tree.",
    );
    if (!result.text.trim()) {
      throw new BlockedError("Planner returned an empty plan");
    }
    await this.saveArtifact(run, "plan", AGENTS.planner, result.text);
    await this.transitionTo(run, "PLANNED");
  }

  private async build(run: Run): Promise<void> {
    run = await this.ensureTransition(run, "BUILDING");
    const plan = await this.requireArtifact(run, "plan");
    const tests = await this.deps.store.latestArtifact(run.id, "tests");
    const review = await this.deps.store.latestArtifact(run.id, "review");
    const humanFeedback = await this.deps.store.latestArtifact(
      run.id,
      "feedback",
    );

    const feedback: { testOutput?: string; review?: string; feedback?: string } = {};
    if (isRecord(tests?.metadata) && tests.metadata.passed === false) {
      feedback.testOutput = tests.content;
    }
    if (isRecord(review?.metadata) && review.metadata.verdict === "FAIL") {
      feedback.review = review.content;
    }
    if (humanFeedback) {
      feedback.feedback = humanFeedback.content;
    }

    const result = await this.runAgent(
      run,
      AGENTS.builder,
      builderPrompt(run.ticket, plan.content, feedback),
      "Implement the ticket in the worktree.",
    );
    await this.saveArtifact(run, "build", AGENTS.builder, result.text);

    const commit = await this.deps.workspace.commit(run, commitMessage(run));
    if (!commit.changed) {
      throw new BlockedError(
        "Builder produced no changes: the worktree is identical to the base branch",
      );
    }
    await this.deps.store.addEvent(run.id, "workspace.committed", commit);
    await this.transitionTo(run, "QA");
  }

  private async qa(run: Run): Promise<void> {
    run = await this.ensureTransition(run, "QA");
    const plan = await this.requireArtifact(run, "plan");
    const buildReport = await this.requireArtifact(run, "build");

    const result = await this.runAgent(
      run,
      AGENTS.qa,
      qaPrompt(
        run.ticket,
        plan.content,
        buildReport.content,
        this.deps.config.testCommand,
      ),
      "Verify the implementation and strengthen the tests.",
    );
    await this.saveArtifact(run, "qa", AGENTS.qa, result.text);

    const commit = await this.deps.workspace.commit(
      run,
      `test(${run.ticket.ref}): verify acceptance criteria`,
    );
    if (commit.changed) {
      await this.deps.store.addEvent(run.id, "workspace.qa-committed", commit);
    }
    await this.transitionTo(run, "TESTING");
  }

  private async test(run: Run): Promise<void> {
    run = await this.ensureTransition(run, "TESTING");
    const result = await this.deps.workspace.runTests(run);
    await this.saveArtifact(
      run,
      "tests",
      null,
      formatTestReport(result),
      result,
    );
    await this.deps.store.addEvent(run.id, "tests.completed", {
      passed: result.passed,
      skipped: result.skipped,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
    });

    if (result.passed) {
      await this.transitionTo(run, "REVIEWING");
      return;
    }

    await this.reworkOrBlock(
      run,
      `Automated tests failed (exit ${result.exitCode ?? "killed"}${
        result.timedOut ? ", timed out" : ""
      }):\n${truncate(result.output, 1_500)}`,
      "tests",
    );
  }

  private async review(run: Run): Promise<void> {
    run = await this.ensureTransition(run, "REVIEWING");
    const plan = await this.requireArtifact(run, "plan");
    const tests = await this.deps.store.latestArtifact(run.id, "tests");
    const diffStat = await this.deps.workspace.diffStat(run);

    const result = await this.runAgent(
      run,
      AGENTS.reviewer,
      reviewPrompt(
        run.ticket,
        plan.content,
        diffStat,
        tests?.content ?? "(no test report)",
      ),
      "Review the change and return a verdict.",
    );
    const verdict = parseVerdict(result.text);
    await this.saveArtifact(run, "review", AGENTS.reviewer, result.text, {
      verdict,
    });

    if (verdict === "PASS") {
      await this.transitionTo(run, "DELIVERY");
      return;
    }

    await this.reworkOrBlock(
      run,
      `Code review failed:\n${truncate(result.text, 2_000)}`,
      "review",
    );
  }

  private async startRework(run: Run): Promise<void> {
    await this.transitionTo(run, "BUILDING");
    await this.deps.store.addEvent(run.id, "rework.started", {
      reworkCount: run.reworkCount,
    });
  }

  private async triage(run: Run): Promise<void> {
    const input = await this.requireArtifact(run, "triage-input");
    const plan = await this.requireArtifact(run, "plan");
    const buildReport = await this.requireArtifact(run, "build");
    const review = await this.requireArtifact(run, "review");
    const diffStat = await this.deps.workspace.diffStat(run);
    const metadata = isRecord(input.metadata) ? input.metadata : {};
    const commentIds = numberArray(metadata.commentIds);
    const reviewIds = numberArray(metadata.reviewIds);
    const authors = stringArray(metadata.authors);
    const reviewers = stringArray(metadata.reviewers);

    const result = await this.runAgent(
      run,
      AGENTS.triage,
      triagePrompt({
        ticket: run.ticket,
        plan: plan.content,
        buildReport: buildReport.content,
        review: review.content,
        diffStat,
        comments: input.content,
      }),
      "Evaluate the new pull-request comments.",
    );
    const parsed = parseTriageResult(result.text);
    await this.saveArtifact(run, "triage", AGENTS.triage, result.text, {
      parsed,
    });

    if (!parsed) {
      await this.markFeedback(run, commentIds, reviewIds);
      await this.deps.store.addEvent(run.id, "triage.invalid", {
        characters: result.text.length,
      });
      await this.returnToReview(run, "triage.invalid");
      return;
    }

    if (!hasRework(parsed)) {
      await this.markFeedback(run, commentIds, reviewIds);
      await this.deps.store.addEvent(run.id, "triage.no_action", {
        comments: parsed.comments.length,
      });
      await this.returnToReview(run, "triage.no_action");
      return;
    }

    if (run.reworkCount >= this.deps.config.maxRework) {
      await this.markFeedback(run, commentIds, reviewIds);
      throw new BlockedError(
        `Maximum rework cycles reached (${this.deps.config.maxRework}) after triaging human comments`,
      );
    }

    const actionable = parsed.comments.filter(
      (comment) => comment.decision === "REWORK",
    );
    const content = [
      "# Human pull-request feedback",
      "",
      input.content,
      "",
      "## Triage decisions",
      "",
      ...actionable.map((comment) =>
        [
          `- comment ${comment.commentId}: ${comment.reason || "changes required"}`,
          ...comment.tasks.map((task) => `  - ${task}`),
        ].join("\n"),
      ),
    ].join("\n");

    await this.saveArtifact(run, "feedback", null, content, {
      commentIds,
      inlineCommentIds: numberArray(metadata.inlineCommentIds),
      conversationCommentIds: numberArray(metadata.conversationCommentIds),
      reviewIds,
      authors,
      reviewers,
      feedbackKey: buildFeedbackKey(
        reviewIds.map(String),
        commentIds,
        numberArray(metadata.conversationCommentIds),
      ),
      triage: parsed,
    });
    await this.deps.store.transition(run.id, "REWORK", {
      finishedAt: null,
      reworkCount: run.reworkCount + 1,
      blockReason: null,
    });
    await this.markFeedback(run, commentIds, reviewIds);
    await this.deps.store.addEvent(run.id, "triage.rework", {
      comments: actionable.length,
      commentIds,
      reviewIds,
    });

    try {
      await this.deps.backlog.moveToInProgress(run.ticket);
    } catch (error) {
      this.log.warn("failed to move issue back to in-progress after triage", {
        run: run.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (this.deps.feedback) {
      try {
        const repository =
          run.ticket.repo ?? repositoryFromUrl(run.repoUrl) ?? undefined;
        const number = run.prUrl
          ? pullRequestNumberFromUrl(run.prUrl)
          : null;
        if (repository && number) {
          const ack = await this.deps.feedback.commentPullRequest(
            repository,
            number,
            "🛠️ **Software Factory**\n\n" +
              "I've evaluated the new comments and found changes that need work. " +
              "I'll update this PR.",
          );
          await this.deps.store.addEvent(run.id, "factory.comment", {
            id: ack.id,
            kind: "triage.ack",
          });
        }
      } catch (error) {
        this.log.warn("failed to acknowledge triage rework", {
          run: run.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.log.info("triage requested rework", {
      run: run.id,
      comments: actionable.length,
      reworkCount: run.reworkCount + 1,
    });
  }

  private async markFeedback(
    run: Run,
    commentIds: number[],
    reviewIds: number[],
  ): Promise<void> {
    for (const id of commentIds) {
      await this.deps.store.markFeedbackProcessed(
        run.id,
        `comment:${id}`,
        "comment",
      );
    }
    for (const id of reviewIds) {
      await this.deps.store.markFeedbackProcessed(
        run.id,
        `review:${id}`,
        "review",
      );
    }
  }

  private async returnToReview(run: Run, event: string): Promise<void> {
    await this.deps.store.transition(run.id, "HUMAN_REVIEW", {
      finishedAt: nowIso(),
      blockReason: null,
    });
    await this.deps.store.addEvent(run.id, event, {});
    this.log.info("feedback triage returned to review", { run: run.id });
  }

  private async deliver(run: Run): Promise<void> {
    run = await this.ensureTransition(run, "DELIVERY");
    const branch = run.branch;
    if (!branch) throw new BlockedError("Run has no branch to deliver");

    const [plan, build, qa, tests, review] = await Promise.all([
      this.requireArtifact(run, "plan"),
      this.requireArtifact(run, "build"),
      this.requireArtifact(run, "qa"),
      this.requireArtifact(run, "tests"),
      this.requireArtifact(run, "review"),
    ]);

    let prUrl: string | null = null;
    if (this.deps.config.deliveryMode === "github") {
      const repository =
        run.ticket.repo ?? repositoryFromUrl(run.repoUrl) ?? undefined;
      if (!repository) {
        throw new BlockedError("Cannot determine the GitHub repository for delivery");
      }
      await this.deps.workspace.push(run);
      const pr = await this.deps.delivery.createPullRequest({
        repository,
        head: branch,
        base: run.baseBranch,
        title: truncate(`[${run.ticket.ref}] ${run.ticket.title}`, 120),
        body: pullRequestBody({
          ticket: run.ticket,
          plan: plan.content,
          buildReport: build.content,
          qaReport: qa.content,
          testReport: tests.content,
          review: review.content,
          reworkCount: run.reworkCount,
        }),
        draft: this.deps.config.github.draft,
      });
      prUrl = pr.url;
    }

    if (prUrl) {
      await this.respondToHumanFeedback(run, prUrl);
    }

    const testsSummary = testsSummaryFromArtifact(tests);
    await this.saveArtifact(
      run,
      "delivery",
      null,
      prUrl
        ? `Pull request created: ${prUrl}`
        : `Local delivery. Branch: ${branch}\nWorktree: ${run.worktree}`,
      { prUrl },
    );

    try {
      await this.deps.backlog.comment(
        run.ticket,
        deliveryComment({
          prUrl,
          branch,
          testsSummary,
          reworkCount: run.reworkCount,
        }),
      );
    } catch (error) {
      this.log.warn("failed to comment on delivered ticket", {
        run: run.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      await this.deps.backlog.moveToReview(run.ticket);
    } catch (error) {
      this.log.warn("failed to move delivered ticket to review", {
        run: run.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    await this.deps.store.transition(run.id, "HUMAN_REVIEW", {
      prUrl,
      finishedAt: nowIso(),
    });
    await this.deps.store.addEvent(run.id, "run.delivered", { prUrl, branch });
    this.log.info("run delivered for human review", {
      run: run.id,
      prUrl,
      branch,
    });
  }

  private async reworkOrBlock(
    run: Run,
    reason: string,
    failedArtifact: string,
  ): Promise<void> {
    if (run.reworkCount >= this.deps.config.maxRework) {
      throw new BlockedError(
        `Maximum rework cycles reached (${this.deps.config.maxRework}). ${reason}`,
      );
    }

    await this.deps.store.transition(run.id, "REWORK", {
      reworkCount: run.reworkCount + 1,
      blockReason: null,
    });
    await this.deps.store.addEvent(run.id, "rework.required", {
      failedArtifact,
      reason: truncate(reason, 1_000),
      reworkCount: run.reworkCount + 1,
    });
  }

  private async block(run: Run, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const fresh = await this.deps.store.getRun(run.id);
    if (!fresh || fresh.state === "DONE" || fresh.state === "BLOCKED") return;
    if (fresh.state === "HUMAN_REVIEW") return;

    this.log.error("run blocked", {
      run: run.id,
      state: fresh.state,
      error: message,
      stack: error instanceof Error ? error.stack : undefined,
    });

    try {
      await this.deps.store.transition(fresh.id, "BLOCKED", {
        blockReason: truncate(message, 4_000),
        finishedAt: nowIso(),
      });
      await this.deps.store.addEvent(run.id, "run.blocked", { reason: message });
    } catch (transitionError) {
      this.log.error("failed to mark run as blocked", {
        run: run.id,
        error:
          transitionError instanceof Error
            ? transitionError.message
            : String(transitionError),
      });
      return;
    }

    try {
      await this.deps.backlog.comment(
        fresh.ticket,
        blockedComment({
          reason: message,
          branch: fresh.branch,
          reworkCount: fresh.reworkCount,
        }),
      );
      await this.deps.backlog.moveToBlocked(fresh.ticket);
    } catch (backlogError) {
      this.log.warn("failed to update GitHub issue after block", {
        run: run.id,
        error:
          backlogError instanceof Error ? backlogError.message : String(backlogError),
      });
    }
  }

  private async respondToHumanFeedback(
    run: Run,
    prUrl: string,
  ): Promise<void> {
    if (!this.deps.feedback) return;
    const artifact = await this.deps.store.latestArtifact(run.id, "feedback");
    if (!artifact || !isRecord(artifact.metadata)) return;

    const reviewIds = stringArray(artifact.metadata.reviewIds);
    const commentIds = numberArray(artifact.metadata.commentIds);
    const inlineCommentIds = numberArray(artifact.metadata.inlineCommentIds);
    const replyCommentIds =
      inlineCommentIds.length > 0 ? inlineCommentIds : commentIds;
    const conversationCommentIds = numberArray(
      artifact.metadata.conversationCommentIds,
    );
    const authors = stringArray(artifact.metadata.authors);
    const reviewers = stringArray(artifact.metadata.reviewers);
    if (
      reviewIds.length === 0 &&
      commentIds.length === 0 &&
      conversationCommentIds.length === 0 &&
      authors.length === 0
    ) {
      return;
    }
    const feedbackKey =
      typeof artifact.metadata.feedbackKey === "string"
        ? artifact.metadata.feedbackKey
        : buildFeedbackKey(reviewIds, commentIds, conversationCommentIds);

    const events = await this.deps.store.listEvents(run.id);
    const alreadyResponded = events.some(
      (event) =>
        event.type === "feedback.responded" &&
        isRecord(event.data) &&
        event.data.feedbackKey === feedbackKey,
    );
    if (alreadyResponded) return;

    const repository = run.ticket.repo ?? repositoryFromUrl(run.repoUrl);
    const number = pullRequestNumberFromUrl(prUrl);
    if (!repository || !number) return;

    for (const commentId of replyCommentIds) {
      try {
        const reply = await this.deps.feedback.replyToReviewComment(
          repository,
          number,
          commentId,
          "Addressed in the latest commit on this branch. Please re-review when you can.",
        );
        await this.deps.store.addEvent(run.id, "factory.comment", {
          id: reply.id,
          kind: "feedback.reply",
        });
      } catch (error) {
        this.log.warn("failed to reply to review comment", {
          run: run.id,
          commentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    try {
      const comment = await this.deps.feedback.commentPullRequest(
        repository,
        number,
        "✅ **Software Factory**\n\n" +
          (authors.length > 0
            ? `Feedback from ${authors.map((author) => `@${author}`).join(", ")} has been addressed in the latest commit. `
            : "The requested changes have been addressed in the latest commit. ") +
          "Ready for re-review.",
      );
      await this.deps.store.addEvent(run.id, "factory.comment", {
        id: comment.id,
        kind: "feedback.summary",
      });
    } catch (error) {
      this.log.warn("failed to comment on pull request after rework", {
        run: run.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      await this.deps.feedback.requestReReview(repository, number, reviewers);
    } catch (error) {
      this.log.warn("failed to request re-review", {
        run: run.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    await this.deps.store.addEvent(run.id, "feedback.responded", {
      feedbackKey,
      reviewIds,
      commentIds,
      conversationCommentIds,
      authors,
    });
  }

  private async runAgent(
    run: Run,
    agent: string,
    prompt: string,
    title: string,
  ) {
    if (!run.worktree) {
      throw new BlockedError("Run has no worktree");
    }
    const log = this.log.child({ run: run.id, agent });
    log.info("agent started");
    const result = await this.deps.runtime.run({
      agent,
      directory: run.worktree,
      title: `${run.ticket.ref}: ${title}`,
      prompt,
      timeoutMs: this.deps.config.stepTimeoutMs,
    });
    await this.deps.store.addEvent(run.id, "agent.completed", {
      agent,
      sessionId: result.sessionId,
      cost: result.cost,
      characters: result.text.length,
      tokens: result.tokens,
    });
    log.info("agent completed", {
      session: result.sessionId,
      cost: result.cost,
      characters: result.text.length,
    });
    return result;
  }

  private async saveArtifact(
    run: Run,
    name: string,
    agent: string | null,
    content: string,
    metadata: unknown = {},
  ): Promise<Artifact> {
    const artifact = await this.deps.store.addArtifact(run.id, {
      name,
      agent,
      content,
      metadata,
    });
    await this.deps.store.addEvent(run.id, "artifact.saved", {
      name,
      agent,
      characters: content.length,
    });
    return artifact;
  }

  private async requireArtifact(run: Run, name: string): Promise<Artifact> {
    const artifact = await this.deps.store.latestArtifact(run.id, name);
    if (!artifact) {
      throw new BlockedError(`Required artifact "${name}" is missing`);
    }
    return artifact;
  }

  private async ensureTransition(run: Run, to: Run["state"]): Promise<Run> {
    if (run.state === to) return run;
    assertTransition(run.state, to);
    return this.transitionTo(run, to);
  }

  private async transitionTo(run: Run, to: Run["state"]): Promise<Run> {
    const updated = await this.deps.store.transition(run.id, to);
    await this.deps.store.addEvent(run.id, `state.${to.toLowerCase()}`, {});
    return updated;
  }
}

export function parseVerdict(text: string): "PASS" | "FAIL" {
  const match = /^\s*VERDICT\s*:\s*(PASS|FAIL)\b/im.exec(text);
  return match?.[1]?.toUpperCase() === "PASS" ? "PASS" : "FAIL";
}

function formatTestReport(result: TestResult): string {
  const heading = result.skipped
    ? "# Automated tests: SKIPPED"
    : result.passed
      ? "# Automated tests: PASSED"
      : "# Automated tests: FAILED";
  const meta = result.skipped
    ? result.output
    : [
        `Command: \`${result.command}\``,
        `Exit code: ${result.exitCode ?? "killed"}`,
        `Timed out: ${result.timedOut}`,
        `Duration: ${result.durationMs} ms`,
        "",
        "Output:",
        "```",
        result.output || "(no output)",
        "```",
      ].join("\n");
  return `${heading}\n\n${meta}`;
}

function testsSummaryFromArtifact(artifact: Artifact): string {
  if (!isRecord(artifact.metadata)) return "unknown";
  if (artifact.metadata.skipped === true) return "skipped (no test command)";
  return artifact.metadata.passed === true ? "PASSED" : "FAILED";
}

function commitMessage(run: Run): string {
  const title = run.ticket.title.replace(/\s+/g, " ").trim();
  return `feat(${run.ticket.ref}): ${truncate(title, 60)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(String).filter(Boolean);
}

function numberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item > 0);
}

function sameStringSet(value: unknown, expected: string[]): boolean {
  const actual = [...stringArray(value)].sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((item, index) => item === wanted[index])
  );
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
