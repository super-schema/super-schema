import { prisma } from "@/lib/db";
import { AuditUserMissingError } from "@/lib/audit";

export const STALE_SESSION_ENTITY_ERROR =
  "Your session is stale. Sign out and sign in again, then create the entity.";

/**
 * Map the session user to a `User` row by the session's user id ALONE. There is no look-up by e-mail: a session whose id is stale (a
 * re-seeded or reset database) used to be rescued by finding whoever owned the address in it, which let a session act as another account;
 * it is nobody now and signs in again. A disabled user is refused exactly like a missing one (one uniform "sign in again", no way to tell
 * the two apart). Throws `AuditUserMissingError` when no active user has that id, which callers surface as a "sign in again" message.
 */
export async function resolveCurrentUserId(user: { id?: string | null }) {
  if (!user.id) {
    throw new AuditUserMissingError("unknown");
  }

  const userById = await prisma.user.findUnique({
    where: { id: user.id },
    select: { id: true, disabledAt: true },
  });

  if (userById && !userById.disabledAt) {
    return userById.id;
  }

  throw new AuditUserMissingError(user.id);
}
