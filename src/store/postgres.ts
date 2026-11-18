import { SQL } from "bun";
import type { RunStore, RunPatch, CreateRunOptions } from "../ports.ts";
import type {
  Artifact,
  Run,
  RunEvent,
  RunState,
  Ticket,
} from "../domain/types.ts";
import { assertTransition } from "../domain/state.ts";
import { repositoryFromUrl } from "../config.ts";
import type { Logger } from "../logger.ts";

type Row = Record<string, unknown>;

export class PostgresRunStore implements RunStore {
  private readonly sql: SQL;

  constructor(
    databaseUrl: string,
    private readonly logger: Logger,
  ) {
    this.sql = new SQL({ url: databaseUrl, max: 10 });
  }

  async migrate(): Promise<void> {
    const schema = await Bun.file(
      new URL("./schema.sql", import.meta.url),
    ).text();
    await this.sql.unsafe(schema);
    this.logger.info("database schema ready");
  }

  async close(): Promise<void> {
    await this.sql.close();
  }

  async createRun(
    ticket: Ticket,
    options: CreateRunOptions,
  ): Promise<Run | null> {
    const id = crypto.randomUUID();
    const rows = await this.sql`
      INSERT INTO runs (
        id, ticket_card_id, ticket_ref, ticket_title, ticket_description,
        ticket_url, ticket_labels, ticket_criteria, state,
        repo_url, base_branch, setup_command, test_command
      ) VALUES (
        ${id}, ${ticket.cardId}, ${ticket.ref}, ${ticket.title},
        ${ticket.description}, ${ticket.url},
        ${JSON.stringify(ticket.labels)}::jsonb,
        ${JSON.stringify(ticket.acceptanceCriteria)}::jsonb,
        'CLAIMED',
        ${options.repoUrl}, ${options.baseBranch},
        ${options.setupCommand ?? null}, ${options.testCommand ?? null}
      )
      ON CONFLICT DO NOTHING
      RETURNING *
    `;
    const row = rows[0];
    return row ? mapRun(row) : null;
  }

  async getRun(id: string): Promise<Run | null> {
    const rows = await this.sql`SELECT * FROM runs WHERE id = ${id}`;
    return rows[0] ? mapRun(rows[0]) : null;
  }

  async listRuns(limit: number): Promise<Run[]> {
    const rows = await this.sql`
      SELECT * FROM runs ORDER BY created_at DESC LIMIT ${limit}
    `;
    return rows.map(mapRun);
  }

  async listRunsByState(state: RunState): Promise<Run[]> {
    const rows = await this.sql`
      SELECT * FROM runs WHERE state = ${state} ORDER BY created_at ASC
    `;
    return rows.map(mapRun);
  }

  async claimNext(): Promise<Run | null> {
    const rows = await this.sql`
      SELECT * FROM runs
      WHERE finished_at IS NULL AND state NOT IN ('DONE', 'BLOCKED')
      ORDER BY created_at ASC
      LIMIT 1
    `;
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
    const rows = await this.sql`
      INSERT INTO artifacts (run_id, name, agent, content, metadata)
      VALUES (
        ${runId}, ${artifact.name}, ${artifact.agent}, ${artifact.content},
        ${JSON.stringify(artifact.metadata ?? {})}::jsonb
      )
      RETURNING *
    `;
    const row = rows[0];
    if (!row) throw new Error("Failed to insert artifact");
    return mapArtifact(row);
  }

  async listArtifacts(runId: string): Promise<Artifact[]> {
    const rows = await this.sql`
      SELECT * FROM artifacts WHERE run_id = ${runId} ORDER BY created_at ASC, id ASC
    `;
    return rows.map(mapArtifact);
  }

  async latestArtifact(runId: string, name: string): Promise<Artifact | null> {
    const rows = await this.sql`
      SELECT * FROM artifacts
      WHERE run_id = ${runId} AND name = ${name}
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `;
    return rows[0] ? mapArtifact(rows[0]) : null;
  }

  async addEvent(runId: string, type: string, data: unknown = {}): Promise<void> {
    await this.sql`
      INSERT INTO run_events (run_id, type, data)
      VALUES (${runId}, ${type}, ${JSON.stringify(data ?? {})}::jsonb)
    `;
  }

  async listEvents(runId: string): Promise<RunEvent[]> {
    const rows = (await this.sql`
      SELECT * FROM run_events WHERE run_id = ${runId} ORDER BY id ASC
    `) as Row[];
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
    const rows = await this.sql`
      SELECT 1 FROM processed_feedback
      WHERE run_id = ${runId} AND feedback_id = ${feedbackId}
      LIMIT 1
    `;
    return rows.length > 0;
  }

  async markFeedbackProcessed(
    runId: string,
    feedbackId: string,
    kind: string,
  ): Promise<void> {
    await this.sql`
      INSERT INTO processed_feedback (run_id, feedback_id, kind)
      VALUES (${runId}, ${feedbackId}, ${kind})
      ON CONFLICT DO NOTHING
    `;
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
    const rows = await this.sql.unsafe(
      `UPDATE runs SET ${assignments.join(", ")}, updated_at = now()
       WHERE id = $${values.length} RETURNING *`,
      values,
    );
    const row = rows[0] as Row | undefined;
    if (!row) throw new Error(`Run not found after update: ${id}`);
    return mapRun(row);
  }
}

function mapRun(row: Row): Run {
  const repoUrl = String(row.repo_url ?? "");
  const ticketRef = String(row.ticket_ref);
  const refMatch = /^GH-(\d+)$/i.exec(ticketRef);
  return {
    id: String(row.id),
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
