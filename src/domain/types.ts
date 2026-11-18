export type Ticket = {
  cardId: string;
  ref: string;
  title: string;
  description: string;
  url: string;
  labels: string[];
  acceptanceCriteria: string[];
  /** GitHub issue number, when the backlog is GitHub Issues. */
  number?: number;
  /** GitHub repository in owner/repo form. */
  repo?: string;
  /** HTTPS clone URL for the issue's repository. */
  repoUrl?: string;
};

export const RUN_STATES = [
  "CLAIMED",
  "PLANNING",
  "PLANNED",
  "BUILDING",
  "QA",
  "TESTING",
  "REVIEWING",
  "REWORK",
  "TRIAGING",
  "DELIVERY",
  "HUMAN_REVIEW",
  "DONE",
  "BLOCKED",
] as const;

export type RunState = (typeof RUN_STATES)[number];

export type Run = {
  id: string;
  ticket: Ticket;
  state: RunState;
  repoUrl: string;
  baseBranch: string;
  setupCommand: string | null;
  testCommand: string | null;
  branch: string | null;
  worktree: string | null;
  reworkCount: number;
  prUrl: string | null;
  blockReason: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

export type Artifact = {
  id: number;
  runId: string;
  name: string;
  agent: string | null;
  content: string;
  metadata: unknown;
  createdAt: string;
};

export type RunEvent = {
  id: number;
  runId: string;
  type: string;
  data: unknown;
  createdAt: string;
};

export type TestResult = {
  skipped: boolean;
  passed: boolean;
  exitCode: number | null;
  timedOut: boolean;
  command: string;
  output: string;
  durationMs: number;
};

export type CommitResult = {
  changed: boolean;
  sha: string | null;
};

export type AgentRunResult = {
  sessionId: string;
  text: string;
  cost: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
  };
};

export type ModelRef = {
  providerID: string;
  id: string;
  variant?: string;
};
