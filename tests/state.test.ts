import { describe, expect, test } from "vitest";
import { canTransition, isActive, isTerminal } from "../src/domain/state.ts";

describe("run state machine", () => {
  test("follows the happy path", () => {
    const path = [
      "CLAIMED",
      "PLANNING",
      "PLANNED",
      "BUILDING",
      "QA",
      "TESTING",
      "REVIEWING",
      "DELIVERY",
      "HUMAN_REVIEW",
    ] as const;

    for (let index = 0; index < path.length - 1; index++) {
      expect(canTransition(path[index]!, path[index + 1]!)).toBe(true);
    }
    expect(canTransition("HUMAN_REVIEW", "DONE")).toBe(true);
  });

  test("allows rework from testing and review", () => {
    expect(canTransition("TESTING", "REWORK")).toBe(true);
    expect(canTransition("REVIEWING", "REWORK")).toBe(true);
    expect(canTransition("REWORK", "BUILDING")).toBe(true);
  });

  test("allows comment triage from human review", () => {
    expect(canTransition("HUMAN_REVIEW", "TRIAGING")).toBe(true);
    expect(canTransition("TRIAGING", "HUMAN_REVIEW")).toBe(true);
    expect(canTransition("TRIAGING", "REWORK")).toBe(true);
    expect(canTransition("TRIAGING", "BLOCKED")).toBe(true);
  });

  test("rejects skipping stages", () => {
    expect(canTransition("PLANNING", "BUILDING")).toBe(false);
    expect(canTransition("CLAIMED", "DELIVERY")).toBe(false);
    expect(canTransition("DONE", "BUILDING")).toBe(false);
  });

  test("classifies terminal states", () => {
    expect(isTerminal("HUMAN_REVIEW")).toBe(true);
    expect(isTerminal("DONE")).toBe(true);
    expect(isTerminal("BLOCKED")).toBe(true);
    expect(isTerminal("BUILDING")).toBe(false);
    expect(isActive("BUILDING")).toBe(true);
  });
});
