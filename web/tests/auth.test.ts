import { describe, expect, test } from "vitest";
import {
  isVerifiedOAuthEmail,
  profileEmail,
  profileImage,
  profileName,
} from "../lib/auth/oauth";
import { hashPassword, verifyPassword } from "../lib/auth/password";
import { safeNextPath } from "../lib/auth/redirect";
import { constantTimeEqual } from "../lib/auth/secure";
import {
  normalizeEmail,
  normalizeName,
  readPasswordInput,
  validateNewPassword,
  ValidationError,
} from "../lib/auth/validation";

describe("web password hashing", () => {
  test("verifies the right password and rejects the wrong one", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(
      true,
    );
    expect(await verifyPassword("wrong password", hash)).toBe(false);
  });

  test("rejects malformed stored hashes", async () => {
    expect(await verifyPassword("anything", "not-a-hash")).toBe(false);
    expect(await verifyPassword("anything", "scrypt$1$2$3$x$y")).toBe(false);
  });
});

describe("web auth validation", () => {
  test("normalizes email and name", () => {
    expect(normalizeEmail("  Alice@Example.COM ")).toBe("alice@example.com");
    expect(normalizeName("  Alice  ")).toBe("Alice");
    expect(normalizeName(undefined)).toBe("");
  });

  test("enforces password rules", () => {
    expect(validateNewPassword("long-enough")).toBe("long-enough");
    expect(() => validateNewPassword("short")).toThrow(ValidationError);
    expect(() => validateNewPassword("          ")).toThrow(ValidationError);
    expect(() => readPasswordInput("")).toThrow(ValidationError);
  });

  test("compares secrets without leaking content", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });
});

describe("OAuth profiles", () => {
  test("extracts and normalizes profile fields", () => {
    const google = {
      email: " Alice@Example.COM ",
      name: "Alice",
      picture: "https://example.com/alice.png",
    };
    expect(profileEmail(google)).toBe("alice@example.com");
    expect(profileName(google, "alice@example.com")).toBe("Alice");
    expect(profileImage(google)).toBe("https://example.com/alice.png");

    const github = { avatar_url: "https://example.com/a.png", login: "alice" };
    expect(profileName(github, "alice@example.com")).toBe("alice");
    expect(profileImage(github)).toBe("https://example.com/a.png");
  });

  test("only trusts verified emails", () => {
    expect(
      isVerifiedOAuthEmail("google", {
        email: "alice@example.com",
        email_verified: true,
      }),
    ).toBe(true);
    expect(
      isVerifiedOAuthEmail("google", {
        email: "alice@example.com",
        email_verified: false,
      }),
    ).toBe(false);
    expect(
      isVerifiedOAuthEmail("apple", {
        email: "alice@example.com",
        email_verified: "true",
      }),
    ).toBe(true);
    expect(
      isVerifiedOAuthEmail("apple", {
        email: "alice@example.com",
        email_verified: "false",
      }),
    ).toBe(false);
    expect(
      isVerifiedOAuthEmail("github", { email: "alice@example.com" }),
    ).toBe(true);
    expect(
      isVerifiedOAuthEmail("azure-ad", { email: "alice@example.com" }),
    ).toBe(true);
    expect(isVerifiedOAuthEmail("google", { email: "alice@example.com" })).toBe(
      false,
    );
    expect(isVerifiedOAuthEmail("github", {})).toBe(false);
  });
});

describe("post-login redirects", () => {
  test("only allows same-origin paths", () => {
    expect(safeNextPath("/runs/123?x=1")).toBe("/runs/123?x=1");
    expect(safeNextPath("//evil.example")).toBe("/");
    expect(safeNextPath("https://evil.example")).toBe("/");
    expect(safeNextPath(undefined)).toBe("/");
  });
});
