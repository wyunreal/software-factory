/**
 * OAuth profile helpers. Providers return slightly different shapes; these
 * functions normalize the fields the factory stores and decide whether the
 * email is trustworthy enough to link a provider to an existing account.
 */

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function profileEmail(profile: unknown): string | null {
  if (!profile || typeof profile !== "object") return null;
  const record = profile as Record<string, unknown>;
  const candidate =
    stringValue(record.email) ||
    stringValue(record.preferred_username) ||
    stringValue(record.upn);
  if (!candidate || !candidate.includes("@")) return null;
  return candidate.toLowerCase();
}

export function profileName(profile: unknown, email: string): string {
  if (profile && typeof profile === "object") {
    const record = profile as Record<string, unknown>;
    const name = stringValue(record.name);
    if (name) return name;
    const login = stringValue(record.login);
    if (login) return login;
  }
  return email.split("@")[0] ?? "";
}

export function profileImage(profile: unknown): string | null {
  if (!profile || typeof profile !== "object") return null;
  const record = profile as Record<string, unknown>;
  const image =
    stringValue(record.picture) || stringValue(record.avatar_url) || "";
  return image || null;
}

/**
 * Only link by email when the provider asserts it verified the address.
 * GitHub, GitLab and Microsoft Entra ID expose verified/managed addresses
 * without an `email_verified` claim.
 */
export function isVerifiedOAuthEmail(
  provider: string,
  profile: unknown,
): boolean {
  if (!profileEmail(profile)) return false;
  if (!profile || typeof profile !== "object") return false;

  const flag = (profile as Record<string, unknown>).email_verified;
  if (typeof flag === "boolean") return flag;
  if (typeof flag === "string") return flag.toLowerCase() === "true";

  return ["github", "gitlab", "azure-ad"].includes(provider);
}
