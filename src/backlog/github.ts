import type { BacklogPort } from "../ports.ts";
import type { GithubConfig } from "../config.ts";
import type { Run, Ticket } from "../domain/types.ts";
import { parseAcceptanceCriteria } from "../domain/ticket.ts";
import { ExternalServiceError } from "../errors.ts";
import type { Logger } from "../logger.ts";
import { truncate } from "../util.ts";

type GitHubLabel = { name: string };

type GitHubIssue = {
  id: number;
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  state: "open" | "closed";
  labels: Array<GitHubLabel | string>;
  pull_request?: unknown;
};

export class GitHubIssuesBacklog implements BacklogPort {
  constructor(
    private readonly config: GithubConfig,
    private readonly logger: Logger,
  ) {}

  async validate(): Promise<void> {
    if (!this.config.repository) {
      this.logger.info("GitHub Issues polling disabled (no GITHUB_REPOSITORY); use the webapp/API to start runs");
      return;
    }
    const repo = await this.request<{ full_name: string; open_issues_count?: number }>(
      this.repoPath(this.config.repository),
    );
    await this.ensureLabelsForRepo(this.config.repository);
    this.logger.info("GitHub Issues backlog validated", {
      repository: repo.full_name,
      labels: this.config.labels,
    });
  }

  async ensureLabelsForRepo(repo: string): Promise<void> {
    await Promise.all([
      this.ensureLabel(repo, this.config.labels.inProgress, "fbca04", "Factory: being implemented"),
      this.ensureLabel(repo, this.config.labels.inReview, "1d76db", "Factory: PR ready for human review"),
      this.ensureLabel(repo, this.config.labels.blocked, "d93f0b", "Factory: blocked, needs a human"),
      ...this.config.labels.skip.map((label) =>
        this.ensureLabel(repo, label, "ededed", "Factory: ignore this issue"),
      ),
      ...(this.config.labels.ready
        ? [this.ensureLabel(repo, this.config.labels.ready, "0e8a16", "Factory: ready to be claimed")]
        : []),
    ]);
  }

  async getTicket(repo: string, number: number): Promise<Ticket> {
    await this.ensureLabelsForRepo(repo);
    const issue = await this.request<GitHubIssue>(
      `${this.repoPath(repo)}/issues/${number}`,
    );
    if (issue.pull_request) {
      throw new Error(`#${number} is a pull request, not an issue`);
    }
    if (issue.state !== "open") {
      throw new Error(`Issue #${number} is closed`);
    }
    return this.toTicket(issue, repo);
  }

  async fetchReadyTickets(): Promise<Ticket[]> {
    if (!this.config.repository) return [];
    const issues = await this.listOpenIssues(this.config.repository);
    const stateLabels = new Set([
      this.config.labels.inProgress,
      this.config.labels.inReview,
      this.config.labels.blocked,
    ]);
    const skipLabels = new Set(
      this.config.labels.skip.map((label) => label.toLowerCase()),
    );

    const tickets: Ticket[] = [];
    for (const issue of issues) {
      if (issue.pull_request) continue;
      const labelNames = issue.labels
        .map((label) => (typeof label === "string" ? label : label.name))
        .filter(Boolean);
      const lowerLabels = labelNames.map((label) => label.toLowerCase());

      if (lowerLabels.some((label) => skipLabels.has(label))) continue;
      if (this.config.labels.ready && !labelNames.includes(this.config.labels.ready)) {
        continue;
      }
      if (labelNames.some((label) => stateLabels.has(label))) continue;

      tickets.push(this.toTicket(issue, this.config.repository));
    }

    return tickets;
  }

  async claim(ticket: Ticket, run: Run): Promise<void> {
    await this.moveToInProgress(ticket);
    try {
      await this.comment(
        ticket,
        [
          "🤖 **Software Factory**",
          "",
          `Run: \`${run.id}\``,
          `Ticket: ${ticket.ref}`,
          "State: claimed",
        ].join("\n"),
      );
    } catch (error) {
      this.logger.warn("failed to comment on claimed issue", {
        issue: ticket.number,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async moveToInProgress(ticket: Ticket): Promise<void> {
    await this.addLabel(ticket, this.config.labels.inProgress);
    if (this.config.labels.ready) {
      await this.removeLabel(ticket, this.config.labels.ready);
    }
    await this.removeLabel(ticket, this.config.labels.inReview);
    await this.removeLabel(ticket, this.config.labels.blocked);
  }

  async comment(ticket: Ticket, text: string): Promise<void> {
    await this.request(`${this.issuePath(ticket)}/comments`, "POST", {
      body: truncate(text, 60_000),
    });
  }

  async moveToReview(ticket: Ticket): Promise<void> {
    await this.addLabel(ticket, this.config.labels.inReview);
    await this.removeLabel(ticket, this.config.labels.inProgress);
    await this.removeLabel(ticket, this.config.labels.blocked);
  }

  async moveToBlocked(ticket: Ticket): Promise<void> {
    await this.addLabel(ticket, this.config.labels.blocked);
    await this.removeLabel(ticket, this.config.labels.inProgress);
    await this.removeLabel(ticket, this.config.labels.inReview);
  }

  async isDone(ticket: Ticket): Promise<boolean> {
    const issue = await this.request<GitHubIssue>(this.issuePath(ticket));
    return issue.state === "closed";
  }

  private async listOpenIssues(repo: string): Promise<GitHubIssue[]> {
    const issues: GitHubIssue[] = [];
    for (let page = 1; page <= 5; page++) {
      const params = new URLSearchParams({
        state: "open",
        per_page: "100",
        page: String(page),
        sort: "created",
        direction: "asc",
      });
      if (this.config.labels.ready) {
        params.set("labels", this.config.labels.ready);
      }
      const batch = await this.request<GitHubIssue[]>(
        `${this.repoPath(repo)}/issues?${params}`,
      );
      issues.push(...batch);
      if (batch.length < 100) break;
    }
    return issues;
  }

  private toTicket(issue: GitHubIssue, repo: string): Ticket {
    const description = issue.body ?? "";
    return {
      cardId: String(issue.id),
      number: issue.number,
      ref: `GH-${issue.number}`,
      title: issue.title.trim(),
      description: description.trim(),
      url: issue.html_url,
      labels: issue.labels
        .map((label) => (typeof label === "string" ? label : label.name))
        .filter(Boolean),
      acceptanceCriteria: parseAcceptanceCriteria(description),
      repo,
      repoUrl: `https://github.com/${repo}.git`,
    };
  }

  private repoPath(repo: string): string {
    if (!repo || !repo.includes("/")) {
      throw new Error(`Invalid GitHub repository: ${repo}`);
    }
    return `/repos/${repo}`;
  }

  private issuePath(ticket: Ticket): string {
    const fromRef = /^GH-(\d+)$/i.exec(ticket.ref)?.[1];
    const number = ticket.number ?? (fromRef ? Number(fromRef) : NaN);
    const repo = ticket.repo ?? this.config.repository;
    if (!Number.isInteger(number) || number <= 0) {
      throw new Error(`Invalid GitHub issue number for ticket ${ticket.ref}`);
    }
    return `${this.repoPath(repo)}/issues/${number}`;
  }

  private async addLabel(ticket: Ticket, label: string): Promise<void> {
    if (!label) return;
    await this.request(`${this.issuePath(ticket)}/labels`, "POST", {
      labels: [label],
    });
  }

  private async removeLabel(ticket: Ticket, label: string): Promise<void> {
    if (!label) return;
    try {
      await this.request(
        `${this.issuePath(ticket)}/labels/${encodeURIComponent(label)}`,
        "DELETE",
      );
    } catch (error) {
      if (error instanceof ExternalServiceError && error.status === 404) return;
      throw error;
    }
  }

  private async ensureLabel(
    repo: string,
    name: string,
    color: string,
    description: string,
  ): Promise<void> {
    try {
      await this.request(`${this.repoPath(repo)}/labels`, "POST", {
        name,
        color,
        description,
      });
    } catch (error) {
      // 422 means the label already exists (or the token cannot validate it).
      if (error instanceof ExternalServiceError && error.status === 422) return;
      throw error;
    }
  }

  private async request<T = unknown>(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(`${this.config.apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "software-factory",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 800);
      throw new ExternalServiceError(
        `GitHub ${method} ${path.split("?")[0]} failed with ${response.status}: ${detail}`,
        response.status,
      );
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}
