/**
 * Simple in-memory rate limiter for API endpoints.
 *
 * Tracks requests per IP using a Map with TTL-based cleanup.
 * Default: 100 requests per minute per IP.
 *
 * Note: This is an in-memory rate limiter suitable for single-instance
 * deployments. For multi-instance / serverless deployments, replace with
 * a Redis-backed solution (e.g. @upstash/ratelimit).
 */

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const DEFAULT_MAX_REQUESTS = 100;
const DEFAULT_WINDOW_MS = 60_000; // 1 minute

const store = new Map<string, RateLimitEntry>();

// Periodic cleanup of expired entries to prevent memory leaks
const CLEANUP_INTERVAL_MS = 60_000;
let lastCleanup = Date.now();

function cleanupExpired(): void {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;

  for (const [key, entry] of store) {
    if (now >= entry.resetAt) {
      store.delete(key);
    }
  }
}

function getClientIp(request: Request): string {
  // Check common proxy headers
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }

  const realIp = request.headers.get("x-real-ip");
  if (realIp) {
    return realIp.trim();
  }

  // Fallback for local development
  return "127.0.0.1";
}

/**
 * Check rate limit for the given request.
 *
 * Returns a 429 Response if the limit is exceeded, or null if the
 * request is within limits.
 */
export function checkRateLimit(
  request: Request,
  {
    maxRequests = DEFAULT_MAX_REQUESTS,
    windowMs = DEFAULT_WINDOW_MS,
  }: { maxRequests?: number; windowMs?: number } = {}
): Response | null {
  cleanupExpired();

  const ip = getClientIp(request);
  const now = Date.now();

  const existing = store.get(ip);

  if (!existing || now >= existing.resetAt) {
    // Start a new window
    store.set(ip, { count: 1, resetAt: now + windowMs });
    return null;
  }

  existing.count += 1;

  if (existing.count > maxRequests) {
    const retryAfterSec = Math.ceil((existing.resetAt - now) / 1000);
    return new Response(
      JSON.stringify({
        error: "Too Many Requests",
        message: `Rate limit exceeded. Try again in ${retryAfterSec} seconds.`,
        retryAfter: retryAfterSec,
      }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json",
          "Retry-After": String(retryAfterSec),
          "X-RateLimit-Limit": String(maxRequests),
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": String(Math.ceil(existing.resetAt / 1000)),
        },
      }
    );
  }

  return null;
}
