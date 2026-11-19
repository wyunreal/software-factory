import { describe, expect, test } from "vitest";
import { hasRework, parseTriageResult } from "../src/domain/triage.ts";

describe("feedback triage parser", () => {
  test("parses a JSON decision object", () => {
    const result = parseTriageResult(
      JSON.stringify({
        comments: [
          {
            commentId: 10,
            decision: "NO_ACTION",
            reason: "praise",
            tasks: [],
          },
          {
            commentId: 11,
            decision: "REWORK",
            reason: "bug",
            tasks: ["fix it", "test it"],
          },
        ],
      }),
    );
    expect(result?.comments).toHaveLength(2);
    expect(hasRework(result!)).toBe(true);
  });

  test("tolerates fenced JSON and synonyms", () => {
    const result = parseTriageResult(
      'Here:\n```json\n{"comments":[{"id":5,"decision":"none"}]}\n```',
    );
    expect(result?.comments[0]?.decision).toBe("NO_ACTION");
    expect(hasRework(result!)).toBe(false);
  });

  test("returns null for invalid or empty output", () => {
    expect(parseTriageResult("not json")).toBeNull();
    expect(parseTriageResult('{"comments":[]}')).toBeNull();
  });
});
