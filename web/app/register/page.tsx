import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { OAuthButtons } from "@/components/oauth-buttons";
import { getCurrentUser } from "@/lib/auth/current-user";
import { configuredOAuthProviders } from "@/lib/auth/oauth-providers";
import { safeNextPath } from "@/lib/auth/redirect";

export const dynamic = "force-dynamic";

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  if (await getCurrentUser()) redirect("/");

  const params = await searchParams;
  const next = safeNextPath(params.next);
  const requiresCode = Boolean(process.env.WEB_REGISTRATION_CODE?.trim());
  const providers = configuredOAuthProviders();

  return (
    <main className="auth">
      <section className="card auth-card">
        <p className="eyebrow">AI Software Factory</p>
        <h1>Crear cuenta</h1>
        <p className="muted">
          Regístrate para iniciar ejecuciones y seguir el pipeline.
        </p>
        <OAuthButtons
          providers={providers}
          next={next}
          dividerLabel="o crea una cuenta con email y contraseña"
        />
        <AuthForm mode="register" next={next} requiresCode={requiresCode} />
        <p className="auth-switch">
          ¿Ya tienes cuenta? <Link href="/login">Entra</Link>
        </p>
      </section>
    </main>
  );
}
