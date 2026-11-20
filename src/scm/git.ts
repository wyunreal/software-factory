import { existsSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, join } from "node:path";
import type { FactoryConfig } from "../config.ts";
import { repositoryFromUrl } from "../config.ts";
import type { CommitResult, Run } from "../domain/types.ts";
import { slugify } from "../domain/ticket.ts";
import type { WorkspacePort, GitHubAuthPort } from "../ports.ts";
import type { Logger } from "../logger.ts";
import { truncate } from "../util.ts";
import { BlockedError } from "../errors.ts";

type ExecResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
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
    private readonly auth: GitHubAuthPort,
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
      const token = await this.tokenFor(repoUrl);
      await this.git(["fetch", "--prune", "origin"], repoDir, { token });
      return repoDir;
    }

    mkdirSync(join(this.config.dataDir, "repos"), { recursive: true });
    this.logger.info("cloning target repository", { repo: repoUrl });
    const token = await this.tokenFor(repoUrl);
    await this.git(
      ["clone", "--origin", "origin", repoUrl, repoDir],
      this.config.dataDir,
      { token },
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
  }> {
    const repoUrl = run.repoUrl;
    if (!repoUrl) {
      throw new BlockedError("Run has no repository URL");
    }
    const baseBranch = run.baseBranch;
    const repoDir = await this.ensureRepository(repoUrl);

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
        return { directory, branch };
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
    return { directory, branch };
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

  async push(run: Run): Promise<void> {
    if (!run.worktree) throw new Error(`Run ${run.id} has no worktree`);
    if (!run.branch) throw new Error(`Run ${run.id} has no branch`);
    await this.git(
      ["push", "--force", "origin", `HEAD:refs/heads/${run.branch}`],
      run.worktree,
      { token: await this.tokenFor(run.repoUrl) },
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

  private async configureWorktreeUser(directory: string): Promise<void> {
    await this.git(["config", "user.name", this.config.git.authorName], directory);
    await this.git(
      ["config", "user.email", this.config.git.authorEmail],
      directory,
    );
  }

  private async commitsAhead(directory: string, baseBranch: string): Promise<number> {
    const result = await this.git(
      ["rev-list", "--count", `origin/${baseBranch}..HEAD`],
      directory,
    );
    return Number.parseInt(result.stdout.trim(), 10) || 0;
  }

  private async tokenFor(repoUrl: string): Promise<string | null> {
    const repo = repositoryFromUrl(repoUrl);
    if (!repo) return null;
    return this.auth.tokenForRepository(repo);
  }

  private authArgs(token: string | null): string[] {
    if (!token) return [];
    const encoded = Buffer.from(`x-access-token:${token}`).toString("base64");
    return ["-c", `http.extraheader=AUTHORIZATION: basic ${encoded}`];
  }

  private async git(
    args: string[],
    cwd: string,
    options: { allowFailure?: boolean; token?: string | null } = {},
  ): Promise<ExecResult> {
    return this.exec(args, cwd, options);
  }

  private async exec(
    args: string[],
    cwd: string,
    options: { allowFailure?: boolean; token?: string | null } = {},
  ): Promise<ExecResult> {
    const fullArgs = [
      "-c",
      "safe.directory=*",
      ...(options.token ? this.authArgs(options.token) : []),
      ...args,
    ];
    this.logger.debug("git", { args: args.join(" "), cwd });

    const result = await this.execProcess(
      "git",
      fullArgs,
      cwd,
      this.gitEnv,
    );

    if (result.exitCode !== 0 && !options.allowFailure) {
      throw new GitError(
        `git ${args[0] ?? ""} failed with exit code ${result.exitCode}: ${truncate(result.stderr.trim(), 2_000)}`,
        result.exitCode,
        result.stderr,
      );
    }
    return result;
  }

  private execProcess(
    command: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    timeoutMs?: number,
  ): Promise<ExecResult> {
    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const finish = (exitCode: number): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({ exitCode, stdout, stderr, timedOut });
      };

      if (timeoutMs) {
        timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs);
      }

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", (error) => {
        stderr += `\n${error.message}`;
        finish(127);
      });
      child.on("close", (code) => finish(code ?? 1));
    });
  }
}
