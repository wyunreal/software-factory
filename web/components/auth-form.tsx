"use client";

import { useState } from "react";
import { signInWithCredentials } from "@/lib/auth/client";
import { ApiError, readJson } from "@/lib/http";
import type { AuthUser } from "@/lib/types";

type AuthResponse = { data: AuthUser };

export function AuthForm({
  mode,
  next,
  requiresCode = false,
}: {
  mode: "login" | "register";
  next: string;
  requiresCode?: boolean;
}) {
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const isRegister = mode === "register";

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const email = String(data.get("email") ?? "").trim();
    const password = String(data.get("password") ?? "");
    setError("");

    if (isRegister && password !== String(data.get("confirm") ?? "")) {
      setError("Las contraseñas no coinciden.");
      return;
    }

    setSubmitting(true);
    try {
      if (isRegister) {
        const response = await fetch("/api/auth/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email,
            password,
            name: String(data.get("name") ?? "").trim(),
            code: String(data.get("code") ?? "").trim() || undefined,
          }),
        });
        await readJson<AuthResponse>(response);
      }

      const authenticated = await signInWithCredentials(
        email,
        password,
        new URL(next, window.location.origin).toString(),
      );
      if (!authenticated) {
        if (isRegister) {
          window.location.assign("/login?registered=1");
          return;
        }
        setError("Email o contraseña incorrectos.");
        setSubmitting(false);
        return;
      }

      window.location.assign(next);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : caught instanceof Error
            ? caught.message
            : String(caught),
      );
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit}>
      {isRegister ? (
        <label>
          Nombre
          <input
            name="name"
            type="text"
            autoComplete="name"
            maxLength={80}
            placeholder="Tu nombre"
          />
        </label>
      ) : null}

      <label>
        Email
        <input
          name="email"
          type="email"
          autoComplete="email"
          placeholder="tu@email.com"
          required
        />
      </label>

      <label>
        Contraseña
        <input
          name="password"
          type="password"
          autoComplete={isRegister ? "new-password" : "current-password"}
          minLength={isRegister ? 10 : undefined}
          maxLength={200}
          placeholder={isRegister ? "Mínimo 10 caracteres" : ""}
          required
        />
      </label>

      {isRegister ? (
        <>
          <label>
            Repite la contraseña
            <input
              name="confirm"
              type="password"
              autoComplete="new-password"
              minLength={10}
              maxLength={200}
              required
            />
          </label>

          {requiresCode ? (
            <label>
              Código de registro
              <input
                name="code"
                type="password"
                autoComplete="off"
                maxLength={200}
                required
              />
            </label>
          ) : null}
        </>
      ) : null}

      <button type="submit" disabled={submitting}>
        {submitting
          ? isRegister
            ? "Creando cuenta…"
            : "Entrando…"
          : isRegister
            ? "Crear cuenta"
            : "Entrar con email"}
      </button>

      {error ? (
        <div className="message error" role="alert">
          {error}
        </div>
      ) : null}
    </form>
  );
}
