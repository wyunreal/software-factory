"use client";

import { useState } from "react";
import { signInWithOAuth } from "@/lib/auth/client";
import type { OAuthProviderInfo } from "@/lib/types";

export function OAuthButtons({
  providers,
  next,
  dividerLabel,
}: {
  providers: OAuthProviderInfo[];
  next: string;
  dividerLabel: string;
}) {
  const [error, setError] = useState("");
  const [pending, setPending] = useState<string | null>(null);

  if (providers.length === 0) return null;

  async function start(providerId: string) {
    setError("");
    setPending(providerId);
    try {
      await signInWithOAuth(
        providerId,
        new URL(next, window.location.origin).toString(),
      );
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "No se pudo iniciar OAuth.",
      );
      setPending(null);
    }
  }

  return (
    <div className="oauth">
      <div className="oauth-grid">
        {providers.map((provider) => (
          <button
            key={provider.id}
            type="button"
            className="oauth-button"
            disabled={pending !== null}
            onClick={() => void start(provider.id)}
          >
            <span className="oauth-mark" aria-hidden="true">
              {provider.name.charAt(0)}
            </span>
            {pending === provider.id
              ? "Redirigiendo…"
              : `Continuar con ${provider.name}`}
          </button>
        ))}
      </div>
      {error ? (
        <div className="message error" role="alert">
          {error}
        </div>
      ) : null}
      <div className="oauth-divider">
        <span>{dividerLabel}</span>
      </div>
    </div>
  );
}
