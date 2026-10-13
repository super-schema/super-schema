import type { Prisma } from "@/generated/prisma/client";

type AdminBootstrapClient = Pick<
  Prisma.TransactionClient,
  "user" | "userRole"
>;

const INITIAL_ADMIN_ROLE_ID = "system-bootstrap-global-admin";

/**
 * Ensures the earliest registered user owns the initial global Admin role.
 * Returns the current global Admin user ID, creating the assignment if needed.
 */
export async function ensureFirstAdminAssignment(
  db: AdminBootstrapClient
): Promise<string | null> {
  const existingAdmin = await db.userRole.findFirst({
    where: { role: "ADMIN", domainId: null },
    select: { userId: true },
  });

  if (existingAdmin) return existingAdmin.userId;

  const firstUser = await db.user.findFirst({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });

  if (!firstUser) return null;

  try {
    await db.userRole.create({
      data: {
        id: INITIAL_ADMIN_ROLE_ID,
        userId: firstUser.id,
        role: "ADMIN",
        domainId: null,
      },
    });
    return firstUser.id;
  } catch (error) {
    // Another request may have completed the bootstrap concurrently.
    const concurrentAdmin = await db.userRole.findFirst({
      where: { role: "ADMIN", domainId: null },
      select: { userId: true },
    });
    if (concurrentAdmin) return concurrentAdmin.userId;
    throw error;
  }
}
