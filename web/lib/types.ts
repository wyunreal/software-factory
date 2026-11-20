export type Ticket = {
  ref?: string;
  title?: string;
  number?: number;
};

export type Artifact = {
  name: string;
};

export type Project = {
  id: string;
  ownerUserId?: string;
  name: string;
  repo: string;
  repoUrl: string;
  createdAt?: string;
};

export type Run = {
  id: string;
  ownerUserId?: string | null;
  projectId?: string | null;
  state: string;
  repoUrl: string;
  branch: string | null;
  prUrl: string | null;
  blockReason: string | null;
  reworkCount?: number;
  ticket: Ticket;
  artifacts?: Artifact[];
};

export type AuthUser = {
  id: string;
  email: string;
  name: string;
  image?: string | null;
};

export type OAuthProviderInfo = {
  id: string;
  name: string;
};

export type RunsResponse = { data: Run[] };
export type RunResponse = { data: Run };
export type ProjectsResponse = { data: Project[] };
export type ProjectResponse = { data: Project };
export type ErrorResponse = { error?: string };
