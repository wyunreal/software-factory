import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { FactoryConfig } from "./config.ts";
import { repositoryFromUrl } from "./config.ts";
import type { TriggerWatcher } from "./trigger-watcher.ts";
import type { RunWorker } from "./run-worker.ts";
import type { RunStore } from "./ports.ts";
import type { AgentRuntimePort, GitHubAuthPort } from "./ports.ts";
import type { Logger } from "./logger.ts";
import type { GitHubIssuesBacklog } from "./backlog/github.ts";
import { parseGithubEvent } from "./backlog/github-events.ts";
import { pullRequestNumberFromUrl } from "./scm/approvals.ts";

export type ApiDependencies = {
  config: FactoryConfig;
  store: RunStore;
  githubAuth: GitHubAuthPort;
  watcher: TriggerWatcher;
  worker: RunWorker;
  runtime: AgentRuntimePort & { health(): Promise<void> };
  backlog: GitHubIssuesBacklog;
  logger: Logger;
};

export type ApiServer = {
  stop(force?: boolean): void;
};

export async function startApi(deps: ApiDependencies): Promise<ApiServer> {
  const log = deps.logger.child({ component: "api" });

  const handleRequest = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (!isAuthorized(request, deps.config)) {
      return json(
        { error: "unauthorized" },
        401,
        { "www-authenticate": "Bearer" },
      );
    }

    if (request.method === "GET" && url.pathname === "/") {
      return json({
        name: "software-factory",
        endpoints: [
          "GET /health",
          "GET /api/status",
          "GET /api/projects",
          "POST /api/projects",
          "POST /api/github/installations",
          "GET /api/runs",
          "GET /api/runs/:id",
          "POST /api/runs",
          "POST /api/github/events",
          "POST /api/tick",
        ],
      });
    }

    if (request.method === "GET" && url.pathname === "/health") {
      const opencode = await safeCheck(() => deps.runtime.health());
      const database = await safeCheck(() => deps.store.ping());
      const ok = opencode.ok && database.ok;
      return json(
        {
          status: ok ? "ok" : "degraded",
          database,
          opencode,
          triggers: deps.watcher.status(),
          worker: deps.worker.status(),
        },
        ok ? 200 : 503,
      );
    }

    if (request.method === "GET" && url.pathname === "/api/status") {
      return json({
        triggers: deps.watcher.status(),
        worker: deps.worker.status(),
      });
    }

    if (request.method === "GET" && url.pathname === "/api/projects") {
      const userId = requestUserId(request);
      if (!userId) return missingUser();
      return json({ data: await deps.store.listProjectsForUser(userId) });
    }

    if (request.method === "POST" && url.pathname === "/api/projects") {
      const userId = requestUserId(request);
      if (!userId) return missingUser();
      try {
        const body = (await request.json()) as CreateProjectBody;
        const name = parseProjectName(body.name);
        const repoUrl = normalizeRepoUrl(body.repoUrl ?? "");
        const repo = repositoryFromUrl(repoUrl);
        if (!repo) throw new Error(`Invalid GitHub repository URL: ${repoUrl}`);

        const installationId =
          await deps.githubAuth.installationIdForRepository(repo);
        if (!installationId) {
          return json(
            {
              error:
                "The GitHub App is not installed on this repository. Install it to create the project.",
              code: "github_app_not_installed",
              repo,
            },
            428,
          );
        }

        const project = await deps.store.createProject({
          ownerUserId: userId,
          name,
          repo,
          repoUrl,
        });
        if (!project) {
          return json(
            {
              error:
                "A project with that name or repository already exists for this user.",
            },
            409,
          );
        }
        return json({ data: project }, 201);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        log.warn("project creation failed", { error: message });
        return json({ error: message }, 400);
      }
    }

    if (request.method === "POST" && url.pathname === "/api/github/installations") {
      const userId = requestUserId(request);
      if (!userId) return missingUser();
      try {
        const body = (await request.json()) as InstallAppBody;
        const installationId = Number(body.installationId);
        if (!Number.isInteger(installationId) || installationId <= 0) {
          throw new Error("installationId is required");
        }
        const name = parseProjectName(body.name);
        const repoUrl = normalizeRepoUrl(body.repoUrl ?? "");
        const repo = repositoryFromUrl(repoUrl);
        if (!repo) throw new Error(`Invalid GitHub repository URL: ${repoUrl}`);

        const resolved =
          await deps.githubAuth.installationIdForRepository(repo);
        if (resolved !== installationId) {
          return json(
            {
              error:
                "The GitHub App installation does not have access to this repository.",
              code: "github_app_repository_not_accessible",
              repo,
            },
            403,
          );
        }

        const project = await deps.store.createProject({
          ownerUserId: userId,
          name,
          repo,
          repoUrl,
        });
        if (!project) {
          return json(
            {
              error:
                "A project with that name or repository already exists for this user.",
            },
            409,
          );
        }
        return json({ data: project }, 201);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        log.warn("github installation project creation failed", {
          error: message,
        });
        return json({ error: message }, 400);
      }
    }

    if (request.method === "GET" && url.pathname === "/api/runs") {
      const userId = requestUserId(request);
      if (!userId) return missingUser();
      const limit = clampLimit(url.searchParams.get("limit"));
      return json({ data: await deps.store.listRunsForUser(userId, limit) });
    }

    if (request.method === "POST" && url.pathname === "/api/runs") {
      const userId = requestUserId(request);
      if (!userId) return missingUser();
      try {
        const body = (await request.json()) as StartRunBody;
        const projectId = body.projectId?.trim();
        if (!projectId) throw new Error("projectId is required");

        const project = await deps.store.getProjectForUser(projectId, userId);
        if (!project) return json({ error: "project not found" }, 404);

        const installationId =
          await deps.githubAuth.installationIdForRepository(project.repo);
        if (!installationId) {
          return json(
            {
              error:
                "The GitHub App no longer has access to this repository. Reinstall or grant access before launching a run.",
              code: "github_app_not_installed",
              repo: project.repo,
            },
            428,
          );
        }

        const issue = parseIssueUrl(body.issueUrl ?? "");
        if (issue.repository.toLowerCase() !== project.repo.toLowerCase()) {
          throw new Error(
            `The issue belongs to ${issue.repository}, not to project repository ${project.repo}`,
          );
        }

        const baseBranch = parseBranch(body.baseBranch ?? "main");
        const ticket = await deps.backlog.getTicket(
          project.repo,
          issue.issueNumber,
        );
        ticket.repo = project.repo;
        ticket.repoUrl = project.repoUrl;

        const run = await deps.store.createRun(ticket, {
          ownerUserId: userId,
          projectId: project.id,
          repoUrl: project.repoUrl,
          baseBranch,
          setupCommand: body.setupCommand ?? null,
          testCommand: body.testCommand ?? null,
        });
        if (!run) {
          return json(
            {
              error:
                "An active run already exists for this issue in this project. Wait for it to finish or check /api/runs.",
            },
            409,
          );
        }

        try {
          await deps.backlog.claim(ticket, run);
          await deps.store.addEvent(run.id, "backlog.claimed", {
            repository: project.repo,
            issueNumber: issue.issueNumber,
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

        await deps.store.enqueueJob({
          kind: "start_issue",
          runId: run.id,
          repo: project.repo,
          issueNumber: issue.issueNumber,
          dedupKey: `start_issue:${run.id}`,
          payload: { repository: project.repo, issueNumber: issue.issueNumber },
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
      const userId = requestUserId(request);
      if (!userId) return missingUser();
      const id = decodeURIComponent(match[1]);
      const run = await deps.store.getRun(id);
      if (!run || run.ownerUserId !== userId) {
        return json({ error: "run not found" }, 404);
      }
      const [artifacts, events] = await Promise.all([
        deps.store.listArtifacts(id),
        deps.store.listEvents(id),
      ]);
      return json({ data: { ...run, artifacts, events } });
    }

    if (request.method === "POST" && url.pathname === "/api/github/events") {
      return handleGithubEvent(request, deps);
    }

    if (request.method === "POST" && url.pathname === "/api/tick") {
      void deps.watcher
        .syncNow()
        .then(() => deps.worker.workOnce())
        .catch((error: unknown) => {
          log.warn("manual tick failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return json({ accepted: true }, 202);
    }

    return json({ error: "not found" }, 404);
  };

  const server = createServer((req, res) => {
    void respond(req, res, handleRequest, log);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(deps.config.port, "0.0.0.0", () => resolve());
  });

  return {
    stop(force = false): void {
      server.close();
      if (force) server.closeAllConnections();
    },
  };
}

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

async function respond(
  req: IncomingMessage,
  res: ServerResponse,
  handler: (request: Request) => Promise<Response>,
  log: Logger,
): Promise<void> {
  try {
    const request = await toRequest(req);
    const response = await handler(request);
    await sendResponse(res, response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof HttpError ? error.status : 500;
    if (status >= 500) log.error("api request failed", { error: message });
    await sendResponse(res, json({ error: message }, status));
  }
}

async function toRequest(req: IncomingMessage): Promise<Request> {
  const origin = `http://${req.headers.host ?? "127.0.0.1"}`;
  const method = req.method ?? "GET";
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (key === "host" || key === "connection") continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(new URL(req.url ?? "/", origin), {
    method,
    headers,
    body: hasBody ? await readBody(req) : undefined,
  });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  const limit = 2 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, "request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function sendResponse(
  res: ServerResponse,
  response: Response,
): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  const body = Buffer.from(await response.arrayBuffer());
  res.end(body.length > 0 ? body : undefined);
}

/**
 * Internal, token-protected intake for GitHub webhook deliveries. The public
 * webhook route in the webapp verifies the GitHub signature and forwards the
 * event here; this handler only maps the event to owned runs and enqueues jobs.
 */
async function handleGithubEvent(
  request: Request,
  deps: ApiDependencies,
): Promise<Response> {
  const event = request.headers.get("x-github-event")?.trim() ?? "";
  const delivery = request.headers.get("x-github-delivery")?.trim() ?? "";
  if (!event || !delivery) {
    return json({ error: "missing github event headers" }, 400);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "invalid github payload" }, 400);
  }

  const parsed = parseGithubEvent(event, payload);
  if (!parsed) {
    return json({ accepted: true, ignored: true, enqueued: 0 }, 202);
  }

  const runs = await deps.store.listHumanReviewRunsForRepository(
    parsed.repository,
  );
  let enqueued = 0;

  for (const run of runs) {
    const prNumber = run.prUrl ? pullRequestNumberFromUrl(run.prUrl) : null;
    const matchesPr =
      parsed.prNumbers.length > 0 &&
      prNumber !== null &&
      parsed.prNumbers.includes(prNumber);
    const matchesBranch =
      parsed.branches.length > 0 &&
      run.branch !== null &&
      parsed.branches.includes(run.branch);
    if (!matchesPr && !matchesBranch) continue;

    const job = await deps.store.enqueueJob({
      kind: "pr_sync",
      runId: run.id,
      repo: parsed.repository,
      issueNumber: run.ticket.number ?? null,
      prNumber,
      dedupKey: `github:${delivery}:${run.id}`,
      payload: {
        source: "github-webhook",
        event: parsed.event,
        action: parsed.action,
        delivery,
        repository: parsed.repository,
        prNumber,
      },
    });
    if (job) enqueued += 1;
  }

  return json(
    {
      accepted: true,
      event: parsed.event,
      action: parsed.action,
      enqueued,
    },
    202,
  );
}

type StartRunBody = {
  projectId?: string;
  issueUrl?: string;
  baseBranch?: string;
  setupCommand?: string | null;
  testCommand?: string | null;
};

type CreateProjectBody = {
  name?: string;
  repoUrl?: string;
};

type InstallAppBody = CreateProjectBody & {
  installationId?: number | string;
};

function parseProjectName(value: string | undefined): string {
  const name = value?.trim() ?? "";
  if (!name) throw new Error("name is required");
  if (name.length > 80) throw new Error("name must be at most 80 characters");
  return name;
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

function isAuthorized(request: Request, config: FactoryConfig): boolean {
  const header = request.headers.get("authorization")?.trim() ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const provided = match?.[1]?.trim();
  if (!provided) return false;
  return constantTimeEqual(provided, config.apiToken);
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * The webapp forwards the authenticated NextAuth user id on behalf of the
 * browser. The service token authenticates the webapp; this header scopes data
 * to one user. Never trust a header forwarded directly by a browser.
 */
function requestUserId(request: Request): string | null {
  const value = request.headers.get("x-factory-user-id")?.trim() ?? "";
  if (!value || value.length > 128 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return null;
  }
  return value;
}

function missingUser(): Response {
  return json({ error: "missing user context" }, 401);
}

function clampLimit(raw: string | null): number {
  const value = Number.parseInt(raw ?? "50", 10);
  if (!Number.isFinite(value)) return 50;
  return Math.min(Math.max(value, 1), 200);
}

function json(
  body: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
  return Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
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
