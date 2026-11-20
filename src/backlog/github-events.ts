type JsonRecord = Record<string, unknown>;

export type GithubEventTarget = {
  event: string;
  action: string | null;
  repository: string;
  prNumbers: number[];
  branches: string[];
};

const ACTIONS: Record<string, Set<string> | null> = {
  pull_request: new Set([
    "closed",
    "reopened",
    "synchronize",
    "ready_for_review",
    "converted_to_draft",
  ]),
  pull_request_review: new Set(["submitted", "dismissed"]),
  pull_request_review_comment: new Set(["created", "edited", "deleted"]),
  issue_comment: new Set(["created", "edited", "deleted"]),
  check_suite: new Set(["completed"]),
  check_run: new Set(["completed"]),
  status: null,
};

/**
 * Reduce a GitHub webhook delivery to the repository and PR/branch targets that
 * may need a PR sync. Unknown events are ignored instead of triggering work.
 */
export function parseGithubEvent(
  event: string,
  payload: unknown,
): GithubEventTarget | null {
  const allowed = ACTIONS[event];
  if (allowed === undefined) return null;

  const root = asRecord(payload);
  if (!root) return null;

  const action = stringValue(root.action);
  if (allowed && (!action || !allowed.has(action))) return null;

  const repository = stringValue(asRecord(root.repository)?.full_name);
  if (!repository) return null;

  let prNumbers: number[] = [];
  let branches: string[] = [];

  if (event === "pull_request" || event === "pull_request_review") {
    prNumbers = numbersFrom(asRecord(root.pull_request)?.number);
  } else if (event === "pull_request_review_comment") {
    prNumbers = numbersFrom(asRecord(root.pull_request)?.number);
  } else if (event === "issue_comment") {
    const issue = asRecord(root.issue);
    if (issue?.pull_request) prNumbers = numbersFrom(issue.number);
  } else if (event === "check_suite" || event === "check_run") {
    const container = event === "check_suite" ? root.check_suite : root.check_run;
    const requests = asRecord(container)?.pull_requests;
    if (Array.isArray(requests)) {
      prNumbers = requests.flatMap((item) =>
        numbersFrom(asRecord(item)?.number),
      );
    }
  } else if (event === "status") {
    const entries = root.branches;
    if (Array.isArray(entries)) {
      branches = entries
        .map((item) => stringValue(asRecord(item)?.name))
        .filter((name): name is string => Boolean(name));
    }
  }

  prNumbers = [...new Set(prNumbers)];
  branches = [...new Set(branches)];
  if (prNumbers.length === 0 && branches.length === 0) return null;

  return {
    event,
    action,
    repository: repository.toLowerCase(),
    prNumbers,
    branches,
  };
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numbersFrom(value: unknown): number[] {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? [parsed] : [];
}
