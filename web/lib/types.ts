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
  state: string;
  repoUrl: string;
  branch: string | null;
  prUrl: string | null;
  blockReason: string | null;
  reworkCount?: number;
  ticket: Ticket;
  artifacts?: Artifact[];
};

export type RunsResponse = { data: Run[] };
export type RunResponse = { data: Run };
export type ErrorResponse = { error?: string };
