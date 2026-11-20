import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth/options";
import { signInstallState } from "@/lib/github/install-state";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id;
  if (!userId) return json({ error: "unauthorized" }, 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "JSON inválido." }, 400);
  }
  const input = body as { name?: unknown; repoUrl?: unknown };
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const repoUrl =
    typeof input.repoUrl === "string" ? input.repoUrl.trim() : "";
  if (!name || !repoUrl) {
    return json({ error: "name and repoUrl are required" }, 400);
  }

  const slug = process.env.GITHUB_APP_SLUG?.trim();
  const secret = process.env.WEB_AUTH_SECRET?.trim();
  if (!slug || !secret) {
    return json(
      { error: "GITHUB_APP_SLUG or WEB_AUTH_SECRET is not configured." },
      503,
    );
  }

  const state = signInstallState({ userId, name, repoUrl }, secret);
  const installUrl = `https://github.com/apps/${encodeURIComponent(
    slug,
  )}/installations/new?state=${encodeURIComponent(state)}`;
  return json({ installUrl }, 200);
}

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
