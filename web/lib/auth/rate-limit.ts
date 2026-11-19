type Bucket = {
  count: number;
  resetAt: number;
};

type LimitGlobals = typeof globalThis & {
  __factoryAuthLimits?: Map<string, Bucket>;
};

const globals = globalThis as LimitGlobals;

export type RateLimitResult = {
  allowed: boolean;
  retryAfterSeconds: number;
};

/**
 * Small in-memory fixed-window limiter. It is enough for a single webapp
 * instance; a multi-instance deployment should move this to a shared store.
 */
export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): RateLimitResult {
  const buckets = (globals.__factoryAuthLimits ??= new Map());
  if (buckets.size > 5_000) pruneExpired(buckets, now);

  const current = buckets.get(key);
  if (!current || current.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  current.count += 1;
  if (current.count <= limit) {
    return { allowed: true, retryAfterSeconds: 0 };
  }
  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
  };
}

type HeaderSource =
  | Headers
  | Record<string, string | string[] | undefined>;

export function clientAddress(request: { headers?: HeaderSource }): string {
  const forwarded = readHeader(request.headers, "x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  if (first) return first;
  return readHeader(request.headers, "x-real-ip")?.trim() || "local";
}

function readHeader(headers: HeaderSource | undefined, name: string): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  const match = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name,
  )?.[1];
  if (Array.isArray(match)) return match.join(", ");
  return match ?? null;
}

function pruneExpired(buckets: Map<string, Bucket>, now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}
