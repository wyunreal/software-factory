import { describe, expect, test } from "vitest";
import { verifyGithubSignature } from "../lib/github/webhook";

describe("GitHub webhook signature", () => {
  test("accepts the signature from the GitHub documentation example", () => {
    const payload = "Hello, World!";
    const signature =
      "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
    expect(
      verifyGithubSignature(
        payload,
        signature,
        "It's a Secret to Everybody",
      ),
    ).toBe(true);
  });

  test("rejects missing, malformed and wrong signatures", () => {
    const payload = '{"action":"synchronize"}';
    const secret = "a-test-secret";
    expect(verifyGithubSignature(payload, null, secret)).toBe(false);
    expect(verifyGithubSignature(payload, "sha256=deadbeef", secret)).toBe(
      false,
    );
    expect(
      verifyGithubSignature(payload, "sha1=deadbeef", secret),
    ).toBe(false);
  });
});
