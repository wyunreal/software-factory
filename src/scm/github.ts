import type { GithubConfig } from "../config.ts";
import type {
  AutoMergePort,
  DeliveryPort,
  FeedbackPort,
  PullRequestConversationComment,
  PullRequestInput,
  PullRequestReview,
  PullRequestReviewComment,
  PullRequestState,
} from "../ports.ts";
import { ExternalServiceError } from "../errors.ts";
import type { Logger } from "../logger.ts";

type PullRequest = { html_url: string; number: number };

type GitHubReview = {
  id?: number;
  user?: { login?: string };
  state?: string;
  body?: string;
  submitted_at?: string;
};

type GitHubReviewComment = {
  id?: number;
  pull_request_review_id?: number;
  user?: { login?: string };
  author_association?: string;
  path?: string;
  line?: number;
  body?: string;
  created_at?: string;
};

type GitHubConversationComment = {
  id?: number;
  user?: { login?: string };
  author_association?: string;
  body?: string;
  created_at?: string;
};

type GitHubPullRequest = {
  number: number;
  state: "open" | "closed";
  draft?: boolean;
  merged?: boolean;
  mergeable?: boolean | null;
  mergeable_state?: string | null;
  head?: { sha?: string };
};

export class GitHubDelivery implements DeliveryPort, AutoMergePort, FeedbackPort {
  constructor(
    private readonly config: GithubConfig,
    private readonly logger: Logger,
  ) {}

  async createPullRequest(input: PullRequestInput): Promise<{ url: string }> {
    const repository = input.repository;
    const owner = repository.split("/")[0];
    if (!owner) {
      throw new ExternalServiceError(`Invalid GitHub repository: ${repository}`);
    }

    const existing = await this.findOpenPullRequest(repository, owner, input.head);
    if (existing) {
      this.logger.info("reusing existing pull request", {
        pr: existing.html_url,
      });
      return { url: existing.html_url };
    }

    const created = await this.request<PullRequest>(
      `/repos/${repository}/pulls`,
      "POST",
      {
        title: input.title,
        head: input.head,
        base: input.base,
        body: input.body,
        draft: input.draft,
      },
    );
    this.logger.info("pull request created", { pr: created.html_url });
    return { url: created.html_url };
  }

  async getPullRequestState(
    repository: string,
    number: number,
  ): Promise<PullRequestState> {
    const pr = await this.request<GitHubPullRequest>(
      `/repos/${repository}/pulls/${number}`,
      "GET",
    );
    return {
      number: pr.number,
      state: pr.state,
      draft: pr.draft ?? false,
      merged: pr.merged ?? false,
      mergeable: pr.mergeable ?? null,
      mergeableState: pr.mergeable_state ?? null,
      headSha: pr.head?.sha ?? "",
    };
  }

  async getPullRequestReviews(
    repository: string,
    number: number,
  ): Promise<PullRequestReview[]> {
    const reviews = await this.request<GitHubReview[]>(
      `/repos/${repository}/pulls/${number}/reviews?per_page=100`,
      "GET",
    );
    return reviews.map((review) => ({
      id: review.id ?? 0,
      user: review.user?.login ?? "",
      state: review.state ?? "",
      body: review.body ?? "",
      submittedAt: review.submitted_at ?? "",
    }));
  }

  async getPullRequestReviewComments(
    repository: string,
    number: number,
  ): Promise<PullRequestReviewComment[]> {
    const comments = await this.request<GitHubReviewComment[]>(
      `/repos/${repository}/pulls/${number}/comments?per_page=100`,
      "GET",
    );
    return comments.map((comment) => ({
      id: comment.id ?? 0,
      reviewId: comment.pull_request_review_id ?? 0,
      user: comment.user?.login ?? "",
      authorAssociation: comment.author_association ?? "",
      path: comment.path ?? null,
      line: comment.line ?? null,
      body: comment.body ?? "",
      createdAt: comment.created_at ?? "",
    }));
  }

  async getPullRequestConversationComments(
    repository: string,
    number: number,
  ): Promise<PullRequestConversationComment[]> {
    const comments = await this.request<GitHubConversationComment[]>(
      `/repos/${repository}/issues/${number}/comments?per_page=100`,
      "GET",
    );
    return comments.map((comment) => ({
      id: comment.id ?? 0,
      user: comment.user?.login ?? "",
      authorAssociation: comment.author_association ?? "",
      body: comment.body ?? "",
      createdAt: comment.created_at ?? "",
    }));
  }

  async replyToReviewComment(
    repository: string,
    number: number,
    commentId: number,
    body: string,
  ): Promise<{ id: number }> {
    const result = await this.request<{ id?: number }>(
      `/repos/${repository}/pulls/${number}/comments/${commentId}/replies`,
      "POST",
      { body },
    );
    return { id: result.id ?? 0 };
  }

  async commentPullRequest(
    repository: string,
    number: number,
    body: string,
  ): Promise<{ id: number }> {
    const result = await this.request<{ id?: number }>(
      `/repos/${repository}/issues/${number}/comments`,
      "POST",
      { body },
    );
    return { id: result.id ?? 0 };
  }

  async requestReReview(
    repository: string,
    number: number,
    reviewers: string[],
  ): Promise<void> {
    if (reviewers.length === 0) return;
    await this.request(
      `/repos/${repository}/pulls/${number}/requested_reviewers`,
      "POST",
      { reviewers },
    );
  }

  async mergePullRequest(
    repository: string,
    number: number,
    method: "merge" | "squash" | "rebase",
    sha: string,
  ): Promise<void> {
    const result = await this.request<{ merged?: boolean; message?: string }>(
      `/repos/${repository}/pulls/${number}/merge`,
      "PUT",
      { merge_method: method, sha },
    );
    if (!result.merged) {
      throw new ExternalServiceError(
        `GitHub refused to merge ${repository}#${number}: ${result.message ?? "unknown reason"}`,
      );
    }
  }

  private async findOpenPullRequest(
    repository: string,
    owner: string,
    head: string,
  ): Promise<PullRequest | null> {
    const params = new URLSearchParams({
      head: `${owner}:${head}`,
      state: "open",
    });
    const pulls = await this.request<PullRequest[]>(
      `/repos/${repository}/pulls?${params}`,
      "GET",
    );
    return pulls[0] ?? null;
  }

  private async request<T>(
    path: string,
    method: string,
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

    return (await response.json()) as T;
  }
}

export class LocalDelivery implements DeliveryPort {
  async createPullRequest(): Promise<{ url: string }> {
    throw new ExternalServiceError(
      "Local delivery mode does not create pull requests",
    );
  }
}
