/**
 * Public origin used for browser redirects.
 *
 * Behind the ingress, `request.url` can reflect the container's internal
 * address (`0.0.0.0:8080`) instead of the public host. Prefer the configured
 * public origin so redirects always send the browser to the real domain.
 */
export function publicOrigin(fallback: string): string {
  const configured = (
    process.env.WEB_PUBLIC_ORIGIN ??
    process.env.NEXTAUTH_URL ??
    ""
  ).trim();
  return (configured || fallback).replace(/\/+$/, "");
}
