import { describe, expect, test } from "vitest";
import { parseGithubEvent } from "../src/backlog/github-events.ts";

const repository = { full_name: "Acme/App" };

describe("GitHub webhook event parsing", () => {
  test("maps pull request, review and comment events to a PR", () => {
    expect(
      parseGithubEvent("pull_request", {
        action: "synchronize",
        repository,
        pull_request: { number: 42 },
      }),
    ).toMatchObject({
      repository: "acme/app",
      prNumbers: [42],
      branches: [],
    });

    expect(
      parseGithubEvent("pull_request_review", {
        action: "submitted",
        repository,
        pull_request: { number: 42 },
        review: { state: "APPROVED" },
      })?.prNumbers,
    ).toEqual([42]);

    expect(
      parseGithubEvent("pull_request_review_comment", {
        action: "created",
        repository,
        pull_request: { number: 42 },
        comment: { id: 1 },
      })?.prNumbers,
    ).toEqual([42]);

    expect(
      parseGithubEvent("issue_comment", {
        action: "created",
        repository,
        issue: { number: 42, pull_request: { url: "..." } },
      })?.prNumbers,
    ).toEqual([42]);
  });

  test("ignores issue comments that are not on a pull request", () => {
    expect(
      parseGithubEvent("issue_comment", {
        action: "created",
        repository,
        issue: { number: 7 },
      }),
    ).toBeNull();
  });

  test("maps check suites and commit statuses", () => {
    expect(
      parseGithubEvent("check_suite", {
        action: "completed",
        repository,
        check_suite: { pull_requests: [{ number: 42 }, { number: 43 }] },
      })?.prNumbers,
    ).toEqual([42, 43]);

    const status = parseGithubEvent("status", {
      repository,
      branches: [{ name: "factory/GH-7-abc" }, { name: "main" }],
    });
    expect(status?.branches).toEqual(["factory/GH-7-abc", "main"]);
    expect(status?.prNumbers).toEqual([]);
  });

  test("ignores unsupported events and irrelevant actions", () => {
    expect(parseGithubEvent("push", { repository })).toBeNull();
    expect(
      parseGithubEvent("pull_request", {
        action: "labeled",
        repository,
        pull_request: { number: 42 },
      }),
    ).toBeNull();
    expect(
      parseGithubEvent("status", { repository, branches: [] }),
    ).toBeNull();
  });
});
