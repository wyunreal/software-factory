import type { ErrorResponse } from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function readJson<T>(response: Response): Promise<T> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    throw new ApiError(`HTTP ${response.status}`, response.status);
  }
  if (!response.ok) {
    const message =
      (body as ErrorResponse | null)?.error ?? `HTTP ${response.status}`;
    throw new ApiError(message, response.status, body);
  }
  return body as T;
}
