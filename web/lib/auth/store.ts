import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { AuthUser } from "../types";
import { databaseUrl } from "./config";

type UserRow = {
  id: string;
  email: string;
  name: string;
  image: string | null;
  password_hash: string | null;
};

export class AuthStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthStoreError";
  }
}

export type OAuthUserInput = {
  provider: string;
  providerAccountId: string;
  email: string;
  name: string;
  image: string | null;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  email text NOT NULL,
  name text NOT NULL DEFAULT '',
  image text,
  password_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS image text;
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx
  ON users (lower(email));
CREATE TABLE IF NOT EXISTS user_identities (
  provider text NOT NULL,
  provider_account_id text NOT NULL,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_account_id)
);
CREATE INDEX IF NOT EXISTS user_identities_user_idx
  ON user_identities (user_id);
`;

const MIGRATE_TABLE_NAME = `
DO $$
BEGIN
  IF to_regclass('users') IS NULL AND to_regclass('web_users') IS NOT NULL THEN
    ALTER TABLE web_users RENAME TO users;
  END IF;
END;
$$;
`;

type AuthGlobals = typeof globalThis & {
  __factoryAuthPool?: Pool;
  __factoryAuthSchema?: Promise<void>;
};

const globals = globalThis as AuthGlobals;

function pool(): Pool {
  if (!globals.__factoryAuthPool) {
    globals.__factoryAuthPool = new Pool({
      connectionString: databaseUrl(),
      max: 5,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    });
    globals.__factoryAuthPool.on("error", (error) => {
      console.error("auth database pool error", error);
    });
  }
  return globals.__factoryAuthPool;
}

async function ensureSchema(): Promise<void> {
  if (!globals.__factoryAuthSchema) {
    globals.__factoryAuthSchema = initializeSchema().catch((error: unknown) => {
      globals.__factoryAuthSchema = undefined;
      throw error;
    });
  }
  await globals.__factoryAuthSchema;
}

async function initializeSchema(): Promise<void> {
  if (await schemaReady()) return;

  // Preserve accounts created before the table was renamed to `users`.
  await pool().query(MIGRATE_TABLE_NAME);

  // A least-privilege WEB_DATABASE_URL role may not have DDL permissions.
  // If everything is in place, never attempt migrations.
  if (await schemaReady()) return;
  await pool().query(SCHEMA);
}

async function schemaReady(): Promise<boolean> {
  try {
    await pool().query("SELECT image FROM users LIMIT 0");
    await pool().query("SELECT 1 FROM user_identities LIMIT 0");
    return true;
  } catch (error) {
    if (isUndefinedTableOrColumn(error)) return false;
    throw error;
  }
}

function isUndefinedTableOrColumn(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ["42P01", "42703"].includes(String((error as { code?: unknown }).code))
  );
}

export async function createAuthUser(input: {
  email: string;
  name: string;
  passwordHash: string;
}): Promise<AuthUser> {
  await ensureSchema();
  return insertUser({
    email: input.email,
    name: input.name,
    image: null,
    passwordHash: input.passwordHash,
  });
}

export async function createOAuthUser(input: {
  email: string;
  name: string;
  image: string | null;
}): Promise<AuthUser> {
  await ensureSchema();
  return insertUser({ ...input, passwordHash: null });
}

async function insertUser(input: {
  email: string;
  name: string;
  image: string | null;
  passwordHash: string | null;
}): Promise<AuthUser> {
  const id = `usr_${randomUUID()}`;
  const result = await pool().query<AuthUser>(
    `INSERT INTO users (id, email, name, image, password_hash)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, email, name, image`,
    [
      id,
      input.email.toLowerCase(),
      input.name,
      input.image,
      input.passwordHash,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new AuthStoreError("No se pudo crear el usuario.");
  return row;
}

export async function findAuthUserByEmail(
  email: string,
): Promise<(AuthUser & { passwordHash: string | null }) | null> {
  await ensureSchema();
  const result = await pool().query<UserRow>(
    `SELECT id, email, name, image, password_hash
       FROM users
      WHERE lower(email) = $1
      LIMIT 1`,
    [email.toLowerCase()],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    image: row.image,
    passwordHash: row.password_hash,
  };
}

export async function findUserByIdentity(
  provider: string,
  providerAccountId: string,
): Promise<AuthUser | null> {
  await ensureSchema();
  const result = await pool().query<AuthUser>(
    `SELECT u.id, u.email, u.name, u.image
       FROM user_identities i
       JOIN users u ON u.id = i.user_id
      WHERE i.provider = $1 AND i.provider_account_id = $2
      LIMIT 1`,
    [provider, providerAccountId],
  );
  return result.rows[0] ?? null;
}

/**
 * Resolve an OAuth account to a local user.
 *
 * - Existing provider identity: reuse its user.
 * - Same verified email: link the new provider to that user.
 * - Otherwise: create a password-less user and link the identity.
 */
export async function upsertOAuthUser(
  input: OAuthUserInput,
): Promise<AuthUser> {
  await ensureSchema();

  const byIdentity = await findUserByIdentity(
    input.provider,
    input.providerAccountId,
  );
  if (byIdentity) return refreshOAuthUser(byIdentity.id, input);

  const byEmail = await findAuthUserByEmail(input.email);
  if (byEmail) {
    await linkIdentity({
      userId: byEmail.id,
      provider: input.provider,
      providerAccountId: input.providerAccountId,
    });
    return refreshOAuthUser(byEmail.id, input);
  }

  try {
    const created = await createOAuthUser({
      email: input.email,
      name: input.name,
      image: input.image,
    });
    await linkIdentity({
      userId: created.id,
      provider: input.provider,
      providerAccountId: input.providerAccountId,
    });
    return created;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;

    // A concurrent sign-in created the user or the identity first.
    const raced =
      (await findUserByIdentity(input.provider, input.providerAccountId)) ??
      (await findAuthUserByEmail(input.email));
    if (!raced) throw error;
    await linkIdentity({
      userId: raced.id,
      provider: input.provider,
      providerAccountId: input.providerAccountId,
    });
    return refreshOAuthUser(raced.id, input);
  }
}

async function refreshOAuthUser(
  userId: string,
  input: OAuthUserInput,
): Promise<AuthUser> {
  const result = await pool().query<AuthUser>(
    `UPDATE users
        SET name = CASE WHEN $2 = '' THEN name ELSE $2 END,
            image = COALESCE($3, image)
      WHERE id = $1
      RETURNING id, email, name, image`,
    [userId, input.name, input.image],
  );
  const row = result.rows[0];
  if (!row) throw new AuthStoreError("No se encontró el usuario OAuth.");
  return row;
}

async function linkIdentity(input: {
  userId: string;
  provider: string;
  providerAccountId: string;
}): Promise<void> {
  const inserted = await pool().query<{ user_id: string }>(
    `INSERT INTO user_identities (provider, provider_account_id, user_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (provider, provider_account_id) DO NOTHING
     RETURNING user_id`,
    [input.provider, input.providerAccountId, input.userId],
  );
  if (inserted.rows[0]) {
    if (inserted.rows[0].user_id !== input.userId) {
      throw new AuthStoreError("La identidad ya está vinculada a otra cuenta.");
    }
    return;
  }

  const existing = await pool().query<{ user_id: string }>(
    `SELECT user_id
       FROM user_identities
      WHERE provider = $1 AND provider_account_id = $2`,
    [input.provider, input.providerAccountId],
  );
  if (existing.rows[0]?.user_id !== input.userId) {
    throw new AuthStoreError("La identidad ya está vinculada a otra cuenta.");
  }
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}
