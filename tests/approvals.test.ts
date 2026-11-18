import { describe, expect, test } from "bun:test";
import {
  hasApprovedReview,
  latestChangesRequestedReviews,
  pullRequestNumberFromUrl,
} from "../src/scm/approvals.ts";
import type { PullRequestReview } from "../src/ports.ts";

function review(
  user: string,
  state: string,
  submittedAt: string,
): PullRequestReview {
  return { id: Math.floor(Math.random() * 1_000_000), user, state, body: "", submittedAt };
}

describe("auto-merge approval policy", () => {
  test("accepts one APPROVED review", () => {
    expect(hasApprovedReview([review("alice", "APPROVED", "2026-01-01T10:00:00Z")])).toBe(true);
  });

  test("rejects no reviews", () => {
    expect(hasApprovedReview([])).toBe(false);
  });

  test("rejects comments without approval", () => {
    expect(hasApprovedReview([review("alice", "COMMENTED", "2026-01-01T10:00:00Z")])).toBe(false);
  });

  test("rejects an approval overridden by CHANGES_REQUESTED", () => {
    expect(
      hasApprovedReview([
        review("alice", "APPROVED", "2026-01-01T10:00:00Z"),
        review("alice", "CHANGES_REQUESTED", "2026-01-01T11:00:00Z"),
      ]),
    ).toBe(false);
  });

  test("blocks when any other reviewer requested changes", () => {
    expect(
      hasApprovedReview([
        review("alice", "APPROVED", "2026-01-01T10:00:00Z"),
        review("bob", "CHANGES_REQUESTED", "2026-01-01T11:00:00Z"),
      ]),
    ).toBe(false);
  });

  test("a later approval clears an earlier change request", () => {
    expect(
      hasApprovedReview([
        review("alice", "CHANGES_REQUESTED", "2026-01-01T10:00:00Z"),
        review("alice", "APPROVED", "2026-01-01T11:00:00Z"),
      ]),
    ).toBe(true);
  });

  test("a dismissal clears an approval", () => {
    expect(
      hasApprovedReview([
        review("alice", "APPROVED", "2026-01-01T10:00:00Z"),
        review("alice", "DISMISSED", "2026-01-01T11:00:00Z"),
      ]),
    ).toBe(false);
  });

  test("plain comments after approval do not remove it", () => {
    expect(
      hasApprovedReview([
        review("alice", "APPROVED", "2026-01-01T10:00:00Z"),
        review("alice", "COMMENTED", "2026-01-01T11:00:00Z"),
      ]),
    ).toBe(true);
  });

  test("returns only active changes-requested reviews", () => {
    const changes = latestChangesRequestedReviews([
      review("alice", "CHANGES_REQUESTED", "2026-01-01T10:00:00Z"),
      review("alice", "APPROVED", "2026-01-01T11:00:00Z"),
      review("bob", "CHANGES_REQUESTED", "2026-01-01T12:00:00Z"),
    ]);
    expect(changes.map((item) => item.user)).toEqual(["bob"]);
  });
});

describe("PR number parsing", () => {
  test("extracts the number from a GitHub PR URL", () => {
    expect(
      pullRequestNumberFromUrl(
        "https://github.com/acme/app/pull/42",
      ),
    ).toBe(42);
  });

  test("returns null for a non-PR URL", () => {
    expect(
      pullRequestNumberFromUrl("https://github.com/acme/app/issues/42"),
    ).toBeNull();
  });
});
