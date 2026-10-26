/**
 * API v1 authentication: WHO is calling, as a principal (access-control design, decision 11).
 *
 * Two ways in, the same kind of answer:
 * 1. `Authorization: Bearer <key>`: the configured `API_KEY` (src/lib/access/api-key.ts). The key is a SERVICE principal bound to
 *    `API_KEY_TENANT_ID` and `API_KEY_ROLE`. A bearer token that is not the key is refused; the session next to it is NOT the fallback.
 * 2. Otherwise the signed-in session: the user's REAL principal (their role assignments, not a fixed role), `null` for nobody, a disabled
 *    user or a stale session.
 *
 * What the caller may DO is decided after this, by `withApiAuth` (src/lib/access/api.ts) and the services behind it.
 */

import { apiKeyMatches, apiKeyPrincipal } from "@/lib/access/api-key";
import { getPrincipal, type Principal } from "@/lib/access/principal";

export type AuthResult =
  | {
      authenticated: true;
      source: "api-key" | "session";
      principal: Principal;
      /** The tenant the caller acts in when the credential fixes it (the API key's); null for a session (its active tenant is resolved per request). */
      tenantId: string | null;
    }
  | { authenticated: false };

const NOT_AUTHENTICATED = { authenticated: false } as const;

/**
 * Authenticate an incoming request. A non-empty bearer token decides alone: the key, or nobody. No token (or an empty one, or another
 * scheme) is judged by the session. `allowApiKey: false` is for the app's own JSON endpoints, which answer to a session only.
 */
export async function authenticateRequest(request: Request, { allowApiKey = true }: { allowApiKey?: boolean } = {}): Promise<AuthResult> {
  if (allowApiKey) {
    const header = request.headers.get("authorization");
    if (header?.startsWith("Bearer ")) {
      const token = header.slice(7).trim();
      if (token) return authenticateWithApiKey(token);
    }
  }
  return authenticateWithSession();
}

function authenticateWithApiKey(token: string): AuthResult {
  // No API_KEY configured (or an API_KEY_ROLE that is not a role): the key authentication is off.
  const key = apiKeyPrincipal();
  if (!key || !apiKeyMatches(token)) return NOT_AUTHENTICATED;
  return { authenticated: true, source: "api-key", principal: key.principal, tenantId: key.tenantId };
}

async function authenticateWithSession(): Promise<AuthResult> {
  const principal = await getPrincipal();
  return principal ? { authenticated: true, source: "session", principal, tenantId: null } : NOT_AUTHENTICATED;
}
