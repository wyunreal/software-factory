export type TriageDecision = "NO_ACTION" | "REWORK";

export type TriageCommentDecision = {
  commentId: number;
  decision: TriageDecision;
  reason: string;
  tasks: string[];
};

export type TriageResult = {
  comments: TriageCommentDecision[];
};

/**
 * Parses the triage agent output. It accepts a bare JSON object or a fenced
 * block and normalizes the usual decision synonyms.
 */
export function parseTriageResult(text: string): TriageResult | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;
  const raw =
    (Array.isArray(parsed.comments) && parsed.comments) ||
    (Array.isArray(parsed.decisions) && parsed.decisions) ||
    (Array.isArray(parsed.results) && parsed.results) ||
    null;
  if (!raw) return null;

  const comments: TriageCommentDecision[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const commentId = Number(item.commentId ?? item.comment_id ?? item.id);
    if (!Number.isInteger(commentId) || commentId <= 0) continue;

    const decision = normalizeDecision(item.decision);
    if (!decision) continue;

    comments.push({
      commentId,
      decision,
      reason: typeof item.reason === "string" ? item.reason.trim() : "",
      tasks: Array.isArray(item.tasks)
        ? item.tasks.map(String).map((task) => task.trim()).filter(Boolean)
        : [],
    });
  }

  return comments.length > 0 ? { comments } : null;
}

export function hasRework(result: TriageResult): boolean {
  return result.comments.some((comment) => comment.decision === "REWORK");
}

function normalizeDecision(value: unknown): TriageDecision | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (normalized === "NO_ACTION" || normalized === "NOACTION" || normalized === "NONE") {
    return "NO_ACTION";
  }
  if (normalized === "REWORK" || normalized === "ACTION" || normalized === "ACTION_REQUIRED") {
    return "REWORK";
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
