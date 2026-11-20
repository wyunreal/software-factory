import type { CreateRunOptions, RunPatch, RunStore } from "../ports.ts";
import type {
  Artifact,
  EnqueueJobInput,
  Project,
  Run,
  RunEvent,
  RunJob,
  RunJobKind,
  RunJobStatus,
  RunState,
  Ticket,
} from "../domain/types.ts";
import { assertTransition } from "../domain/state.ts";
import { nowIso } from "../util.ts";

/**
 * In-memory store used by tests and by the dry-run demo. It implements the same
 * contract as the Postgres store, including transition validation and the
 * "one active run per ticket" rule.
 */
export class MemoryRunStore implements RunStore {
  private runs = new Map<string, Run>();
  private projects = new Map<string, Project>();
  private artifacts = new Map<string, Artifact[]>();
  private events = new Map<string, RunEvent[]>();
  private processedFeedback = new Set<string>();
  private jobs = new Map<string, RunJob>();
  private jobDedup = new Set<string>();
  private artifactId = 0;
  private eventId = 0;

  async createRun(
    ticket: Ticket,
    options: CreateRunOptions,
  ): Promise<Run | null> {
    const project = this.projects.get(options.projectId);
    if (!project || project.ownerUserId !== options.ownerUserId) return null;

    const active = [...this.runs.values()].some(
      (run) =>
        run.ownerUserId === options.ownerUserId &&
        run.ticket.cardId === ticket.cardId &&
        run.finishedAt === null,
    );
    if (active) return null;

    const at = nowIso();
    const run: Run = {
      id: crypto.randomUUID(),
      ownerUserId: options.ownerUserId,
      projectId: options.projectId,
      ticket: { ...ticket, repoUrl: options.repoUrl },
      state: "CLAIMED",
      repoUrl: options.repoUrl,
      baseBranch: options.baseBranch,
      setupCommand: options.setupCommand ?? null,
      testCommand: options.testCommand ?? null,
      branch: null,
      worktree: null,
      reworkCount: 0,
      prUrl: null,
      blockReason: null,
      createdAt: at,
      updatedAt: at,
      finishedAt: null,
    };
    this.runs.set(run.id, run);
    return structuredClone(run);
  }

  async getRun(id: string): Promise<Run | null> {
    const run = this.runs.get(id);
    return run ? structuredClone(run) : null;
  }

  async listRunsForUser(ownerUserId: string, limit: number): Promise<Run[]> {
    return [...this.runs.values()]
      .filter((run) => run.ownerUserId === ownerUserId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map((run) => structuredClone(run));
  }

  async listHumanReviewRunsForRepository(repo: string): Promise<Run[]> {
    return [...this.runs.values()]
      .filter(
        (run) =>
          run.state === "HUMAN_REVIEW" &&
          run.finishedAt === null &&
          run.ticket.repo?.toLowerCase() === repo.toLowerCase(),
      )
      .map((run) => structuredClone(run));
  }

  async createProject(input: {
    ownerUserId: string;
    name: string;
    repo: string;
    repoUrl: string;
  }): Promise<Project | null> {
    const duplicate = [...this.projects.values()].some(
      (project) =>
        project.ownerUserId === input.ownerUserId &&
        (project.name.toLowerCase() === input.name.toLowerCase() ||
          project.repo.toLowerCase() === input.repo.toLowerCase()),
    );
    if (duplicate) return null;

    const project: Project = {
      id: `proj_${crypto.randomUUID()}`,
      ownerUserId: input.ownerUserId,
      name: input.name,
      repo: input.repo.toLowerCase(),
      repoUrl: input.repoUrl,
      createdAt: nowIso(),
    };
    this.projects.set(project.id, project);
    return structuredClone(project);
  }

  async listProjectsForUser(ownerUserId: string): Promise<Project[]> {
    return [...this.projects.values()]
      .filter((project) => project.ownerUserId === ownerUserId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((project) => structuredClone(project));
  }

  async getProjectForUser(
    id: string,
    ownerUserId: string,
  ): Promise<Project | null> {
    const project = this.projects.get(id);
    return project?.ownerUserId === ownerUserId
      ? structuredClone(project)
      : null;
  }

  async ping(): Promise<void> {}

  async listRunsByState(state: RunState): Promise<Run[]> {
    return [...this.runs.values()]
      .filter((run) => run.state === state)
      .map((run) => structuredClone(run));
  }

  async claimNext(): Promise<Run | null> {
    const run = [...this.runs.values()]
      .filter(
        (candidate) =>
          candidate.finishedAt === null &&
          candidate.state !== "DONE" &&
          candidate.state !== "BLOCKED",
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    return run ? structuredClone(run) : null;
  }

  async updateRun(id: string, patch: RunPatch): Promise<Run> {
    return this.update(id, patch);
  }

  async transition(id: string, to: RunState, patch: RunPatch = {}): Promise<Run> {
    return this.update(id, { ...patch, state: to });
  }

  async addArtifact(
    runId: string,
    artifact: {
      name: string;
      agent: string | null;
      content: string;
      metadata?: unknown;
    },
  ): Promise<Artifact> {
    const created: Artifact = {
      id: ++this.artifactId,
      runId,
      name: artifact.name,
      agent: artifact.agent,
      content: artifact.content,
      metadata: artifact.metadata ?? {},
      createdAt: nowIso(),
    };
    const list = this.artifacts.get(runId) ?? [];
    list.push(created);
    this.artifacts.set(runId, list);
    return structuredClone(created);
  }

  async listArtifacts(runId: string): Promise<Artifact[]> {
    return structuredClone(this.artifacts.get(runId) ?? []);
  }

  async latestArtifact(runId: string, name: string): Promise<Artifact | null> {
    const matches = (this.artifacts.get(runId) ?? []).filter(
      (artifact) => artifact.name === name,
    );
    const latest = matches.at(-1);
    return latest ? structuredClone(latest) : null;
  }

  async addEvent(runId: string, type: string, data: unknown = {}): Promise<void> {
    const list = this.events.get(runId) ?? [];
    list.push({
      id: ++this.eventId,
      runId,
      type,
      data,
      createdAt: nowIso(),
    });
    this.events.set(runId, list);
  }

  async listEvents(runId: string): Promise<RunEvent[]> {
    return structuredClone(this.events.get(runId) ?? []);
  }

  async hasProcessedFeedback(
    runId: string,
    feedbackId: string,
  ): Promise<boolean> {
    return this.processedFeedback.has(`${runId}:${feedbackId}`);
  }

  async markFeedbackProcessed(
    runId: string,
    feedbackId: string,
    _kind: string,
  ): Promise<void> {
    this.processedFeedback.add(`${runId}:${feedbackId}`);
  }

  async enqueueJob(input: EnqueueJobInput): Promise<RunJob | null> {
    if (this.jobDedup.has(input.dedupKey)) return null;
    const at = nowIso();
    const job: RunJob = {
      id: crypto.randomUUID(),
      kind: input.kind,
      runId: input.runId,
      repo: input.repo,
      issueNumber: input.issueNumber ?? null,
      prNumber: input.prNumber ?? null,
      dedupKey: input.dedupKey,
      payload: input.payload ?? {},
      status: "pending",
      attempts: 0,
      availableAt: at,
      createdAt: at,
      claimedAt: null,
      finishedAt: null,
      lastError: null,
    };
    this.jobs.set(job.id, job);
    this.jobDedup.add(job.dedupKey);
    return structuredClone(job);
  }

  async claimNextJob(): Promise<RunJob | null> {
    const now = nowIso();
    const job = [...this.jobs.values()]
      .filter(
        (candidate) =>
          candidate.status === "pending" && candidate.availableAt <= now,
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!job) return null;
    job.status = "running";
    job.attempts += 1;
    job.claimedAt = now;
    return structuredClone(job);
  }

  async completeJob(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = "done";
    job.finishedAt = nowIso();
    job.lastError = null;
  }

  async retryJob(id: string, error: string, delayMs: number): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = "pending";
    job.lastError = error;
    job.claimedAt = null;
    job.availableAt = new Date(Date.now() + delayMs).toISOString();
  }

  async failJob(id: string, error: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    job.status = "failed";
    job.lastError = error;
    job.finishedAt = nowIso();
  }

  async resetRunningJobs(): Promise<number> {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.status !== "running") continue;
      job.status = "pending";
      job.claimedAt = null;
      job.availableAt = nowIso();
      count += 1;
    }
    return count;
  }

  private async update(id: string, patch: RunPatch): Promise<Run> {
    const current = this.runs.get(id);
    if (!current) throw new Error(`Run not found: ${id}`);
    if (patch.state && patch.state !== current.state) {
      assertTransition(current.state, patch.state);
    }
    const updated: Run = {
      ...current,
      ...(patch.state !== undefined ? { state: patch.state } : {}),
      ...(patch.repoUrl !== undefined ? { repoUrl: patch.repoUrl } : {}),
      ...(patch.baseBranch !== undefined ? { baseBranch: patch.baseBranch } : {}),
      ...(patch.setupCommand !== undefined
        ? { setupCommand: patch.setupCommand }
        : {}),
      ...(patch.testCommand !== undefined
        ? { testCommand: patch.testCommand }
        : {}),
      ...(patch.branch !== undefined ? { branch: patch.branch } : {}),
      ...(patch.worktree !== undefined ? { worktree: patch.worktree } : {}),
      ...(patch.reworkCount !== undefined
        ? { reworkCount: patch.reworkCount }
        : {}),
      ...(patch.prUrl !== undefined ? { prUrl: patch.prUrl } : {}),
      ...(patch.blockReason !== undefined
        ? { blockReason: patch.blockReason }
        : {}),
      ...(patch.finishedAt !== undefined
        ? { finishedAt: patch.finishedAt }
        : {}),
      updatedAt: nowIso(),
    };
    this.runs.set(id, updated);
    return structuredClone(updated);
  }
}
