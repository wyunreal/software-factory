import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/**
 * Hash a password with scrypt. The stored format carries the parameters so
 * they can be raised later without breaking existing users.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const n = Number.parseInt(parts[1] ?? "", 10);
  const r = Number.parseInt(parts[2] ?? "", 10);
  const p = Number.parseInt(parts[3] ?? "", 10);
  if (!isSafeParameter(n, r, p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4] ?? "", "base64url");
    expected = Buffer.from(parts[5] ?? "", "base64url");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  const actual = await derive(password, salt, n, r, p, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function isSafeParameter(n: number, r: number, p: number): boolean {
  return (
    Number.isInteger(n) &&
    Number.isInteger(r) &&
    Number.isInteger(p) &&
    n >= 2 ** 12 &&
    n <= 2 ** 20 &&
    r >= 1 &&
    r <= 32 &&
    p >= 1 &&
    p <= 16 &&
    // Bound the memory a tampered stored hash can request (~128 MiB).
    n * r <= 2 ** 19
  );
}

function derive(
  password: string,
  salt: Buffer,
  n: number,
  r: number,
  p: number,
  keyLength = KEY_LENGTH,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      keyLength,
      { N: n, r, p, maxmem: 128 * n * r * 2 + 1024 * 1024 },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      },
    );
  });
}
