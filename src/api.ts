import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { FactoryConfig } from "./config.ts";
import { repositoryFromUrl } from "./config.ts";
import type { TriggerWatcher } from "./trigger-watcher.ts";
import type { RunWorker } from "./run-worker.ts";
import type { RunStore } from "./ports.ts";
import type { AgentRuntimePort } from "./ports.ts";
import type { Logger } from "./logger.ts";
import type { GitHubIssuesBacklog } from "./backlog/github.ts";

export type ApiDependencies = {
  config: FactoryConfig;
  store: RunStore;
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
          "GET /api/runs",
          "GET /api/runs/:id",
          "POST /api/runs",
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
        const target = parseTarget(body.repoUrl, body.issueUrl);
        const baseBranch = parseBranch(body.baseBranch ?? "main");

        const ticket = await deps.backlog.getTicket(
          target.repository,
          target.issueNumber,
        );
        ticket.repo = target.repository;
        ticket.repoUrl = target.repoUrl;

        const run = await deps.store.createRun(ticket, {
          ownerUserId: userId,
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

        await deps.store.enqueueJob({
          kind: "start_issue",
          runId: run.id,
          repo: target.repository,
          issueNumber: target.issueNumber,
          dedupKey: `start_issue:${run.id}`,
          payload: { repository: target.repository, issueNumber: target.issueNumber },
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
