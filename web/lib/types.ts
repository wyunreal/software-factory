export type Ticket = {
  ref?: string;
  title?: string;
  number?: number;
};

export type Artifact = {
  name: string;
};

export type Run = {
  id: string;
  ownerUserId?: string | null;
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
export type ErrorResponse = { error?: string };
