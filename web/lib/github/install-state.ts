import { createHmac, timingSafeEqual } from "node:crypto";

export type InstallIntent = {
  userId: string;
  name: string;
  repoUrl: string;
  exp: number;
};

const VERSION = "v1";
const TTL_MS = 15 * 60_000;

export function signInstallState(
  input: Omit<InstallIntent, "exp">,
  secret: string,
  now = Date.now(),
): string {
  const payload: InstallIntent = {
    ...input,
    exp: Math.floor((now + TTL_MS) / 1000),
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  return `${VERSION}.${body}.${signature(body, secret)}`;
}

export function verifyInstallState(
  token: string | null | undefined,
  secret: string,
  now = Date.now(),
): InstallIntent | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) return null;
  const body = parts[1];
  const sig = parts[2];
  if (!body || !sig) return null;

  const expected = signature(body, secret);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(sig, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!decoded || typeof decoded !== "object") return null;
  const value = decoded as Record<string, unknown>;
  if (
    typeof value.userId !== "string" ||
    !value.userId ||
    typeof value.name !== "string" ||
    !value.name ||
    typeof value.repoUrl !== "string" ||
    !value.repoUrl ||
    typeof value.exp !== "number" ||
    !Number.isFinite(value.exp) ||
    value.exp * 1000 <= now
  ) {
    return null;
  }
  return {
    userId: value.userId,
    name: value.name,
    repoUrl: value.repoUrl,
    exp: value.exp,
  };
}

function signature(body: string, secret: string): string {
  return createHmac("sha256", secret).update(`${VERSION}.${body}`).digest("base64url");
}
