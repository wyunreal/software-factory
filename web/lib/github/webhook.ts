import { createHmac, timingSafeEqual } from "node:crypto";

export function githubWebhookSecret(): string | null {
  const secret = process.env.GITHUB_APP_WEBHOOK_SECRET?.trim();
  return secret ? secret : null;
}

/**
 * Validate GitHub's `X-Hub-Signature-256` header against the raw request body.
 * The comparison is constant-time and never logs the payload or secret.
 */
export function verifyGithubSignature(
  payload: string,
  signature: string | null,
  secret: string,
): boolean {
  if (!signature) return false;
  const expected = `sha256=${createHmac("sha256", secret)
    .update(payload, "utf8")
    .digest("hex")}`;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
