import { prisma } from "@/lib/db";
import { ensureFirstAdminAssignment } from "@/lib/admin-bootstrap";

interface SessionUserIdentity {
  id?: string | null;
  email?: string | null;
}

export interface GlobalAdminAccess {
  userId: string;
  isAdmin: boolean;
}

interface UserWithAdminRole {
  id: string;
  roles: Array<{ id: string }>;
}

const globalAdminRoleSelect = {
  where: { role: "ADMIN", domainId: null },
  select: { id: true },
  take: 1,
} as const;

async function toGlobalAdminAccess(
  user: UserWithAdminRole
): Promise<GlobalAdminAccess> {
  if (user.roles.length > 0) {
    return { userId: user.id, isAdmin: true };
  }

  const adminUserId = await ensureFirstAdminAssignment(prisma);
  return { userId: user.id, isAdmin: adminUserId === user.id };
}

export async function resolveGlobalAdminAccess(
  user: SessionUserIdentity | null | undefined
): Promise<GlobalAdminAccess | null> {
  if (!user?.id) return null;

  const userById = await prisma.user.findUnique({
    where: { id: user.id },
    select: { id: true, roles: globalAdminRoleSelect },
  });

  if (userById) {
    return toGlobalAdminAccess(userById);
  }

  if (!user.email) return null;

  const userByEmail = await prisma.user.findUnique({
    where: { email: user.email },
    select: { id: true, roles: globalAdminRoleSelect },
  });

  return userByEmail ? toGlobalAdminAccess(userByEmail) : null;
}
