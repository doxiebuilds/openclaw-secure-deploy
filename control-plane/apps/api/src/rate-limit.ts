type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

export function hitRateLimit(
  key: string,
  max: number,
  windowMs: number
): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  const existing = buckets.get(key);
  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterMs: 0 };
  }
  existing.count += 1;
  if (existing.count > max) {
    return { allowed: false, retryAfterMs: Math.max(0, existing.resetAt - now) };
  }
  return { allowed: true, retryAfterMs: 0 };
}
