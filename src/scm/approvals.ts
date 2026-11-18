import type { PullRequestReview } from "../ports.ts";

/**
 * A PR is approved when at least one reviewer's latest decisive review is
 * APPROVED and no reviewer's latest decisive review is CHANGES_REQUESTED.
 * Plain comments do not overwrite an approval; a dismissal or a new
 * changes-requested review does.
 */
export function hasApprovedReview(reviews: PullRequestReview[]): boolean {
  const states = latestDecisiveStates(reviews);
  return states.some((state) => state === "APPROVED") && !states.includes("CHANGES_REQUESTED");
}

/**
 * Latest decisive review per reviewer, keeping the review object so callers can
 * surface the feedback body/ID. A later APPROVED clears an earlier
 * CHANGES_REQUESTED and vice versa.
 */
export function latestChangesRequestedReviews(
  reviews: PullRequestReview[],
): PullRequestReview[] {
  const latest = new Map<string, PullRequestReview>();

  for (const review of [...reviews].sort((a, b) =>
    a.submittedAt.localeCompare(b.submittedAt),
  )) {
    if (!review.user) continue;
    if (
      review.state === "APPROVED" ||
      review.state === "CHANGES_REQUESTED" ||
      review.state === "DISMISSED"
    ) {
      latest.set(review.user, review);
    }
  }

  return [...latest.values()].filter(
    (review) => review.state === "CHANGES_REQUESTED",
  );
}

function latestDecisiveStates(reviews: PullRequestReview[]): string[] {
  const latest = new Map<string, string>();

  for (const review of [...reviews].sort((a, b) =>
    a.submittedAt.localeCompare(b.submittedAt),
  )) {
    if (!review.user) continue;
    if (
      review.state === "APPROVED" ||
      review.state === "CHANGES_REQUESTED" ||
      review.state === "DISMISSED"
    ) {
      latest.set(review.user, review.state);
    }
  }

  return [...latest.values()];
}

export function pullRequestNumberFromUrl(url: string): number | null {
  const match = /\/pull\/(\d+)(?:\/|$)/.exec(url);
  return match?.[1] ? Number.parseInt(match[1], 10) : null;
}
