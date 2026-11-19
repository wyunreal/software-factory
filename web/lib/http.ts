import type { ErrorResponse } from "./types";

export class ApiError extends Error {}

export async function readJson<T>(response: Response): Promise<T> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    throw new ApiError(`HTTP ${response.status}`);
  }
  if (!response.ok) {
    const message = (body as ErrorResponse | null)?.error ?? `HTTP ${response.status}`;
    throw new ApiError(message);
  }
  return body as T;
}
