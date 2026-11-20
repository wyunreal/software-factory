import { getServerSession } from "next-auth/next";
import { NextResponse, type NextRequest } from "next/server";
import { authOptions } from "@/lib/auth/options";
import { verifyInstallState } from "@/lib/github/install-state";
import { publicOrigin } from "@/lib/public-origin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function factoryUrl(): string {
  return (process.env.FACTORY_API_URL ?? "http://127.0.0.1:3000").replace(
    /\/+$/,
    "",
  );
}

export async function GET(request: NextRequest): Promise<Response> {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.redirect(
      new URL("/login", publicOrigin(request.nextUrl.origin)),
    );
  }

  const params = request.nextUrl.searchParams;
  const setupAction = params.get("setup_action") ?? "install";

  const installationId = Number(params.get("installation_id"));
  const state = params.get("state");
  if (!Number.isInteger(installationId) || installationId <= 0) {
    return redirectTo(request, "/", {
      installError: "GitHub no devolvió una instalación válida.",
    });
  }
  if (!state) {
    return redirectTo(request, "/", {
      notice:
        setupAction === "update"
          ? "La instalación de la GitHub App se ha actualizado."
          : "GitHub App instalada. Vuelve a crear el proyecto para conectarlo.",
    });
  }

  const secret = process.env.WEB_AUTH_SECRET?.trim();
  if (!secret) {
    return redirectTo(request, "/", {
      installError: "WEB_AUTH_SECRET no está configurado.",
    });
  }
  const intent = verifyInstallState(state, secret);
  if (!intent || intent.userId !== userId) {
    return redirectTo(request, "/", {
      installError: "El estado de la instalación no es válido o ha caducado.",
    });
  }

  const token = process.env.FACTORY_API_TOKEN?.trim();
  if (!token) {
    return redirectTo(request, "/", {
      installError: "FACTORY_API_TOKEN no está configurado.",
    });
  }

  try {
    const response = await fetch(
      `${factoryUrl()}/api/github/installations`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "x-factory-user-id": userId,
        },
        body: JSON.stringify({
          installationId,
          name: intent.name,
          repoUrl: intent.repoUrl,
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      },
    );

    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as {
        error?: string;
      } | null;
      return redirectTo(request, "/", {
        installError:
          detail?.error ??
          "No se pudo crear el proyecto tras instalar la GitHub App.",
      });
    }

    return redirectTo(request, "/", {
      notice: `Proyecto "${intent.name}" creado.`,
    });
  } catch (error) {
    return redirectTo(request, "/", {
      installError: `Factory API unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }
}

function redirectTo(
  request: NextRequest,
  path: string,
  params: Record<string, string>,
): NextResponse {
  const url = new URL(path, publicOrigin(request.nextUrl.origin));
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return NextResponse.redirect(url);
}
