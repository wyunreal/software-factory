import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { OAuthButtons } from "@/components/oauth-buttons";
import { getCurrentUser } from "@/lib/auth/current-user";
import { configuredOAuthProviders } from "@/lib/auth/oauth-providers";
import { safeNextPath } from "@/lib/auth/redirect";

export const dynamic = "force-dynamic";

const AUTH_ERRORS: Record<string, string> = {
  AccessDenied:
    "El proveedor ha denegado el acceso o no ha confirmado tu email.",
  OAuthAccountNotLinked:
    "Ese email ya está asociado a otra cuenta. Entra con el método original.",
  OAuthSignin: "No se pudo iniciar el flujo OAuth. Inténtalo de nuevo.",
  OAuthCallback: "El proveedor devolvió una respuesta inválida.",
  Configuration: "La autenticación no está configurada correctamente.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    next?: string;
    error?: string;
    registered?: string;
  }>;
}) {
  if (await getCurrentUser()) redirect("/");

  const params = await searchParams;
  const next = safeNextPath(params.next);
  const providers = configuredOAuthProviders();
  const authError = params.error
    ? (AUTH_ERRORS[params.error] ?? "No se pudo iniciar sesión.")
    : "";

  return (
    <main className="auth">
      <section className="card auth-card">
        <p className="eyebrow">AI Software Factory</p>
        <h1>Entrar</h1>
        <p className="muted">
          Para usar la factoría necesitas una cuenta registrada.
        </p>

        {params.registered ? (
          <div className="message" role="status">
            Cuenta creada. Entra con tu email y contraseña.
          </div>
        ) : null}
        {authError ? (
          <div className="message error" role="alert">
            {authError}
          </div>
        ) : null}

        <OAuthButtons
          providers={providers}
          next={next}
          dividerLabel="o entra con email y contraseña"
        />
        <AuthForm mode="login" next={next} />

        <p className="auth-switch">
          ¿No tienes cuenta? <Link href="/register">Regístrate</Link>
        </p>
      </section>
    </main>
  );
}
