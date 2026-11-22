import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import type { RunStore, RunPatch, CreateRunOptions } from "../ports.ts";
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
import { repositoryFromUrl } from "../config.ts";
import type { Logger } from "../logger.ts";

type Row = Record<string, unknown>;

export class PostgresRunStore implements RunStore {
  private readonly pool: Pool;

  constructor(
    databaseUrl: string,
    private readonly logger: Logger,
  ) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 10 });
  }

  async migrate(): Promise<void> {
    const schema = await readFile(
      new URL("./schema.sql", import.meta.url),
      "utf8",
    );
    await this.pool.query(schema);
    await this.backfillProjects();
    this.logger.info("database schema ready");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async createProject(input: {
    ownerUserId: string;
    name: string;
    repo: string;
    repoUrl: string;
  }): Promise<Project | null> {
    const id = `proj_${crypto.randomUUID()}`;
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO projects (id, owner_user_id, name, repo, repo_url)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        id,
        input.ownerUserId,
        input.name,
        input.repo.toLowerCase(),
        input.repoUrl,
      ],
    );
    return rows[0] ? mapProject(rows[0]) : null;
  }

  async listProjectsForUser(ownerUserId: string): Promise<Project[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT * FROM projects
        WHERE owner_user_id = $1
        ORDER BY created_at ASC`,
      [ownerUserId],
    );
    return rows.map(mapProject);
  }

  async getProjectForUser(
    id: string,
    ownerUserId: string,
  ): Promise<Project | null> {
    const { rows } = await this.pool.query<Row>(
      `SELECT * FROM projects
        WHERE id = $1 AND owner_user_id = $2
        LIMIT 1`,
      [id, ownerUserId],
    );
    return rows[0] ? mapProject(rows[0]) : null;
  }

  async listHumanReviewRunsForRepository(repo: string): Promise<Run[]> {
    // HUMAN_REVIEW is terminal for automation and therefore has finished_at
    // set, but the run still accepts PR activity (reviews, comments, merge).
    const { rows } = await this.pool.query<Row>(
      `SELECT r.* FROM runs r
        JOIN projects p
          ON p.id = r.project_id AND p.owner_user_id = r.owner_user_id
       WHERE lower(p.repo) = lower($1)
         AND r.state = 'HUMAN_REVIEW'
       ORDER BY r.created_at ASC`,
      [repo],
    );
    return rows.map(mapRun);
  }

  /**
   * Existing runs predate the projects concept. Group them by owner and
   * repository so they remain visible after the upgrade.
   */
  private async backfillProjects(): Promise<void> {
    const { rows } = await this.pool.query<{
      owner_user_id: string;
      repo_url: string;
    }>(
      `SELECT DISTINCT owner_user_id, repo_url
         FROM runs
        WHERE project_id IS NULL
          AND owner_user_id IS NOT NULL
          AND repo_url <> ''`,
    );

    for (const row of rows) {
      const repo = repositoryFromUrl(row.repo_url);
      if (!repo) continue;

      const existing = await this.pool.query<{ id: string }>(
        `SELECT id FROM projects
          WHERE owner_user_id = $1 AND lower(repo) = lower($2)
          LIMIT 1`,
        [row.owner_user_id, repo],
      );
      let projectId = existing.rows[0]?.id;
      if (!projectId) {
        const id = `proj_${createHash("sha1")
          .update(`${row.owner_user_id}|${repo.toLowerCase()}`)
          .digest("hex")
          .slice(0, 32)}`;
        await this.pool.query(
          `INSERT INTO projects (id, owner_user_id, name, repo, repo_url)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT DO NOTHING`,
          [
            id,
            row.owner_user_id,
            repo.toLowerCase(),
            repo.toLowerCase(),
            `https://github.com/${repo}.git`,
          ],
        );
        const created = await this.pool.query<{ id: string }>(
          `SELECT id FROM projects
            WHERE owner_user_id = $1 AND lower(repo) = lower($2)
            LIMIT 1`,
          [row.owner_user_id, repo],
        );
        projectId = created.rows[0]?.id;
      }

      if (projectId) {
        await this.pool.query(
          `UPDATE runs SET project_id = $1
            WHERE owner_user_id = $2 AND repo_url = $3 AND project_id IS NULL`,
          [projectId, row.owner_user_id, row.repo_url],
        );
      }
    }
  }

  async createRun(
    ticket: Ticket,
    options: CreateRunOptions,
  ): Promise<Run | null> {
    const id = crypto.randomUUID();
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO runs (
        id, owner_user_id, project_id, ticket_card_id, ticket_ref, ticket_title, ticket_description,
        ticket_url, ticket_labels, ticket_criteria, state,
        repo_url, base_branch, setup_command, test_command
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, 'CLAIMED',
        $11, $12, $13, $14
      )
      ON CONFLICT DO NOTHING
      RETURNING *`,
      [
        id,
        options.ownerUserId,
        options.projectId,
        ticket.cardId,
        ticket.ref,
        ticket.title,
        ticket.description,
        ticket.url,
        JSON.stringify(ticket.labels),
        JSON.stringify(ticket.acceptanceCriteria),
        options.repoUrl,
        options.baseBranch,
        options.setupCommand ?? null,
        options.testCommand ?? null,
      ],
    );
    const row = rows[0];
    return row ? mapRun(row) : null;
  }

  async getRun(id: string): Promise<Run | null> {
    const { rows } = await this.pool.query<Row>(
      "SELECT * FROM runs WHERE id = $1",
      [id],
    );
    return rows[0] ? mapRun(rows[0]) : null;
  }

  async listRunsForUser(ownerUserId: string, limit: number): Promise<Run[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT * FROM runs
        WHERE owner_user_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [ownerUserId, limit],
    );
    return rows.map(mapRun);
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async listRunsByState(state: RunState): Promise<Run[]> {
    const { rows } = await this.pool.query<Row>(
      "SELECT * FROM runs WHERE state = $1 ORDER BY created_at ASC",
      [state],
    );
    return rows.map(mapRun);
  }

  async claimNext(): Promise<Run | null> {
    const { rows } = await this.pool.query<Row>(
      `SELECT * FROM runs
       WHERE finished_at IS NULL AND state NOT IN ('DONE', 'BLOCKED')
       ORDER BY created_at ASC
       LIMIT 1`,
    );
    return rows[0] ? mapRun(rows[0]) : null;
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
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO artifacts (run_id, name, agent, content, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING *`,
      [
        runId,
        artifact.name,
        artifact.agent,
        artifact.content,
        JSON.stringify(artifact.metadata ?? {}),
      ],
    );
    const row = rows[0];
    if (!row) throw new Error("Failed to insert artifact");
    return mapArtifact(row);
  }

  async listArtifacts(runId: string): Promise<Artifact[]> {
    const { rows } = await this.pool.query<Row>(
      "SELECT * FROM artifacts WHERE run_id = $1 ORDER BY created_at ASC, id ASC",
      [runId],
    );
    return rows.map(mapArtifact);
  }

  async latestArtifact(runId: string, name: string): Promise<Artifact | null> {
    const { rows } = await this.pool.query<Row>(
      `SELECT * FROM artifacts
       WHERE run_id = $1 AND name = $2
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [runId, name],
    );
    return rows[0] ? mapArtifact(rows[0]) : null;
  }

  async addEvent(runId: string, type: string, data: unknown = {}): Promise<void> {
    await this.pool.query(
      `INSERT INTO run_events (run_id, type, data)
       VALUES ($1, $2, $3::jsonb)`,
      [runId, type, JSON.stringify(data ?? {})],
    );
  }

  async listEvents(runId: string): Promise<RunEvent[]> {
    const { rows } = await this.pool.query<Row>(
      "SELECT * FROM run_events WHERE run_id = $1 ORDER BY id ASC",
      [runId],
    );
    return rows.map((row) => ({
      id: Number(row.id),
      runId: String(row.run_id),
      type: String(row.type),
      data: parseJson(row.data),
      createdAt: iso(row.created_at),
    }));
  }

  async hasProcessedFeedback(
    runId: string,
    feedbackId: string,
  ): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT 1 FROM processed_feedback
       WHERE run_id = $1 AND feedback_id = $2
       LIMIT 1`,
      [runId, feedbackId],
    );
    return rows.length > 0;
  }

  async markFeedbackProcessed(
    runId: string,
    feedbackId: string,
    kind: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO processed_feedback (run_id, feedback_id, kind)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [runId, feedbackId, kind],
    );
  }

  async enqueueJob(input: EnqueueJobInput): Promise<RunJob | null> {
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO run_jobs (
         id, kind, run_id, repo, issue_number, pr_number, dedup_key, payload
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       ON CONFLICT (dedup_key) DO NOTHING
       RETURNING *`,
      [
        crypto.randomUUID(),
        input.kind,
        input.runId,
        input.repo,
        input.issueNumber ?? null,
        input.prNumber ?? null,
        input.dedupKey,
        JSON.stringify(input.payload ?? {}),
      ],
    );
    return rows[0] ? mapJob(rows[0]) : null;
  }

  async claimNextJob(): Promise<RunJob | null> {
    const { rows } = await this.pool.query<Row>(
      `UPDATE run_jobs
       SET status = 'running', claimed_at = now(), attempts = attempts + 1
       WHERE id = (
         SELECT id FROM run_jobs
         WHERE status = 'pending' AND available_at <= now()
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       RETURNING *`,
    );
    return rows[0] ? mapJob(rows[0]) : null;
  }

  async completeJob(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE run_jobs
       SET status = 'done', finished_at = now(), last_error = NULL
       WHERE id = $1`,
      [id],
    );
  }

  async retryJob(id: string, error: string, delayMs: number): Promise<void> {
    await this.pool.query(
      `UPDATE run_jobs
       SET status = 'pending',
           last_error = $2,
           claimed_at = NULL,
           available_at = now() + ($3::numeric / 1000) * interval '1 second'
       WHERE id = $1`,
      [id, error, delayMs],
    );
  }

  async failJob(id: string, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE run_jobs
       SET status = 'failed', last_error = $2, finished_at = now()
       WHERE id = $1`,
      [id, error],
    );
  }

  async resetRunningJobs(): Promise<number> {
    const { rowCount } = await this.pool.query(
      `UPDATE run_jobs
       SET status = 'pending', claimed_at = NULL, available_at = now()
       WHERE status = 'running'`,
    );
    return rowCount ?? 0;
  }

  private async update(id: string, patch: RunPatch): Promise<Run> {
    const current = await this.getRun(id);
    if (!current) throw new Error(`Run not found: ${id}`);
    if (patch.state && patch.state !== current.state) {
      assertTransition(current.state, patch.state);
    }

    const columns: string[] = [];
    const values: unknown[] = [];
    const add = (column: string, value: unknown): void => {
      columns.push(column);
      values.push(value);
    };

    if (patch.state !== undefined) add("state", patch.state);
    if (patch.repoUrl !== undefined) add("repo_url", patch.repoUrl);
    if (patch.baseBranch !== undefined) add("base_branch", patch.baseBranch);
    if (patch.setupCommand !== undefined) add("setup_command", patch.setupCommand);
    if (patch.testCommand !== undefined) add("test_command", patch.testCommand);
    if (patch.branch !== undefined) add("branch", patch.branch);
    if (patch.worktree !== undefined) add("worktree", patch.worktree);
    if (patch.reworkCount !== undefined) add("rework_count", patch.reworkCount);
    if (patch.prUrl !== undefined) add("pr_url", patch.prUrl);
    if (patch.blockReason !== undefined) add("block_reason", patch.blockReason);
    if (patch.finishedAt !== undefined) add("finished_at", patch.finishedAt);

    if (columns.length === 0) return current;

    values.push(id);
    const assignments = columns.map(
      (column, index) => `${column} = $${index + 1}`,
    );
    const { rows } = await this.pool.query<Row>(
      `UPDATE runs SET ${assignments.join(", ")}, updated_at = now()
       WHERE id = $${values.length} RETURNING *`,
      values,
    );
    const row = rows[0];
    if (!row) throw new Error(`Run not found after update: ${id}`);
    return mapRun(row);
  }
}

function mapProject(row: Row): Project {
  return {
    id: String(row.id),
    ownerUserId: String(row.owner_user_id),
    name: String(row.name),
    repo: String(row.repo),
    repoUrl: String(row.repo_url),
    createdAt: iso(row.created_at),
  };
}

function mapRun(row: Row): Run {
  const repoUrl = String(row.repo_url ?? "");
  const ticketRef = String(row.ticket_ref);
  const refMatch = /^GH-(\d+)$/i.exec(ticketRef);
  return {
    id: String(row.id),
    ownerUserId: nullableString(row.owner_user_id),
    projectId: nullableString(row.project_id),
    ticket: {
      cardId: String(row.ticket_card_id),
      ref: ticketRef,
      title: String(row.ticket_title),
      description: String(row.ticket_description ?? ""),
      url: String(row.ticket_url ?? ""),
      labels: parseJsonArray(row.ticket_labels),
      acceptanceCriteria: parseJsonArray(row.ticket_criteria),
      number: refMatch?.[1] ? Number(refMatch[1]) : undefined,
      repo: repositoryFromUrl(repoUrl) ?? undefined,
      repoUrl,
    },
    state: String(row.state) as RunState,
    repoUrl,
    baseBranch: String(row.base_branch ?? "main"),
    setupCommand: nullableString(row.setup_command),
    testCommand: nullableString(row.test_command),
    branch: nullableString(row.branch),
    worktree: nullableString(row.worktree),
    reworkCount: Number(row.rework_count ?? 0),
    prUrl: nullableString(row.pr_url),
    blockReason: nullableString(row.block_reason),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    finishedAt: row.finished_at ? iso(row.finished_at) : null,
  };
}

function mapJob(row: Row): RunJob {  return {
    id: String(row.id),
    kind: String(row.kind) as RunJobKind,
    runId: String(row.run_id),
    repo: String(row.repo),
    issueNumber: row.issue_number === null ? null : Number(row.issue_number),
    prNumber: row.pr_number === null ? null : Number(row.pr_number),
    dedupKey: String(row.dedup_key),
    payload: parseJson(row.payload),
    status: String(row.status) as RunJobStatus,
    attempts: Number(row.attempts ?? 0),
    availableAt: iso(row.available_at),
    createdAt: iso(row.created_at),
    claimedAt: row.claimed_at ? iso(row.claimed_at) : null,
    finishedAt: row.finished_at ? iso(row.finished_at) : null,
    lastError: nullableString(row.last_error),
  };
}

function mapArtifact(row: Row): Artifact {
  return {
    id: Number(row.id),
    runId: String(row.run_id),
    name: String(row.name),
    agent: nullableString(row.agent),
    content: String(row.content),
    metadata: parseJson(row.metadata),
    createdAt: iso(row.created_at),
  };
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parseJsonArray(value: unknown): string[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed.map(String) : [];
}
