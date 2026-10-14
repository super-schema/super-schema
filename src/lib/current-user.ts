import { prisma } from "@/lib/db";
import { AuditUserMissingError } from "@/lib/audit";

export const STALE_SESSION_ENTITY_ERROR =
  "Your session is stale. Sign out and sign in again, then create the entity.";

/**
 * Map the session user to a `User` row: by id, then by email (a re-seeded database
 * can leave a valid session pointing at a stale id). Throws `AuditUserMissingError`
 * when neither matches, which callers surface as a "sign in again" message.
 */
export async function resolveCurrentUserId(user: { id?: string | null; email?: string | null }) {
  if (!user.id) {
    throw new AuditUserMissingError("unknown");
  }

  const userById = await prisma.user.findUnique({
    where: { id: user.id },
    select: { id: true },
  });

  if (userById) {
    return userById.id;
  }

  if (user.email) {
    const userByEmail = await prisma.user.findUnique({
      where: { email: user.email },
      select: { id: true },
    });

    if (userByEmail) {
      return userByEmail.id;
    }
  }

  throw new AuditUserMissingError(user.id);
}
