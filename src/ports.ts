import type {
  AgentRunResult,
  Artifact,
  CommitResult,
  EnqueueJobInput,
  Run,
  RunEvent,
  RunJob,
  RunState,
  Ticket,
} from "./domain/types.ts";

export type RunPatch = {
  state?: RunState;
  repoUrl?: string;
  baseBranch?: string;
  setupCommand?: string | null;
  testCommand?: string | null;
  branch?: string | null;
  worktree?: string | null;
  reworkCount?: number;
  prUrl?: string | null;
  blockReason?: string | null;
  finishedAt?: string | null;
};

export type CreateRunOptions = {
  repoUrl: string;
  baseBranch: string;
  setupCommand?: string | null;
  testCommand?: string | null;
};

export interface RunStore {
  createRun(ticket: Ticket, options: CreateRunOptions): Promise<Run | null>;
  getRun(id: string): Promise<Run | null>;
  listRuns(limit: number): Promise<Run[]>;
  listRunsByState(state: RunState): Promise<Run[]>;
  claimNext(): Promise<Run | null>;
  updateRun(id: string, patch: RunPatch): Promise<Run>;
  transition(id: string, to: RunState, patch?: RunPatch): Promise<Run>;
  addArtifact(
    runId: string,
    artifact: {
      name: string;
      agent: string | null;
      content: string;
      metadata?: unknown;
    },
  ): Promise<Artifact>;
  listArtifacts(runId: string): Promise<Artifact[]>;
  latestArtifact(runId: string, name: string): Promise<Artifact | null>;
  addEvent(runId: string, type: string, data?: unknown): Promise<void>;
  listEvents(runId: string): Promise<RunEvent[]>;
  hasProcessedFeedback(runId: string, feedbackId: string): Promise<boolean>;
  markFeedbackProcessed(
    runId: string,
    feedbackId: string,
    kind: string,
  ): Promise<void>;
  enqueueJob(input: EnqueueJobInput): Promise<RunJob | null>;
  claimNextJob(): Promise<RunJob | null>;
  completeJob(id: string): Promise<void>;
  retryJob(id: string, error: string, delayMs: number): Promise<void>;
  failJob(id: string, error: string): Promise<void>;
  resetRunningJobs(): Promise<number>;
}

export interface BacklogPort {
  validate(): Promise<void>;
  claim(ticket: Ticket, run: Run): Promise<void>;
  comment(ticket: Ticket, text: string): Promise<void>;
  moveToInProgress(ticket: Ticket): Promise<void>;
  moveToReview(ticket: Ticket): Promise<void>;
  moveToBlocked(ticket: Ticket): Promise<void>;
  isDone(ticket: Ticket): Promise<boolean>;
}

export type AgentRunRequest = {
  agent: string;
  directory: string;
  title: string;
  prompt: string;
  timeoutMs: number;
};

export interface AgentRuntimePort {
  run(request: AgentRunRequest): Promise<AgentRunResult>;
}

export interface WorkspacePort {
  prepare(run: Run): Promise<{
    directory: string;
    branch: string;
  }>;
  commit(run: Run, message: string): Promise<CommitResult>;
  diffStat(run: Run): Promise<string>;
  push(run: Run): Promise<void>;
}

export type PullRequestInput = {
  repository: string;
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
};

export type PullRequestState = {
  number: number;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  mergeable: boolean | null;
  mergeableState: string | null;
  headSha: string;
};

export type PullRequestReview = {
  id: number;
  user: string;
  state: string;
  body: string;
  submittedAt: string;
};

export type PullRequestReviewComment = {
  id: number;
  reviewId: number;
  user: string;
  authorAssociation: string;
  path: string | null;
  line: number | null;
  body: string;
  createdAt: string;
};

export type PullRequestConversationComment = {
  id: number;
  user: string;
  authorAssociation: string;
  body: string;
  createdAt: string;
};

export interface FeedbackPort {
  getPullRequestReviewComments(
    repository: string,
    number: number,
  ): Promise<PullRequestReviewComment[]>;
  getPullRequestConversationComments(
    repository: string,
    number: number,
  ): Promise<PullRequestConversationComment[]>;
  replyToReviewComment(
    repository: string,
    number: number,
    commentId: number,
    body: string,
  ): Promise<{ id: number }>;
  commentPullRequest(
    repository: string,
    number: number,
    body: string,
  ): Promise<{ id: number }>;
  requestReReview(
    repository: string,
    number: number,
    reviewers: string[],
  ): Promise<void>;
}

export interface AutoMergePort {
  getPullRequestState(
    repository: string,
    number: number,
  ): Promise<PullRequestState>;
  getPullRequestReviews(
    repository: string,
    number: number,
  ): Promise<PullRequestReview[]>;
  mergePullRequest(
    repository: string,
    number: number,
    method: "merge" | "squash" | "rebase",
    sha: string,
  ): Promise<void>;
}

export interface DeliveryPort {
  createPullRequest(input: PullRequestInput): Promise<{ url: string }>;
}
