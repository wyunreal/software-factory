import type { FactoryConfig } from "./config.ts";
import { repositoryFromUrl } from "./config.ts";
import type { Orchestrator } from "./orchestrator.ts";
import type { RunStore } from "./ports.ts";
import type { AgentRuntimePort } from "./ports.ts";
import type { Logger } from "./logger.ts";
import type { GitHubIssuesBacklog } from "./backlog/github.ts";

export type ApiDependencies = {
  config: FactoryConfig;
  store: RunStore;
  orchestrator: Orchestrator;
  runtime: AgentRuntimePort & { health(): Promise<void> };
  backlog: GitHubIssuesBacklog;
  logger: Logger;
};

export function startApi(deps: ApiDependencies): ReturnType<typeof Bun.serve> {
  const log = deps.logger.child({ component: "api" });

  return Bun.serve({
    port: deps.config.port,
    hostname: "0.0.0.0",
    async fetch(request) {
      const url = new URL(request.url);

      if (!isAuthorized(request, url, deps.config)) {
        return json({ error: "unauthorized" }, 401);
      }

      if (request.method === "GET" && url.pathname === "/") {
        return json({
          name: "software-factory",
          endpoints: [
            "GET /health",
            "GET /api/status",
            "GET /api/runs",
            "GET /api/runs/:id",
            "POST /api/runs",
            "POST /api/tick",
          ],
        });
      }

      if (request.method === "GET" && url.pathname === "/health") {
        const opencode = await safeCheck(() => deps.runtime.health());
        const database = await safeCheck(() => deps.store.listRuns(1));
        const ok = opencode.ok && database.ok;
        return json(
          {
            status: ok ? "ok" : "degraded",
            database,
            opencode,
            orchestrator: deps.orchestrator.status(),
          },
          ok ? 200 : 503,
        );
      }

      if (request.method === "GET" && url.pathname === "/api/status") {
        return json(deps.orchestrator.status());
      }

      if (request.method === "GET" && url.pathname === "/api/runs") {
        const limit = clampLimit(url.searchParams.get("limit"));
        return json({ data: await deps.store.listRuns(limit) });
      }

      if (request.method === "POST" && url.pathname === "/api/runs") {
        try {
          const body = (await request.json()) as StartRunBody;
          const target = parseTarget(body.repoUrl, body.issueUrl);
          const baseBranch = parseBranch(body.baseBranch ?? "main");

          const ticket = await deps.backlog.getTicket(
            target.repository,
            target.issueNumber,
          );
          ticket.repo = target.repository;
          ticket.repoUrl = target.repoUrl;

          const run = await deps.store.createRun(ticket, {
            repoUrl: target.repoUrl,
            baseBranch,
            setupCommand: body.setupCommand ?? null,
            testCommand: body.testCommand ?? null,
          });
          if (!run) {
            return json(
              {
                error:
                  "An active run already exists for this issue. Wait for it to finish or check /api/runs.",
              },
              409,
            );
          }

          try {
            await deps.backlog.claim(ticket, run);
            await deps.store.addEvent(run.id, "backlog.claimed", {
              repository: target.repository,
              issueNumber: target.issueNumber,
            });
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            await deps.store.transition(run.id, "BLOCKED", {
              blockReason: `Could not claim issue: ${message}`,
              finishedAt: new Date().toISOString(),
            });
            return json({ error: `Could not claim issue: ${message}` }, 502);
          }

          void deps.orchestrator.workOnce().catch((error: unknown) => {
            log.error("failed to start manual run", {
              run: run.id,
              error: error instanceof Error ? error.message : String(error),
            });
          });

          return json({ data: run }, 201);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          log.warn("manual run request failed", { error: message });
          return json({ error: message }, 400);
        }
      }

      const match = /^\/api\/runs\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && match?.[1]) {
        const id = decodeURIComponent(match[1]);
        const run = await deps.store.getRun(id);
        if (!run) return json({ error: "run not found" }, 404);
        const [artifacts, events] = await Promise.all([
          deps.store.listArtifacts(id),
          deps.store.listEvents(id),
        ]);
        return json({ data: { ...run, artifacts, events } });
      }

      if (request.method === "POST" && url.pathname === "/api/tick") {
        void deps.orchestrator
          .syncNow()
          .then(() => deps.orchestrator.workOnce())
          .catch((error: unknown) => {
            log.warn("manual tick failed", {
              error: error instanceof Error ? error.message : String(error),
            });
          });
        return json({ accepted: true }, 202);
      }

      return json({ error: "not found" }, 404);
    },
  });
}

type StartRunBody = {
  repoUrl?: string;
  issueUrl?: string;
  baseBranch?: string;
  setupCommand?: string | null;
  testCommand?: string | null;
};

type RunTarget = {
  repository: string;
  repoUrl: string;
  issueNumber: number;
};

function parseTarget(
  repoUrlInput: string | undefined,
  issueUrlInput: string | undefined,
): RunTarget {
  if (!issueUrlInput?.trim()) {
    throw new Error("issueUrl is required");
  }

  const issue = parseIssueUrl(issueUrlInput);
  const repoUrl = normalizeRepoUrl(
    repoUrlInput?.trim() || `https://github.com/${issue.repository}.git`,
  );
  const repository = repositoryFromUrl(repoUrl);
  if (!repository) {
    throw new Error(`Invalid GitHub repository URL: ${repoUrl}`);
  }
  if (repository.toLowerCase() !== issue.repository.toLowerCase()) {
    throw new Error(
      `Repository mismatch: the issue is in ${issue.repository}, but repoUrl points to ${repository}`,
    );
  }

  return { repository, repoUrl, issueNumber: issue.issueNumber };
}

function parseIssueUrl(value: string): { repository: string; issueNumber: number } {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("issueUrl must be a full GitHub issue URL");
  }
  if (url.hostname !== "github.com") {
    throw new Error("Only github.com issue URLs are supported");
  }
  const match = /^\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/.exec(url.pathname);
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new Error(
      "issueUrl must look like https://github.com/owner/repo/issues/123",
    );
  }
  return {
    repository: `${match[1]}/${match[2]}`,
    issueNumber: Number.parseInt(match[3], 10),
  };
}

function normalizeRepoUrl(value: string): string {
  const raw = value.trim();
  if (!raw) throw new Error("repoUrl is required");

  if (/^[^/@\s]+\/[^/@\s]+$/.test(raw)) {
    return `https://github.com/${raw.replace(/\.git$/i, "")}.git`;
  }

  const ssh = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(raw);
  if (ssh?.[1] && ssh[2]) {
    return `https://github.com/${ssh[1]}/${ssh[2]}.git`;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("repoUrl must be a GitHub URL or owner/repo");
  }
  if (url.hostname !== "github.com") {
    throw new Error("Only github.com repositories are supported");
  }
  const repository = repositoryFromUrl(url.toString());
  if (!repository) {
    throw new Error(`Invalid GitHub repository URL: ${raw}`);
  }
  return `https://github.com/${repository}.git`;
}

function parseBranch(value: string): string {
  const branch = value.trim();
  if (
    !branch ||
    branch.startsWith("-") ||
    branch.includes("..") ||
    !/^[A-Za-z0-9._/-]+$/.test(branch)
  ) {
    throw new Error(`Invalid base branch: ${value}`);
  }
  return branch;
}

function isAuthorized(
  request: Request,
  url: URL,
  config: FactoryConfig,
): boolean {
  if (!config.apiToken) return true;
  if (!url.pathname.startsWith("/api")) return true;
  return request.headers.get("authorization") === `Bearer ${config.apiToken}`;
}

function clampLimit(raw: string | null): number {
  const value = Number.parseInt(raw ?? "50", 10);
  if (!Number.isFinite(value)) return 50;
  return Math.min(Math.max(value, 1), 200);
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

async function safeCheck(
  fn: () => Promise<unknown>,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await fn();
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
