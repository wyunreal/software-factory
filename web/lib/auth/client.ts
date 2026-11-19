"use client";

async function csrfToken(): Promise<string> {
  const response = await fetch("/api/auth/csrf", {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok) {
    throw new Error("No se pudo iniciar el flujo de autenticación.");
  }
  const body = (await response.json()) as { csrfToken?: string };
  if (!body.csrfToken) {
    throw new Error("NextAuth no devolvió un token CSRF.");
  }
  return body.csrfToken;
}

async function post(
  path: string,
  params: Record<string, string>,
): Promise<{ url?: unknown }> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
    cache: "no-store",
    credentials: "same-origin",
  });
  const body = (await response.json().catch(() => null)) as {
    url?: unknown;
  } | null;
  if (!response.ok) {
    throw new Error("No se pudo completar la autenticación.");
  }
  return body ?? {};
}

export async function signInWithCredentials(
  email: string,
  password: string,
  callbackUrl: string,
): Promise<boolean> {
  const token = await csrfToken();
  const body = await post("/api/auth/callback/credentials", {
    csrfToken: token,
    email,
    password,
    callbackUrl,
    json: "true",
  });
  const url = typeof body.url === "string" ? body.url : "";
  return !url.includes("/api/auth/error") && !url.includes("error=CredentialsSignin");
}

export async function signInWithOAuth(
  provider: string,
  callbackUrl: string,
): Promise<void> {
  const token = await csrfToken();
  const body = await post(
    `/api/auth/signin/${encodeURIComponent(provider)}`,
    { csrfToken: token, callbackUrl, json: "true" },
  );
  if (typeof body.url !== "string" || !body.url) {
    throw new Error("El proveedor OAuth no está configurado.");
  }
  window.location.assign(body.url);
}

export async function signOutClient(): Promise<void> {
  const token = await csrfToken();
  await post("/api/auth/signout", {
    csrfToken: token,
    callbackUrl: "/login",
    json: "true",
  });
  window.location.assign("/login");
}
