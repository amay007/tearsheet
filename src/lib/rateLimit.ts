const WINDOW_MS = 60 * 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 5;

const hitsByKey = new Map<string, number[]>();

export function checkRateLimit(key: string): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  const recentHits = (hitsByKey.get(key) ?? []).filter((t) => now - t < WINDOW_MS);

  if (recentHits.length >= MAX_REQUESTS_PER_WINDOW) {
    const retryAfterSeconds = Math.ceil((recentHits[0] + WINDOW_MS - now) / 1000);
    hitsByKey.set(key, recentHits);
    return { allowed: false, retryAfterSeconds };
  }

  recentHits.push(now);
  hitsByKey.set(key, recentHits);

  // Opportunistic cleanup so the map doesn't grow forever with one-off visitors.
  if (hitsByKey.size > 10_000) {
    for (const [k, hits] of hitsByKey) {
      if (hits.every((t) => now - t >= WINDOW_MS)) hitsByKey.delete(k);
    }
  }

  return { allowed: true, retryAfterSeconds: 0 };
}

export function getClientIp(headers: Headers): string {
  const forwardedFor = headers.get("x-forwarded-for");
  if (forwardedFor) {
    return forwardedFor.split(",")[0].trim();
  }
  const realIp = headers.get("x-real-ip");
  if (realIp) {
    return realIp.trim();
  }
  return "unknown";
}
