import { describe, expect, test } from "vitest";
import {
  signInstallState,
  verifyInstallState,
} from "../lib/github/install-state";

const secret = "test-secret-with-at-least-32-characters";
const intent = {
  userId: "usr_1",
  name: "My project",
  repoUrl: "https://github.com/acme/app",
};

describe("GitHub App install state", () => {
  test("signs and verifies an install intent", () => {
    const token = signInstallState(intent, secret, 1_700_000_000_000);
    expect(verifyInstallState(token, secret, 1_700_000_100_000)).toEqual({
      ...intent,
      exp: 1_700_000_900,
    });
  });

  test("rejects tampered, expired, and wrongly signed state", () => {
    const token = signInstallState(intent, secret, 1_700_000_000_000);
    const [version, body, signature] = token.split(".");
    expect(
      verifyInstallState(`${version}.${body}.${signature}x`, secret),
    ).toBeNull();
    expect(
      verifyInstallState(token, "another-secret-with-32-characters!!", 1_700_000_100_000),
    ).toBeNull();
    expect(verifyInstallState(token, secret, 1_700_001_000_000)).toBeNull();
    expect(verifyInstallState("garbage", secret)).toBeNull();
  });
});
