import { describe, expect, test } from "bun:test";
import { parseFactoryConfig } from "../src/scm/git.ts";

describe(".factory.yml parser", () => {
  test("reads setup and test commands", () => {
    expect(
      parseFactoryConfig(
        `# repo config
setup: bun install
test: bun test
`,
      ),
    ).toEqual({ setup: "bun install", test: "bun test" });
  });

  test("ignores unknown keys and supports quotes", () => {
    expect(
      parseFactoryConfig(`setup: "npm ci"\nfoo: bar\ntest: 'pytest -q'`),
    ).toEqual({ setup: "npm ci", test: "pytest -q" });
  });

  test("returns an empty object when neither key exists", () => {
    expect(parseFactoryConfig("language: python")).toEqual({});
  });
});
