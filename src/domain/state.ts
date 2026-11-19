import type { RunState } from "./types.ts";

export const TERMINAL_STATES: ReadonlySet<RunState> = new Set([
  "HUMAN_REVIEW",
  "DONE",
  "BLOCKED",
]);

const TRANSITIONS: Record<RunState, readonly RunState[]> = {
  CLAIMED: ["PLANNING", "BLOCKED"],
  PLANNING: ["PLANNED", "BLOCKED"],
  PLANNED: ["BUILDING", "BLOCKED"],
  BUILDING: ["QA", "REWORK", "BLOCKED"],
  QA: ["TESTING", "BLOCKED"],
  TESTING: ["REVIEWING", "REWORK", "BLOCKED"],
  REVIEWING: ["DELIVERY", "REWORK", "BLOCKED"],
  REWORK: ["BUILDING", "BLOCKED"],
  TRIAGING: ["HUMAN_REVIEW", "REWORK", "BLOCKED"],
  DELIVERY: ["HUMAN_REVIEW", "BLOCKED"],
  HUMAN_REVIEW: ["DONE", "BLOCKED", "REWORK", "TRIAGING"],
  DONE: [],
  BLOCKED: [],
};

export function canTransition(from: RunState, to: RunState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: RunState, to: RunState): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid run transition: ${from} -> ${to}`);
  }
}

export function isTerminal(state: RunState): boolean {
  return TERMINAL_STATES.has(state);
}

export function isActive(state: RunState): boolean {
  return !isTerminal(state);
}
