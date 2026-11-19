import { describe, expect, test } from "vitest";
import {
  extractJson,
  parseVerification,
} from "../src/domain/verification.ts";

describe("verification parser", () => {
  test("parses a fenced JSON result", () => {
    const result = parseVerification(
      'Done.\n```json\n{"passed":true,"exitCode":0,"command":"npm test","output":"ok","durationMs":12}\n```',
    );
    expect(result.valid).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.command).toBe("npm test");
  });

  test("treats skipped as a passing gate", () => {
    const result = parseVerification(
      '```json\n{"skipped":true,"passed":true}\n```',
    );
    expect(result.valid).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.passed).toBe(true);
  });

  test("treats invalid output as a failure", () => {
    const result = parseVerification("tests failed, trust me");
    expect(result.valid).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.output).toContain("did not return a JSON");
  });

  test("rejects a result without a boolean passed field", () => {
    const result = parseVerification('```json\n{"skipped":false}\n```');
    expect(result.valid).toBe(false);
    expect(result.passed).toBe(false);
  });

  test("extracts the JSON object from surrounding prose", () => {
    expect(extractJson('prefix {"passed":true} suffix')).toBe(
      '{"passed":true}',
    );
  });
});
