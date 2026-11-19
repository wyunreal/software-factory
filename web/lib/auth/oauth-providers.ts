import type { OAuthProviderInfo } from "../types";

export function googleConfigured(): boolean {
  return Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);
}

export function githubConfigured(): boolean {
  return Boolean(process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET);
}

export function appleConfigured(): boolean {
  return Boolean(process.env.AUTH_APPLE_ID && process.env.AUTH_APPLE_SECRET);
}

export function azureAdConfigured(): boolean {
  return Boolean(
    process.env.AUTH_AZURE_AD_ID && process.env.AUTH_AZURE_AD_SECRET,
  );
}

export function gitlabConfigured(): boolean {
  return Boolean(process.env.AUTH_GITLAB_ID && process.env.AUTH_GITLAB_SECRET);
}

export function configuredOAuthProviders(): OAuthProviderInfo[] {
  const providers: OAuthProviderInfo[] = [];
  if (googleConfigured()) providers.push({ id: "google", name: "Google" });
  if (githubConfigured()) providers.push({ id: "github", name: "GitHub" });
  if (appleConfigured()) providers.push({ id: "apple", name: "Apple" });
  if (azureAdConfigured()) providers.push({ id: "azure-ad", name: "Microsoft" });
  if (gitlabConfigured()) providers.push({ id: "gitlab", name: "GitLab" });
  return providers;
}
