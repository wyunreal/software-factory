/**
 * Only allow same-origin, absolute paths as post-login destinations.
 * `//evil.example` and full URLs are rejected to avoid open redirects.
 */
export function safeNextPath(value: string | null | undefined): string {
  if (!value) return "/";
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  if (value.includes("\\") || value.includes("\n") || value.includes("\r")) {
    return "/";
  }
  return value;
}
