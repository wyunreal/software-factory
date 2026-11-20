import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import type { GithubConfig } from "./config.ts";
import { ExternalServiceError } from "./errors.ts";
import type { Logger } from "./logger.ts";
import type { GitHubAuthPort } from "./ports.ts";

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

const INSTALLATION_TTL_MS = 5 * 60_000;
const JWT_TTL_MS = 8 * 60_000;
const TOKEN_SAFETY_MS = 60_000;

/**
 * Authenticates as a GitHub App and obtains short-lived installation tokens.
 * A token is scoped to one installation, so the factory never needs a PAT with
 * access to every target repository.
 */
export class GitHubAppAuth implements GitHubAuthPort {
  private key: KeyObject | null = null;
  private jwt: CacheEntry<string> | null = null;
  private readonly installations = new Map<
    string,
    CacheEntry<number | null>
  >();
  private readonly tokens = new Map<number, CacheEntry<string>>();

  constructor(
    private readonly config: GithubConfig,
    private readonly logger: Logger,
  ) {}

  async validate(): Promise<void> {
    const response = await this.request("/app", this.appJwt(), "GET");
    if (!response.ok) {
      throw await githubError(response, "credentials validation");
    }
    const body = (await response.json()) as { slug?: unknown };
    this.logger.info("GitHub App credentials validated", {
      appId: this.config.appId,
      slug: typeof body.slug === "string" ? body.slug : this.config.slug,
    });
  }

  async installationIdForRepository(
    repository: string,
  ): Promise<number | null> {
    const repo = normalizeRepo(repository);
    const cached = this.installations.get(repo);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const response = await this.request(
      `/repos/${repo}/installation`,
      this.appJwt(),
      "GET",
    );
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw await githubError(response, "installation lookup");
    }

    const body = (await response.json()) as { id?: unknown };
    const id = Number(body.id);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`GitHub returned an invalid installation for ${repo}`);
    }

    this.installations.set(repo, {
      value: id,
      expiresAt: Date.now() + INSTALLATION_TTL_MS,
    });
    return id;
  }

  async tokenForRepository(repository: string): Promise<string> {
    const repo = normalizeRepo(repository);
    const installationId = await this.installationIdForRepository(repo);
    if (!installationId) {
      throw new Error(`GitHub App is not installed on ${repo}`);
    }
    return this.installationToken(installationId);
  }

  private async installationToken(installationId: number): Promise<string> {
    const cached = this.tokens.get(installationId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const response = await this.request(
      `/app/installations/${installationId}/access_tokens`,
      this.appJwt(),
      "POST",
    );
    if (!response.ok) {
      throw await githubError(response, "installation token");
    }

    const body = (await response.json()) as {
      token?: unknown;
      expires_at?: unknown;
    };
    const token = typeof body.token === "string" ? body.token : "";
    const expiresAt = Date.parse(String(body.expires_at ?? ""));
    if (!token || !Number.isFinite(expiresAt)) {
      throw new Error("GitHub returned an invalid installation token");
    }

    this.tokens.set(installationId, {
      value: token,
      expiresAt: expiresAt - TOKEN_SAFETY_MS,
    });
    return token;
  }

  private appJwt(): string {
    const now = Date.now();
    if (this.jwt && this.jwt.expiresAt > now) return this.jwt.value;

    const issuedAt = Math.floor(now / 1000) - 60;
    const expiresAt = Math.floor(now / 1000) + 9 * 60;
    const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = base64url(
      JSON.stringify({
        iat: issuedAt,
        exp: expiresAt,
        iss: this.config.appId,
      }),
    );
    const signingInput = `${header}.${payload}`;
    const signingKey = this.signingKey();
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();
    const token = `${signingInput}.${signer
      .sign(signingKey)
      .toString("base64url")}`;

    this.jwt = { value: token, expiresAt: now + JWT_TTL_MS };
    return token;
  }

  private signingKey(): KeyObject {
    if (!this.key) {
      try {
        this.key = createPrivateKey(this.config.privateKey);
      } catch (error) {
        throw new Error(
          `Invalid GITHUB_APP_PRIVATE_KEY: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return this.key;
  }

  private async request(
    path: string,
    token: string,
    method: "GET" | "POST",
  ): Promise<Response> {
    return fetch(`${this.config.apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "software-factory",
      },
      signal: AbortSignal.timeout(30_000),
    });
  }
}

async function githubError(
  response: Response,
  action: string,
): Promise<ExternalServiceError> {
  const detail = (await response.text()).slice(0, 800);
  return new ExternalServiceError(
    `GitHub App ${action} failed with ${response.status}: ${detail}`,
    response.status,
  );
}

function normalizeRepo(repository: string): string {
  const repo = repository.trim().replace(/^\/+|\/+$/g, "");
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo)) {
    throw new Error(`Invalid GitHub repository: ${repository}`);
  }
  return repo;
}

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}
