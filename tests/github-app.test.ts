import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, test } from "vitest";
import type { GithubConfig } from "../src/config.ts";
import { GitHubAppAuth } from "../src/github-app.ts";
import { Logger } from "../src/logger.ts";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const config: GithubConfig = {
  appId: "123456",
  privateKey,
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

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("GitHub App authentication", () => {
  test("generates an RS256 app JWT during validation", async () => {
    let authHeader = "";
    globalThis.fetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      const url = new URL(String(input));
      authHeader = new Headers(init?.headers).get("authorization") ?? "";
      if (url.pathname === "/app") {
        return Response.json({ slug: "software-factory-test" });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const auth = new GitHubAppAuth(config, new Logger({}, "error"));
    await expect(auth.validate()).resolves.toBeUndefined();
    expect(authHeader).toMatch(/^Bearer \S+\.\S+\.\S+$/);
  });

  test("resolves an installation and caches its installation token", async () => {
    const calls: Array<{ method: string; path: string; auth: string }> = [];
    globalThis.fetch = (async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      calls.push({
        method: init?.method ?? "GET",
        path: url.pathname,
        auth: headers.get("authorization") ?? "",
      });

      if (url.pathname === "/repos/acme/app/installation") {
        return Response.json({ id: 77 });
      }
      if (
        init?.method === "POST" &&
        url.pathname === "/app/installations/77/access_tokens"
      ) {
        return Response.json({
          token: "installation-token",
          expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        });
      }
      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const auth = new GitHubAppAuth(config, new Logger({}, "error"));
    expect(await auth.installationIdForRepository("acme/app")).toBe(77);
    expect(await auth.tokenForRepository("acme/app")).toBe(
      "installation-token",
    );
    expect(await auth.tokenForRepository("acme/app")).toBe(
      "installation-token",
    );

    expect(calls[0]?.path).toBe("/repos/acme/app/installation");
    expect(calls[0]?.auth).toMatch(/^Bearer \S+\.\S+\.\S+$/);
    expect(calls[1]?.path).toBe("/app/installations/77/access_tokens");
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });
});
