import { join, normalize } from "node:path";

const port = Number(process.env.WEB_PORT ?? 8080);
const apiUrl = (process.env.FACTORY_API_URL ?? "http://factory:3000").replace(
  /\/+$/,
  "",
);
const apiToken = process.env.FACTORY_API_TOKEN?.trim() || "";
const publicDir = join(import.meta.dir, "public");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

Bun.serve({
  port,
  hostname: "0.0.0.0",
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return proxy(request, url);
    }

    const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const path = normalize(join(publicDir, relative));
    if (!path.startsWith(publicDir)) {
      return new Response("not found", { status: 404 });
    }

    const file = Bun.file(path);
    if (!(await file.exists())) {
      return new Response("not found", { status: 404 });
    }

    const ext = path.slice(path.lastIndexOf("."));
    return new Response(file, {
      headers: {
        "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
        "cache-control": "no-store",
      },
    });
  },
});

async function proxy(request: Request, url: URL): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("content-length");
  if (apiToken) headers.set("authorization", `Bearer ${apiToken}`);

  try {
    const response = await fetch(`${apiUrl}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body:
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await request.arrayBuffer(),
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
      { status: 502 },
    );
  }
}

console.log(`Software Factory webapp on http://0.0.0.0:${port}`);
console.log(`Proxying /api/* to ${apiUrl}`);
