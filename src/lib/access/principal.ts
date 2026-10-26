import * as React from "react";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { ROLE_ROW_SELECT, assignmentsFromRows } from "./assignments";
import { can } from "./policy";
import type { Assignment, ResourceRef } from "./scope";

/**
 * Who is making the request: the signed-in user with the role assignments they hold (access-control design, decisions 2 and 8).
 * `isGlobalAdmin` is derived through the policy (a GLOBAL assignment that reaches the platform actions), never by comparing a role name.
 */
export type Principal = {
  userId: string;
  email: string;
  assignments: Assignment[];
  isGlobalAdmin: boolean;
};

/** The platform actions ignore the resource; `can` still wants one. */
const NO_RESOURCE: ResourceRef = { tenantId: "-" };

/**
 * React's per-render cache when this runs inside a React server render, and no cache at all everywhere else (a route handler, a server
 * action's own code, a unit test, a React build that has no `cache`): `React.cache` is then a pass-through or missing, and every call reads.
 * Either way the function still works; the cache only saves reads.
 */
function requestCached<Args extends unknown[], Result>(fn: (...args: Args) => Result): (...args: Args) => Result {
  return typeof React.cache === "function" ? React.cache(fn) : fn;
}

/**
 * The principal of a user id, or `null` when the user does not exist or is disabled. Cached per request BY USER ID: the session is asked
 * every time (`getPrincipal`), so the cache can never hand one user's principal to a request that is someone else's. A change to the
 * user's roles or `disabledAt` made inside the same request is not seen by it (the next request reads afresh).
 */
const loadCached = requestCached(async (userId: string): Promise<Principal | null> => {
  // By id only. There is no look-up by e-mail: a session whose id belongs to nobody is nobody, not whoever owns the address in it.
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, disabledAt: true, roles: { select: ROLE_ROW_SELECT } },
  });
  if (!user || user.disabledAt) return null;

  // Frozen at runtime (a caller cannot widen the cached object); typed as the mutable array the policy functions take.
  const assignments = Object.freeze(assignmentsFromRows(user.roles)) as Assignment[];
  return Object.freeze({ userId: user.id, email: user.email, assignments, isGlobalAdmin: can(assignments, "platform.admin", NO_RESOURCE) });
});

/** The principal of a user id the caller already holds (a verified session's id), by the same rules as `getPrincipal`. */
export async function loadPrincipalById(userId: unknown): Promise<Principal | null> {
  if (typeof userId !== "string" || userId.trim() === "") return null;
  return loadCached(userId);
}

/**
 * The principal of the current request: `null` when there is no session, the session names a user that does not exist, or the user is
 * disabled. Every guard asks this and nothing else for "who is this": a disabled user is refused everywhere because here they are nobody.
 */
export async function getPrincipal(): Promise<Principal | null> {
  const session = await auth();
  return loadPrincipalById(session?.user?.id);
}
