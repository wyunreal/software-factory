import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { FactoryConfig } from "../config.ts";
import { repositoryFromUrl } from "../config.ts";
import type { CommitResult, Run, TestResult } from "../domain/types.ts";
import { slugify } from "../domain/ticket.ts";
import type { WorkspacePort } from "../ports.ts";
import type { Logger } from "../logger.ts";
import { truncate } from "../util.ts";
import { BlockedError } from "../errors.ts";

type ExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

type FactoryRepoConfig = {
  setup?: string;
  test?: string;
};

export class GitError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number,
    public readonly stderr: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

export function branchForRun(run: Run): string {
  return `factory/${slugify(run.ticket.ref)}-${run.id.slice(0, 8)}`;
}

export class GitWorkspace implements WorkspacePort {
  private readonly gitEnv: Record<string, string | undefined>;

  constructor(
    private readonly config: FactoryConfig,
    private readonly logger: Logger,
  ) {
    this.gitEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: config.git.authorName,
      GIT_AUTHOR_EMAIL: config.git.authorEmail,
      GIT_COMMITTER_NAME: config.git.authorName,
      GIT_COMMITTER_EMAIL: config.git.authorEmail,
    };
  }

  async ensureRepository(repoUrl: string): Promise<string> {
    if (!repoUrl) throw new Error("A repository URL is required");

    const repoDir = this.repoDirFor(repoUrl);
    if (existsSync(join(repoDir, ".git"))) {
      await this.git(["fetch", "--prune", "origin"], repoDir, { auth: true });
      return repoDir;
    }

    mkdirSync(join(this.config.dataDir, "repos"), { recursive: true });
    this.logger.info("cloning target repository", { repo: repoUrl });
    await this.git(
      ["clone", "--origin", "origin", repoUrl, repoDir],
      this.config.dataDir,
      { auth: true },
    );
    await this.git(
      ["config", "user.name", this.config.git.authorName],
      repoDir,
    );
    await this.git(
      ["config", "user.email", this.config.git.authorEmail],
      repoDir,
    );
    return repoDir;
  }

  async prepare(run: Run): Promise<{
    directory: string;
    branch: string;
    setupCommand: string | null;
    testCommand: string | null;
  }> {
    const repoUrl = run.repoUrl;
    if (!repoUrl) {
      throw new BlockedError("Run has no repository URL");
    }
    const baseBranch = run.baseBranch;
    const repoDir = await this.ensureRepository(repoUrl);
    const repoConfig = await this.readFactoryConfig(repoDir, baseBranch);
    const setupCommand =
      run.setupCommand ?? repoConfig.setup ?? this.config.setupCommand;
    const testCommand =
      run.testCommand ?? repoConfig.test ?? this.config.testCommand;

    const branch = run.branch ?? branchForRun(run);
    const directory =
      run.worktree ??
      join(
        this.config.dataDir,
        "worktrees",
        `${slugify(run.ticket.ref)}-${run.id.slice(0, 8)}`,
      );

    if (existsSync(directory)) {
      const check = await this.exec(["rev-parse", "--is-inside-work-tree"], directory, {
        allowFailure: true,
      });
      if (check.exitCode === 0 && check.stdout.trim() === "true") {
        this.logger.info("reusing existing worktree", { directory, branch });
        await this.configureWorktreeUser(directory);
        await this.runSetup(directory, setupCommand);
        return { directory, branch, setupCommand, testCommand };
      }
    }

    mkdirSync(join(this.config.dataDir, "worktrees"), { recursive: true });
    await this.git(["worktree", "prune"], repoDir);
    await this.git(
      [
        "worktree",
        "add",
        "--force",
        "-B",
        branch,
        directory,
        `origin/${baseBranch}`,
      ],
      repoDir,
    );
    await this.configureWorktreeUser(directory);
    this.logger.info("worktree created", { directory, branch });
    await this.runSetup(directory, setupCommand);
    return { directory, branch, setupCommand, testCommand };
  }

  async commit(run: Run, message: string): Promise<CommitResult> {
    const directory = run.worktree;
    if (!directory) throw new Error(`Run ${run.id} has no worktree`);

    await this.git(["add", "-A"], directory);
    const staged = await this.exec(["diff", "--cached", "--quiet"], directory, {
      allowFailure: true,
    });

    if (staged.exitCode !== 0) {
      await this.git(["commit", "-m", message], directory);
      const sha = (await this.git(["rev-parse", "HEAD"], directory)).stdout.trim();
      return { changed: true, sha };
    }

    const ahead = await this.commitsAhead(directory, run.baseBranch);
    if (ahead > 0) {
      const sha = (await this.git(["rev-parse", "HEAD"], directory)).stdout.trim();
      return { changed: true, sha };
    }

    return { changed: false, sha: null };
  }

  async diffStat(run: Run): Promise<string> {
    if (!run.worktree) return "";
    const result = await this.git(
      ["diff", "--stat", `origin/${run.baseBranch}...HEAD`],
      run.worktree,
    );
    return result.stdout.trim();
  }

  async runTests(run: Run): Promise<TestResult> {
    const command = run.testCommand ?? this.config.testCommand;
    if (!command) {
      return {
        skipped: true,
        passed: true,
        exitCode: null,
        timedOut: false,
        command: "",
        output:
          "No test command configured (run.testCommand, .factory.yml or FACTORY_TEST_CMD); deterministic test gate skipped.",
        durationMs: 0,
      };
    }
    if (!run.worktree) throw new Error(`Run ${run.id} has no worktree`);

    const started = Date.now();
    const result = await this.execShell(
      command,
      run.worktree,
      this.config.testTimeoutMs,
    );
    const output = truncate(
      `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.trim(),
      100_000,
    );

    return {
      skipped: false,
      passed: result.exitCode === 0 && !result.timedOut,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      command,
      output,
      durationMs: Date.now() - started,
    };
  }

  async push(run: Run): Promise<void> {
    if (!run.worktree) throw new Error(`Run ${run.id} has no worktree`);
    if (!run.branch) throw new Error(`Run ${run.id} has no branch`);
    await this.git(
      ["push", "--force", "origin", `HEAD:refs/heads/${run.branch}`],
      run.worktree,
      { auth: true },
    );
  }

  private repoDirFor(repoUrl: string): string {
    const repoName =
      repositoryFromUrl(repoUrl) ?? basename(repoUrl, ".git");
    return join(
      this.config.dataDir,
      "repos",
      slugify(repoName) || "repo",
    );
  }

  private async readFactoryConfig(
    repoDir: string,
    baseBranch: string,
  ): Promise<FactoryRepoConfig> {
    const result = await this.exec(
      ["show", `origin/${baseBranch}:.factory.yml`],
      repoDir,
      { allowFailure: true },
    );
    if (result.exitCode !== 0) return {};
    return parseFactoryConfig(result.stdout);
  }

  private async configureWorktreeUser(directory: string): Promise<void> {
    await this.git(["config", "user.name", this.config.git.authorName], directory);
    await this.git(
      ["config", "user.email", this.config.git.authorEmail],
      directory,
    );
  }

  private async runSetup(directory: string, command: string | null): Promise<void> {
    if (!command) return;

    this.logger.info("running setup command", { command, directory });
    const result = await this.execShell(
      command,
      directory,
      this.config.testTimeoutMs,
    );
    if (result.exitCode !== 0 || result.timedOut) {
      const output = truncate(`${result.stdout}\n${result.stderr}`.trim(), 3_000);
      throw new BlockedError(
        `Setup command failed (exit ${result.exitCode ?? "killed"}${
          result.timedOut ? ", timed out" : ""
        }):\n${output}`,
      );
    }
    this.logger.info("setup command finished");
  }

  private async commitsAhead(directory: string, baseBranch: string): Promise<number> {
    const result = await this.git(
      ["rev-list", "--count", `origin/${baseBranch}..HEAD`],
      directory,
    );
    return Number.parseInt(result.stdout.trim(), 10) || 0;
  }

  private authArgs(): string[] {
    const token = this.config.git.token;
    if (!token) return [];
    const encoded = Buffer.from(`x-access-token:${token}`).toString("base64");
    return ["-c", `http.extraheader=AUTHORIZATION: basic ${encoded}`];
  }

  private async git(
    args: string[],
    cwd: string,
    options: { allowFailure?: boolean; auth?: boolean } = {},
  ): Promise<ExecResult> {
    return this.exec(args, cwd, options);
  }

  private async exec(
    args: string[],
    cwd: string,
    options: { allowFailure?: boolean; auth?: boolean } = {},
  ): Promise<ExecResult> {
    const fullArgs = [
      "-c",
      "safe.directory=*",
      ...(options.auth ? this.authArgs() : []),
      ...args,
    ];
    this.logger.debug("git", { args: args.join(" "), cwd });

    const proc = Bun.spawn(["git", ...fullArgs], {
      cwd,
      env: this.gitEnv,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const result = { exitCode, stdout, stderr, timedOut: false };

    if (exitCode !== 0 && !options.allowFailure) {
      throw new GitError(
        `git ${args[0] ?? ""} failed with exit code ${exitCode}: ${truncate(stderr.trim(), 2_000)}`,
        exitCode,
        stderr,
      );
    }
    return result;
  }

  private async execShell(
    command: string,
    cwd: string,
    timeoutMs: number,
  ): Promise<ExecResult> {
    this.logger.info("running command", { command, cwd });
    const proc = Bun.spawn(["sh", "-lc", command], {
      cwd,
      env: { ...process.env, CI: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill(9);
    }, timeoutMs);

    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { exitCode, stdout, stderr, timedOut };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function parseFactoryConfig(text: string): FactoryRepoConfig {
  const result: FactoryRepoConfig = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(setup|test)\s*:\s*(.+?)\s*$/.exec(line);
    if (!match?.[1] || !match[2]) continue;
    const value = match[2].replace(/^["']|["']$/g, "").trim();
    if (!value) continue;
    if (match[1] === "setup") result.setup = value;
    else result.test = value;
  }
  return result;
}
