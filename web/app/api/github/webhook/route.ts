import { NextResponse } from "next/server";
import {
  githubWebhookSecret,
  verifyGithubSignature,
} from "@/lib/github/webhook";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function factoryUrl(): string {
  return (process.env.FACTORY_API_URL ?? "http://127.0.0.1:3000").replace(
    /\/+$/,
    "",
  );
}

/**
 * Public GitHub webhook ingress.
 *
 * GitHub authenticates with an HMAC signature, not with a session. The event is
 * verified here and then forwarded to the internal, bearer-protected factory
 * endpoint. The webapp remains the only public entry point.
 */
export async function POST(request: Request): Promise<Response> {
  const secret = githubWebhookSecret();
  if (!secret) {
    return json({ error: "GITHUB_APP_WEBHOOK_SECRET is not configured." }, 503);
  }

  const raw = await request.text();
  const signature = request.headers.get("x-hub-signature-256");
  if (!verifyGithubSignature(raw, signature, secret)) {
    return json({ error: "invalid signature" }, 401);
  }

  const event = request.headers.get("x-github-event")?.trim() ?? "";
  const delivery = request.headers.get("x-github-delivery")?.trim() ?? "";
  if (!event || !delivery) {
    return json({ error: "missing github event headers" }, 400);
  }

  const token = process.env.FACTORY_API_TOKEN?.trim();
  if (!token) {
    return json({ error: "FACTORY_API_TOKEN is not configured." }, 503);
  }

  try {
    const response = await fetch(`${factoryUrl()}/api/github/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "x-github-event": event,
        "x-github-delivery": delivery,
      },
      body: raw,
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.text();
    return new Response(body, {
      status: response.status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return json(
      {
        error: `Factory API unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
      502,
    );
  }
}

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
