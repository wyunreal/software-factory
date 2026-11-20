import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { GitHubIssuesBacklog } from "../src/backlog/github.ts";
import type { GithubConfig } from "../src/config.ts";
import type { Run, Ticket } from "../src/domain/types.ts";
import type { GitHubAuthPort } from "../src/ports.ts";
import { Logger } from "../src/logger.ts";

const config: GithubConfig = {
  appId: "123456",
  privateKey: "test-key",
  slug: "software-factory-test",
  apiUrl: "https://api.github.com",
  draft: false,
  labels: {
    inProgress: "factory:in-progress",
    inReview: "factory:in-review",
    blocked: "factory:blocked",
    ready: null,
    skip: ["factory:skip"],
  },
};

let validateCalls = 0;
const auth: GitHubAuthPort = {
  validate: async () => {
    validateCalls += 1;
  },
  installationIdForRepository: async () => 1,
  tokenForRepository: async () => "test-token",
};

const issues = [
  {
    id: 1001,
    number: 1,
    title: "Add login",
    body: "Implement login\n\n## Acceptance criteria\n- [ ] Users can log in\n",
    html_url: "https://github.com/acme/app/issues/1",
    state: "open",
    labels: [],
  },
  {
    id: 1002,
    number: 2,
    title: "A pull request",
    body: "",
    html_url: "https://github.com/acme/app/pull/2",
    state: "open",
    labels: [],
    pull_request: {},
  },
  {
    id: 1003,
    number: 3,
    title: "Skip me",
    body: "",
    html_url: "https://github.com/acme/app/issues/3",
    state: "open",
    labels: [{ name: "factory:skip" }],
  },
  {
    id: 1004,
    number: 4,
    title: "Already in progress",
    body: "",
    html_url: "https://github.com/acme/app/issues/4",
    state: "open",
    labels: [{ name: "factory:in-progress" }],
  },
];

const calls: Array<{ method: string; path: string; body: unknown }> = [];
let issueState = "open";
const originalFetch = globalThis.fetch;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeAll(() => {
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, path, body });

    if (method === "GET" && path === "/user") {
      return json({ login: "factory-bot" });
    }
    if (method === "GET" && path === "/repos/acme/app") {
      return json({ full_name: "acme/app" });
    }
    if (method === "POST" && path === "/repos/acme/app/labels") {
      return json(body, 201);
    }
    if (method === "GET" && path === "/repos/acme/app/issues") {
      return json(issues);
    }
    if (method === "GET" && path === "/repos/acme/app/issues/1") {
      return json({ ...issues[0], state: issueState });
    }
    if (method === "POST" && path === "/repos/acme/app/issues/1/labels") {
      return json([]);
    }
    if (method === "DELETE" && path.startsWith("/repos/acme/app/issues/1/labels/")) {
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && path === "/repos/acme/app/issues/1/comments") {
      return json({ id: 1 }, 201);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

describe("GitHub Issues backlog adapter", () => {
  test("validates the GitHub App credentials", async () => {
    const before = validateCalls;
    const backlog = new GitHubIssuesBacklog(config, auth, new Logger({}, "error"));
    await backlog.validate();
    expect(validateCalls).toBe(before + 1);
  });

  test("fetches a ticket and creates the required labels", async () => {
    const backlog = new GitHubIssuesBacklog(config, auth, new Logger({}, "error"));
    const ticket = await backlog.getTicket("acme/app", 1);
    expect(ticket.ref).toBe("GH-1");
    expect(ticket.number).toBe(1);
    expect(ticket.repo).toBe("acme/app");
    expect(ticket.acceptanceCriteria).toEqual(["Users can log in"]);

    const created = calls
      .filter((call) => call.method === "POST" && call.path.endsWith("/labels"))
      .map((call) => (call.body as { name: string }).name);
    expect(created).toContain("factory:in-progress");
    expect(created).toContain("factory:in-review");
    expect(created).toContain("factory:blocked");
    expect(created).toContain("factory:skip");
  });

  test("claims an issue with a label and a comment", async () => {
    const backlog = new GitHubIssuesBacklog(config, auth, new Logger({}, "error"));
    const ticket: Ticket = {
      cardId: "1001",
      number: 1,
      ref: "GH-1",
      title: "Add login",
      description: "",
      url: "https://github.com/acme/app/issues/1",
      labels: [],
      acceptanceCriteria: [],
      repo: "acme/app",
    };
    const run = { id: "run-123" } as Run;

    await backlog.claim(ticket, run);

    const labelCall = calls.find(
      (call) =>
        call.method === "POST" && call.path === "/repos/acme/app/issues/1/labels",
    );
    expect(labelCall?.body).toEqual({ labels: ["factory:in-progress"] });
    const comment = calls.find(
      (call) =>
        call.method === "POST" &&
        call.path === "/repos/acme/app/issues/1/comments",
    );
    expect(JSON.stringify(comment?.body)).toContain("run-123");
  });

  test("detects done issues", async () => {
    const backlog = new GitHubIssuesBacklog(config, auth, new Logger({}, "error"));
    const ticket: Ticket = {
      cardId: "1001",
      number: 1,
      ref: "GH-1",
      title: "Add login",
      description: "",
      url: "",
      labels: [],
      acceptanceCriteria: [],
      repo: "acme/app",
    };
    issueState = "open";
    expect(await backlog.isDone(ticket)).toBe(false);
    issueState = "closed";
    expect(await backlog.isDone(ticket)).toBe(true);
  });
});
