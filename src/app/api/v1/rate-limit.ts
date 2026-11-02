/**
 * The REST API's rate limits (KD-028): in memory, per process, two allowances, both checked AFTER the credential is looked at (`withApiAuth`,
 * src/lib/access/api.ts, for a route with `rateLimit: true`).
 *
 *  - An AUTHENTICATED request counts against its PRINCIPAL: the API key (one service principal, so every caller of the key shares its allowance) or
 *    the signed-in user. 100 requests a minute by default; `API_RATE_LIMIT_PER_MINUTE` sets another whole number. A request without a valid
 *    credential cannot spend it, so no anonymous caller can exhaust a principal's allowance.
 *  - A request that does NOT authenticate counts against its CLIENT ADDRESS, in an allowance of 20 a minute of its own. The address is the proxy's
 *    word, never the client's: `X-Forwarded-For` counts only when `AUTH_TRUST_PROXY=1` (src/lib/auth/client-ip.ts, the same switch as the sign-in
 *    throttle). Without a trusted proxy there is no client address, so every such request shares one allowance. That allowance refuses requests
 *    that failed to authenticate and nothing else: a valid key or session is never refused by it, so one anonymous caller cannot lock anybody out.
 *
 * Two allowances in one store, told apart by a prefix of the key. Several instances of the app each allow their own (KD-028).
 */

import { NextResponse } from "next/server";
import { clientIp } from "@/lib/auth/client-ip";

/** An authenticated principal's allowance, requests a minute, unless `API_RATE_LIMIT_PER_MINUTE` names another. */
export const PRINCIPAL_LIMIT_PER_MINUTE = 100;
/** The allowance of the requests that do not authenticate, per client address (one shared allowance without a trusted proxy). */
export const FAILED_AUTH_LIMIT_PER_MINUTE = 20;
/** The environment variable of the principal allowance (a positive whole number of requests a minute). */
export const API_RATE_LIMIT_ENV = "API_RATE_LIMIT_PER_MINUTE";

const WINDOW_MS = 60_000;

type Env = Readonly<Record<string, string | undefined>>;

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

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

/** A principal's allowance, requests a minute: `API_RATE_LIMIT_PER_MINUTE` when it is a positive whole number, else the default. */
export function principalLimitPerMinute(env: Env = process.env): number {
  const configured = (env[API_RATE_LIMIT_ENV] ?? "").trim();
  return /^[1-9][0-9]*$/.test(configured) ? Number(configured) : PRINCIPAL_LIMIT_PER_MINUTE;
}

/** A refused request: the wait, the allowance it ran into and when that window ends (epoch milliseconds). */
export interface LimitRefusal {
  retryAfterSeconds: number;
  limit: number;
  resetAt: number;
}

/** How a refusal is written for the caller of a route: the API's envelope by default; a route of another shape (the app's own JSON) writes its own. */
export type LimitResponder = (refusal: LimitRefusal) => Response;

/** The 429 of an allowance that is used up: the API's own envelope, with the wait in the body and in `Retry-After`. */
export function limitedResponse({ retryAfterSeconds: retryAfterSec, limit, resetAt }: LimitRefusal): Response {
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
        "X-RateLimit-Limit": String(limit),
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": String(Math.ceil(resetAt / 1000)),
      },
    },
  );
}

/** Counts one request against `key` in its window, and answers the 429 once the window's allowance is used up (null: within it). */
function countRequest(key: string, limit: number, respond: LimitResponder = limitedResponse): Response | null {
  cleanupExpired();
  const now = Date.now();
  const existing = store.get(key);

  if (!existing || now >= existing.resetAt) {
    // Start a new window
    store.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return null;
  }

  existing.count += 1;
  if (existing.count <= limit) return null;
  return respond({ retryAfterSeconds: Math.ceil((existing.resetAt - now) / 1000), limit, resetAt: existing.resetAt });
}

/**
 * Counts an AUTHENTICATED request against its principal (`principal.userId`: the API key's service principal or the signed-in user). A Response
 * ends the request; null lets it on. `respond` writes the 429 in the caller's shape (default: the API's envelope).
 */
export function checkPrincipalRateLimit(principal: { userId: string }, env: Env = process.env, respond?: LimitResponder): Response | null {
  return countRequest(`principal:${principal.userId}`, principalLimitPerMinute(env), respond);
}

/**
 * Counts a request that did NOT authenticate against its client address (the proxy's, or the one shared address without a trusted proxy). It is
 * called for a failure only, so it refuses failures only (see the header). A Response ends the request; null means: answer the 401 as usual.
 */
export function checkFailedAuthRateLimit(request: Request, respond?: LimitResponder): Response | null {
  return countRequest(`failed-auth:${clientIp(request.headers)}`, FAILED_AUTH_LIMIT_PER_MINUTE, respond);
}
