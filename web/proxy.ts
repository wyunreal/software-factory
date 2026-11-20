import { getToken } from "next-auth/jwt";
import { NextResponse, type NextRequest } from "next/server";
import { secureCookies } from "@/lib/auth/config";

const PUBLIC_PAGES = new Set(["/login", "/register"]);
const AUTH_API_PREFIX = "/api/auth";
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Edge-of-the-app gate. It performs an optimistic NextAuth JWT check and
 * rejects unauthenticated requests before they reach pages, route handlers, or
 * the factory API proxy. Pages verify the session again with
 * `getServerSession`; this is not the only line of defense.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl;

  // NextAuth owns its routes, and GitHub authenticates webhooks by signature.
  if (
    pathname.startsWith(AUTH_API_PREFIX) ||
    pathname === "/api/github/webhook"
  ) {
    return NextResponse.next();
  }

  if (MUTATING_METHODS.has(request.method) && !isSameOrigin(request)) {
    return NextResponse.json(
      { error: "Origen no permitido." },
      { status: 403, headers: { "cache-control": "no-store" } },
    );
  }

  const authenticated = await hasValidSession(request);

  if (PUBLIC_PAGES.has(pathname)) {
    if (authenticated) return NextResponse.redirect(new URL("/", request.url));
    return NextResponse.next();
  }

  if (!authenticated) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: "unauthorized" },
        {
          status: 401,
          headers: {
            "cache-control": "no-store",
            "www-authenticate": "Session",
          },
        },
      );
    }
    const login = new URL("/login", request.url);
    login.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(login);
  }

  return NextResponse.next();
}

async function hasValidSession(request: NextRequest): Promise<boolean> {
  const secret =
    process.env.NEXTAUTH_SECRET?.trim() ||
    process.env.AUTH_SECRET?.trim() ||
    process.env.WEB_AUTH_SECRET?.trim();
  if (!secret) return false;

  try {
    const token = await getToken({
      req: request,
      secret,
      secureCookie: secureCookies(),
    });
    if (!token) return false;

    const uid = (token as { uid?: unknown }).uid;
    const exp = token.exp;
    if (typeof uid !== "string" || uid.length === 0) return false;
    if (typeof exp !== "number" || exp * 1000 <= Date.now()) return false;
    return true;
  } catch {
    // Fail closed if the token is malformed or the secret is invalid.
    return false;
  }
}

function isSameOrigin(request: NextRequest): boolean {
  if (request.headers.get("sec-fetch-site") === "cross-site") return false;

  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const originHost = new URL(origin).host;
    const requestHost = request.headers.get("host") ?? request.nextUrl.host;
    return originHost === requestHost;
  } catch {
    return false;
  }
}

export const config = {
  matcher: ["/((?!_next/|favicon.ico).*)"],
};
