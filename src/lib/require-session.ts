import { NextResponse } from "next/server";
import { getPrincipal, type Principal } from "@/lib/access/principal";

const NOT_AUTHENTICATED_BODY = { error: "Not authenticated" } as const;

/**
 * The first line of a route handler that serves data of the signed-in user's tenant:
 *
 *   const denied = await requireSession();
 *   if (denied) return denied;
 *
 * The middleware already answers 401 to a request without a valid session (src/middleware.ts); this is the handler's own check, so a
 * request that reaches it without going through the middleware (a changed matcher, a path the matcher does not see) still gets nothing.
 *
 * "A valid session" here means a principal (`getPrincipal`): the session's user exists and is not disabled. A disabled user, or a session
 * whose user id belongs to nobody (a reset database), is refused with the same 401 as no session at all.
 */
export async function requireSession(): Promise<NextResponse | null> {
  return (await requirePrincipal()).denied;
}

/** `requireSession` for a handler that also needs to know who it is: the principal, or the 401 to return. */
export async function requirePrincipal(): Promise<{ principal: Principal; denied: null } | { principal: null; denied: NextResponse }> {
  const principal = await getPrincipal();
  if (!principal) return { principal: null, denied: NextResponse.json(NOT_AUTHENTICATED_BODY, { status: 401 }) };
  return { principal, denied: null };
}
