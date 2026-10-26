/**
 * The assignments of the person who is ACTING (granting, revoking, inviting, disabling), read from the database inside the transaction that
 * decides: never the context the caller hands in (its label, its cached assignments), because a demotion or a disable that commits while the
 * decision is being made must make one of the two run again (the transaction is SERIALIZABLE). Not in the `@/lib/access` barrel: it reads the
 * database, the barrel is the pure policy.
 */

import type { Prisma } from "@/generated/prisma/client";
import { ROLE_ROW_SELECT, assignmentsFromRows } from "./assignments";
import type { Assignment } from "./scope";

/** `null` for a user who does not exist, is disabled, or is not an id at all: nobody acts as them. */
export async function loadActorAssignments(db: Pick<Prisma.TransactionClient, "user">, userId: unknown): Promise<Assignment[] | null> {
  if (typeof userId !== "string" || userId.trim() === "") return null;
  const user = await db.user.findUnique({ where: { id: userId }, select: { disabledAt: true, roles: { select: ROLE_ROW_SELECT } } });
  if (!user || user.disabledAt) return null;
  return assignmentsFromRows(user.roles);
}
