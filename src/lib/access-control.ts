import { prisma } from "@/lib/db";
import { scopeKey } from "@/lib/access/scope";

interface SessionUserIdentity {
  id?: string | null;
}

export interface GlobalAdminAccess {
  userId: string;
  isAdmin: boolean;
}

/** The global (platform) ADMIN assignment: the `G` scope key, not "no domain" (a tenant-scoped assignment has no domain either). */
const globalAdminRoleSelect = {
  where: { role: "ADMIN", scopeKey: scopeKey({ kind: "GLOBAL" }) },
  select: { id: true },
  take: 1,
} as const;

/**
 * Is the signed-in user a global administrator? A pure read: nothing is created here. The old rule that made the earliest registered user
 * the administrator when none existed (a write from a read path) is gone; the first administrator comes from the seed or
 * `npm run admin:create` (src/lib/admin-bootstrap.ts).
 *
 * The user is found by the session's id alone (no fallback by e-mail: a stale id is nobody) and a disabled user is nobody too.
 * `authorize("platform.admin", ...)` is the guard for new code (src/lib/action-context.ts); this stays for the callers Task 5 has not migrated.
 */
export async function resolveGlobalAdminAccess(
  user: SessionUserIdentity | null | undefined
): Promise<GlobalAdminAccess | null> {
  if (!user?.id) return null;

  const userById = await prisma.user.findUnique({
    where: { id: user.id },
    select: { id: true, disabledAt: true, roles: globalAdminRoleSelect },
  });

  if (!userById || userById.disabledAt) return null;
  return { userId: userById.id, isAdmin: userById.roles.length > 0 };
}
