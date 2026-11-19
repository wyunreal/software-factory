const DEFAULT_SESSION_TTL_HOURS = 24 * 7;

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigError";
  }
}

/**
 * Secret used to sign session cookies. It is intentionally separate from
 * FACTORY_API_TOKEN: rotating one must not invalidate the other.
 */
export function authSecret(): string {
  const secret = process.env.WEB_AUTH_SECRET?.trim() ?? "";
  if (secret.length < 32) {
    throw new AuthConfigError(
      "WEB_AUTH_SECRET must be set to at least 32 characters.",
    );
  }
  return secret;
}

export function sessionTtlSeconds(): number {
  const raw = process.env.WEB_SESSION_TTL_HOURS?.trim();
  if (!raw) return DEFAULT_SESSION_TTL_HOURS * 60 * 60;

  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours < 1 || hours > 24 * 30) {
    throw new AuthConfigError(
      "WEB_SESSION_TTL_HOURS must be a number between 1 and 720.",
    );
  }
  return Math.floor(hours * 60 * 60);
}

export function registrationCode(): string | null {
  const code = process.env.WEB_REGISTRATION_CODE?.trim();
  return code ? code : null;
}

export function secureCookies(): boolean {
  const explicit = process.env.WEB_COOKIE_SECURE?.trim().toLowerCase();
  if (explicit === "true" || explicit === "1") return true;
  if (explicit === "false" || explicit === "0") return false;
  return (
    process.env.NEXTAUTH_URL?.trim().startsWith("https://") ||
    (process.env.WEB_PUBLIC_ORIGIN?.trim().startsWith("https://") ?? false)
  );
}

export function databaseUrl(): string {
  const url =
    process.env.WEB_DATABASE_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new AuthConfigError(
      "WEB_DATABASE_URL or DATABASE_URL must be set for authentication.",
    );
  }
  return url;
}
