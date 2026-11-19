import type { TestResult } from "./types.ts";

export type Verification = TestResult & {
  valid: boolean;
};

export function parseVerification(text: string): Verification {
  const json = extractJson(text);
  if (!json) return invalid(text, "Verifier did not return a JSON result");

  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return invalid(text, "Verifier returned invalid JSON");
  }
  if (!isRecord(value)) return invalid(text, "Verifier result is not an object");

  const skipped = value.skipped === true;
  const passed = value.passed === true;
  if (!skipped && typeof value.passed !== "boolean") {
    return invalid(text, "Verifier result is missing a boolean `passed`");
  }

  return {
    skipped,
    passed: skipped ? true : passed,
    exitCode:
      typeof value.exitCode === "number" ? value.exitCode : skipped ? null : 1,
    timedOut: value.timedOut === true,
    command: typeof value.command === "string" ? value.command : "",
    output:
      typeof value.output === "string" ? value.output : text.slice(0, 100_000),
    durationMs:
      typeof value.durationMs === "number" && value.durationMs >= 0
        ? value.durationMs
        : 0,
    valid: true,
  };
}

export function extractJson(text: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1]?.trim() ?? text.trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  return candidate.slice(start, end + 1);
}

function invalid(text: string, reason: string): Verification {
  return {
    skipped: false,
    passed: false,
    exitCode: null,
    timedOut: false,
    command: "",
    output: `${reason}\n\n${text.slice(0, 100_000)}`,
    durationMs: 0,
    valid: false,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
