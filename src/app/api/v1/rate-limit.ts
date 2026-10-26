/**
 * Simple in-memory rate limiter for API endpoints.
 *
 * Tracks requests per client address using a Map with TTL-based cleanup.
 * Default: 100 requests per minute per address.
 *
 * The client address is the PROXY's word, never the client's: `X-Forwarded-For` counts only when `AUTH_TRUST_PROXY=1` (a reverse proxy in front
 * sets it and overwrites what the client sent; the same switch as the sign-in throttle, src/lib/auth/throttle.ts `clientIp`). Without a trusted
 * proxy every caller is one client, so a header a caller makes up buys no fresh allowance (KD-028).
 *
 * Note: This is an in-memory rate limiter suitable for single-instance
 * deployments. For multi-instance / serverless deployments, replace with
 * a Redis-backed solution (e.g. @upstash/ratelimit).
 */

import { NextResponse } from "next/server";
import { clientIp } from "@/lib/auth/throttle";

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

/** The client address: the proxy's `X-Forwarded-For` when `AUTH_TRUST_PROXY=1`, else one constant (every caller is one client). */
function getClientIp(request: Request): string {
  return clientIp(request.headers);
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
    // The API's own error envelope (`{ success: false, error: { code, message } }`), like every other answer of /api/v1; the hint is also in the headers.
    return NextResponse.json(
      {
        success: false,
        error: {
          code: "RATE_LIMITED",
          message: `Rate limit exceeded. Try again in ${retryAfterSec} seconds.`,
          details: { retryAfter: retryAfterSec },
          suggestedFix: "Wait for the Retry-After period before sending more requests.",
        },
      },
      {
        status: 429,
        headers: {
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
