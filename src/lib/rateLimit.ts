type LimitResult = { allowed: boolean; retryAfterSeconds: number };

function createLimiter(windowMs: number, maxRequests: number): (key: string) => LimitResult {
  const hitsByKey = new Map<string, number[]>();

  return function check(key: string): LimitResult {
    const now = Date.now();
    const recentHits = (hitsByKey.get(key) ?? []).filter((t) => now - t < windowMs);

    if (recentHits.length >= maxRequests) {
      const retryAfterSeconds = Math.ceil((recentHits[0] + windowMs - now) / 1000);
      hitsByKey.set(key, recentHits);
      return { allowed: false, retryAfterSeconds };
    }

    recentHits.push(now);
    hitsByKey.set(key, recentHits);

    // Opportunistic cleanup so the map doesn't grow forever with one-off visitors.
    if (hitsByKey.size > 10_000) {
      for (const [k, hits] of hitsByKey) {
        if (hits.every((t) => now - t >= windowMs)) hitsByKey.delete(k);
      }
    }

    return { allowed: true, retryAfterSeconds: 0 };
  };
}

const WINDOW_MS = 60 * 60 * 1000;

// Full teardown runs are the expensive unit — this is the per-IP budget that matters.
export const checkRateLimit = createLimiter(WINDOW_MS, 5);

// Name resolution is a cheap, low-token lookup. It gets its own, more generous
// budget so browsing disambiguation options never eats into the teardown limit above.
export const checkResolveRateLimit = createLimiter(WINDOW_MS, 20);

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
