import { NextResponse, type NextRequest } from "next/server";
import { registrationCode } from "@/lib/auth/config";
import { hashPassword } from "@/lib/auth/password";
import { clientAddress, rateLimit } from "@/lib/auth/rate-limit";
import { constantTimeEqual } from "@/lib/auth/secure";
import { createAuthUser, isUniqueViolation } from "@/lib/auth/store";
import {
  normalizeEmail,
  normalizeName,
  readOptionalCode,
  validateNewPassword,
  ValidationError,
} from "@/lib/auth/validation";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "JSON inválido." }, 400);
  }

  try {
    const input = body as {
      email?: unknown;
      password?: unknown;
      name?: unknown;
      code?: unknown;
    };
    const ip = clientAddress(request);
    const limit = rateLimit(`register:ip:${ip}`, 10, 60 * 60_000);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "Demasiados registros. Espera un rato." },
        {
          status: 429,
          headers: {
            "cache-control": "no-store",
            "retry-after": String(limit.retryAfterSeconds),
          },
        },
      );
    }

    const email = normalizeEmail(input.email);
    const name = normalizeName(input.name);
    const password = validateNewPassword(input.password);

    const requiredCode = registrationCode();
    if (requiredCode) {
      const supplied = readOptionalCode(input.code);
      if (!constantTimeEqual(supplied, requiredCode)) {
        return json({ error: "Código de registro inválido." }, 403);
      }
    }

    const passwordHash = await hashPassword(password);
    const user = await createAuthUser({ email, name, passwordHash });
    return json({ data: user }, 201);
  } catch (error) {
    if (error instanceof ValidationError) {
      return json({ error: error.message }, 400);
    }
    if (isUniqueViolation(error)) {
      return json({ error: "Ya existe una cuenta con ese email." }, 409);
    }
    console.error("register failed", error);
    return json({ error: "No se pudo crear la cuenta." }, 503);
  }
}

function json(body: unknown, status: number): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}
