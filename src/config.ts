import type { ModelRef } from "./domain/types.ts";

export type OpencodeConfig = {
  url: string;
  username: string;
  password: string;
  model: ModelRef | null;
  autoApprovePermissions: boolean;
  startupTimeoutMs: number;
};

export type GithubLabels = {
  inProgress: string;
  inReview: string;
  blocked: string;
  ready: string | null;
  skip: string[];
};

export type GithubConfig = {
  token: string;
  apiUrl: string;
  draft: boolean;
  labels: GithubLabels;
};

export type GitConfig = {
  authorName: string;
  authorEmail: string;
  token: string | null;
};

export type FactoryConfig = {
  port: number;
  apiToken: string;
  dataDir: string;
  pollIntervalMs: number;
  workerIntervalMs: number;
  stepTimeoutMs: number;
  testTimeoutMs: number;
  maxRework: number;
  testCommand: string | null;
  setupCommand: string | null;
  deliveryMode: "github" | "local";
  autoMerge: boolean;
  mergeMethod: "merge" | "squash" | "rebase";
  reworkOnChangesRequested: boolean;
  triagePrComments: boolean;
  feedbackUsers: string[];
  opencode: OpencodeConfig;
  github: GithubConfig;
  git: GitConfig;
  databaseUrl: string;
};

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n- ${problems.join("\n- ")}`);
    this.name = "ConfigError";
  }
}

export function parseModel(value: string | undefined | null): ModelRef | null {
  const raw = value?.trim();
  if (!raw) return null;

  const [ref, variant] = splitVariant(raw);
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) {
    throw new ConfigError([
      `FACTORY_MODEL must use "provider/model" format, got "${raw}"`,
    ]);
  }

  const model: ModelRef = {
    providerID: ref.slice(0, slash),
    id: ref.slice(slash + 1),
  };
  if (variant) model.variant = variant;
  return model;
}

function splitVariant(value: string): [string, string | undefined] {
  const hash = value.lastIndexOf("#");
  if (hash <= 0) return [value, undefined];
  return [value.slice(0, hash), value.slice(hash + 1)];
}

function envNumber(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new ConfigError([`${name} must be a positive number, got "${raw}"`]);
  }
  return value;
}

function envBool(
  env: Record<string, string | undefined>,
  name: string,
  fallback: boolean,
): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new ConfigError([`${name} must be a boolean, got "${raw}"`]);
}

function required(
  env: Record<string, string | undefined>,
  name: string,
  problems: string[],
): string {
  const value = env[name]?.trim();
  if (!value) problems.push(`${name} is required`);
  return value ?? "";
}

function optional(
  env: Record<string, string | undefined>,
  name: string,
): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

function envList(
  env: Record<string, string | undefined>,
  name: string,
  fallback: string,
): string[] {
  return (env[name]?.trim() || fallback)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function repositoryFromUrl(repoUrl: string): string | null {
  const match = repoUrl.match(
    /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
  );
  if (!match?.[1] || !match[2]) return null;
  return `${match[1]}/${match[2]}`;
}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): FactoryConfig {
  const problems: string[] = [];

  const deliveryMode = (env.FACTORY_DELIVERY_MODE?.trim() || "github") as
    | "github"
    | "local";
  if (deliveryMode !== "github" && deliveryMode !== "local") {
    problems.push('FACTORY_DELIVERY_MODE must be "github" or "local"');
  }
  const mergeMethod = (env.FACTORY_MERGE_METHOD?.trim() || "squash") as
    | "merge"
    | "squash"
    | "rebase";
  if (!["merge", "squash", "rebase"].includes(mergeMethod)) {
    problems.push(
      'FACTORY_MERGE_METHOD must be "merge", "squash" or "rebase"',
    );
  }

  const githubToken = required(env, "GITHUB_TOKEN", problems);

  let model: ModelRef | null = null;
  try {
    model = parseModel(env.FACTORY_MODEL);
  } catch (error) {
    if (error instanceof ConfigError) problems.push(...error.problems);
    else throw error;
  }

  const databaseUrl = required(env, "DATABASE_URL", problems);
  const apiToken = required(env, "FACTORY_API_TOKEN", problems);
  if (apiToken && apiToken.length < 16) {
    problems.push("FACTORY_API_TOKEN must be at least 16 characters");
  }
  const opencodePassword = optional(env, "OPENCODE_SERVER_PASSWORD") ?? "";
  const opencodeUrl = required(env, "FACTORY_OPENCODE_URL", problems);

  const config: FactoryConfig = {
    port: envNumber(env, "FACTORY_PORT", 3000),
    apiToken,
    dataDir: optional(env, "FACTORY_DATA_DIR") ?? "/data",
    pollIntervalMs: envNumber(env, "FACTORY_POLL_INTERVAL_MS", 15_000),
    workerIntervalMs: envNumber(env, "FACTORY_WORKER_INTERVAL_MS", 5_000),
    stepTimeoutMs: envNumber(env, "FACTORY_STEP_TIMEOUT_MS", 30 * 60_000),
    testTimeoutMs: envNumber(env, "FACTORY_TEST_TIMEOUT_MS", 20 * 60_000),
    maxRework: envNumber(env, "FACTORY_MAX_REWORK", 3),
    testCommand: optional(env, "FACTORY_TEST_CMD"),
    setupCommand: optional(env, "FACTORY_SETUP_CMD"),
    deliveryMode,
    autoMerge: envBool(env, "FACTORY_AUTO_MERGE", false),
    mergeMethod,
    reworkOnChangesRequested: envBool(
      env,
      "FACTORY_REWORK_ON_CHANGES_REQUESTED",
      true,
    ),
    triagePrComments: envBool(env, "FACTORY_TRIAGE_PR_COMMENTS", true),
    feedbackUsers: envList(env, "FACTORY_FEEDBACK_USERS", "").map((user) =>
      user.toLowerCase(),
    ),
    databaseUrl,
    opencode: {
      url: opencodeUrl.replace(/\/+$/, ""),
      username: optional(env, "OPENCODE_SERVER_USERNAME") ?? "opencode",
      password: opencodePassword,
      model,
      autoApprovePermissions: envBool(
        env,
        "FACTORY_AUTO_APPROVE_PERMISSIONS",
        true,
      ),
      startupTimeoutMs: envNumber(env, "FACTORY_OPENCODE_STARTUP_TIMEOUT_MS", 90_000),
    },
    github: {
      token: githubToken,
      apiUrl: (optional(env, "GITHUB_API_URL") ?? "https://api.github.com").replace(
        /\/+$/,
        "",
      ),
      draft: envBool(env, "FACTORY_PR_DRAFT", false),
      labels: {
        inProgress:
          optional(env, "FACTORY_LABEL_IN_PROGRESS") ?? "factory:in-progress",
        inReview: optional(env, "FACTORY_LABEL_IN_REVIEW") ?? "factory:in-review",
        blocked: optional(env, "FACTORY_LABEL_BLOCKED") ?? "factory:blocked",
        ready: optional(env, "FACTORY_LABEL_READY"),
        skip: envList(env, "FACTORY_SKIP_LABELS", "factory:skip"),
      },
    },
    git: {
      authorName: optional(env, "FACTORY_GIT_AUTHOR_NAME") ?? "Software Factory",
      authorEmail:
        optional(env, "FACTORY_GIT_AUTHOR_EMAIL") ?? "factory@localhost",
      token: githubToken,
    },
  };

  if (!opencodePassword) {
    problems.push("OPENCODE_SERVER_PASSWORD is required (shared with the opencode service)");
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}
