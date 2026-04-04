/**
 * API v1 authentication middleware.
 *
 * Supports two auth methods:
 * 1. API key via `Authorization: Bearer <key>` — validated against API_KEY env var
 * 2. Session-based auth via NextAuth (fallback)
 *
 * Returns the authenticated user context or null if unauthenticated.
 */

import { auth } from "@/lib/auth";
import type { ServiceContext } from "@/types/service-context";
import { prisma } from "@/lib/db";

export interface AuthResult {
  authenticated: boolean;
  context?: ServiceContext;
}

/**
 * Authenticate an incoming API request.
 *
 * Checks for an API key in the Authorization header first,
 * then falls back to session-based auth.
 */
export async function authenticateRequest(
  request: Request
): Promise<AuthResult> {
  // 1. Check for Bearer token
  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token) {
      return authenticateWithApiKey(token);
    }
  }

  // 2. Fall back to session auth
  return authenticateWithSession();
}

/**
 * Validate an API key against the API_KEY environment variable.
 * For MVP, this is a simple env var check.
 */
async function authenticateWithApiKey(token: string): Promise<AuthResult> {
  const expectedKey = process.env.API_KEY;
  if (!expectedKey) {
    // No API_KEY configured — API key auth is disabled
    return { authenticated: false };
  }

  if (token !== expectedKey) {
    return { authenticated: false };
  }

  // API key is valid — return a system-level context
  return {
    authenticated: true,
    context: {
      userId: "api-key-user",
      userRole: "admin",
      prisma,
    },
  };
}

/**
 * Authenticate using NextAuth session.
 */
async function authenticateWithSession(): Promise<AuthResult> {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return { authenticated: false };
    }

    return {
      authenticated: true,
      context: {
        userId: session.user.id,
        userRole: "user",
        prisma,
      },
    };
  } catch {
    return { authenticated: false };
  }
}
