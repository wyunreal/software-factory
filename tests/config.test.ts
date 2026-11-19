import { describe, expect, test } from "bun:test";
import {
  ConfigError,
  loadConfig,
  parseModel,
  repositoryFromUrl,
} from "../src/config.ts";

describe("model parsing", () => {
  test("parses provider/model and variant", () => {
    expect(parseModel("anthropic/claude-sonnet-4-5#high")).toEqual({
      providerID: "anthropic",
      id: "claude-sonnet-4-5",
      variant: "high",
    });
  });

  test("accepts provider IDs containing slashes in the model", () => {
    expect(parseModel("openrouter/meta-llama/llama-3#low")).toEqual({
      providerID: "openrouter",
      id: "meta-llama/llama-3",
      variant: "low",
    });
  });

  test("returns null for empty values", () => {
    expect(parseModel(undefined)).toBeNull();
    expect(parseModel("")).toBeNull();
  });

  test("rejects invalid model references", () => {
    expect(() => parseModel("gpt-5")).toThrow(ConfigError);
  });
});

describe("repository URL parsing", () => {
  test("extracts github owner/repo from https and ssh URLs", () => {
    expect(repositoryFromUrl("https://github.com/acme/app.git")).toBe("acme/app");
    expect(repositoryFromUrl("git@github.com:acme/app.git")).toBe("acme/app");
  });

  test("returns null for local paths", () => {
    expect(repositoryFromUrl("/srv/git/app.git")).toBeNull();
  });
});

const baseEnv = {
  DATABASE_URL: "postgres://factory:factory@localhost:5432/factory",
  GITHUB_TOKEN: "ghp_test",
  OPENCODE_SERVER_PASSWORD: "secret",
  FACTORY_OPENCODE_URL: "http://opencode:4096",
};

describe("configuration", () => {
  test("loads a valid environment with defaults", () => {
    const config = loadConfig(baseEnv);
    expect(config.github.labels.inProgress).toBe("factory:in-progress");
    expect(config.github.labels.inReview).toBe("factory:in-review");
    expect(config.github.labels.blocked).toBe("factory:blocked");
    expect(config.github.labels.skip).toEqual(["factory:skip"]);
    expect(config.deliveryMode).toBe("github");
    expect(config.autoMerge).toBe(false);
    expect(config.mergeMethod).toBe("squash");
    expect(config.reworkOnChangesRequested).toBe(true);
    expect(config.triagePrComments).toBe(true);
    expect(config.feedbackUsers).toEqual([]);
    expect(config.maxRework).toBe(3);
  });

  test("reports all missing required values at once", () => {
    try {
      loadConfig({});
      throw new Error("expected loadConfig to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const problems = (error as ConfigError).problems.join("\n");
      expect(problems).toContain("DATABASE_URL");
      expect(problems).toContain("GITHUB_TOKEN");
      expect(problems).toContain("OPENCODE_SERVER_PASSWORD");
      expect(problems).toContain("FACTORY_OPENCODE_URL");
    }
  });

  test("local delivery still requires GitHub for the issue backlog", () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        FACTORY_DELIVERY_MODE: "local",
        GITHUB_TOKEN: "",
      }),
    ).toThrow(ConfigError);

    const config = loadConfig({
      ...baseEnv,
      FACTORY_DELIVERY_MODE: "local",
    });
    expect(config.deliveryMode).toBe("local");
    expect(config.github.token).toBe("ghp_test");
  });

  test("custom labels are loaded", () => {
    const config = loadConfig({
      ...baseEnv,
      FACTORY_LABEL_IN_PROGRESS: "state/doing",
      FACTORY_LABEL_READY: "state/ready",
      FACTORY_SKIP_LABELS: "wontfix, factory:skip",
      FACTORY_FEEDBACK_USERS: "Alice, Bob",
    });
    expect(config.github.labels.inProgress).toBe("state/doing");
    expect(config.github.labels.ready).toBe("state/ready");
    expect(config.github.labels.skip).toEqual(["wontfix", "factory:skip"]);
    expect(config.feedbackUsers).toEqual(["alice", "bob"]);
  });

  test("auto-merge configuration is parsed", () => {
    const config = loadConfig({
      ...baseEnv,
      FACTORY_AUTO_MERGE: "true",
      FACTORY_MERGE_METHOD: "rebase",
    });
    expect(config.autoMerge).toBe(true);
    expect(config.mergeMethod).toBe("rebase");
    expect(() =>
      loadConfig({ ...baseEnv, FACTORY_MERGE_METHOD: "octopus" }),
    ).toThrow(ConfigError);
  });

  test("rejects unknown delivery modes", () => {
    expect(() =>
      loadConfig({ ...baseEnv, FACTORY_DELIVERY_MODE: "ftp" }),
    ).toThrow(ConfigError);
  });
});
