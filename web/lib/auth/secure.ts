import { timingSafeEqual } from "node:crypto";

/**
 * Compare two strings without leaking their content through timing.
 * Length is not secret, so an early return on different lengths is fine.
 */
export function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
