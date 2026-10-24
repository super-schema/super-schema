import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";

/**
 * The first line of a route handler that serves data of the signed-in user's tenant:
 *
 *   const denied = await requireSession();
 *   if (denied) return denied;
 *
 * The middleware already answers 401 to a request without a valid session (src/middleware.ts); this is the handler's own check, so a
 * request that reaches it without going through the middleware (a changed matcher, a path the matcher does not see) still gets nothing.
 */
export async function requireSession(): Promise<NextResponse | null> {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  return null;
}
