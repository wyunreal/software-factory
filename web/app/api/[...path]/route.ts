import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ path?: string[] }> };

function factoryUrl(): string {
  return (process.env.FACTORY_API_URL ?? "http://127.0.0.1:3000").replace(
    /\/+$/,
    "",
  );
}

async function proxy(
  request: NextRequest,
  context: RouteContext,
): Promise<Response> {
  const { path = [] } = await context.params;
  const token = process.env.FACTORY_API_TOKEN?.trim() ?? "";
  const target = `${factoryUrl()}/api/${path.join("/")}${request.nextUrl.search}`;

  const headers = new Headers();
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  if (token) headers.set("authorization", `Bearer ${token}`);

  const hasBody = request.method !== "GET" && request.method !== "HEAD";

  try {
    const response = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? await request.arrayBuffer() : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });

    return new Response(response.status === 204 ? null : response.body, {
      status: response.status,
      headers: {
        "content-type":
          response.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    return Response.json(
      {
        error: `Factory API unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
}

export async function GET(request: NextRequest, context: RouteContext) {
  return proxy(request, context);
}

export async function POST(request: NextRequest, context: RouteContext) {
  return proxy(request, context);
}
