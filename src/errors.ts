export class BlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedError";
  }
}

export class AgentTimeoutError extends BlockedError {
  constructor(message: string) {
    super(message);
    this.name = "AgentTimeoutError";
  }
}

export class ExternalServiceError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ExternalServiceError";
  }
}

export class TransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Invalid run transition: ${from} -> ${to}`);
    this.name = "TransitionError";
  }
}
