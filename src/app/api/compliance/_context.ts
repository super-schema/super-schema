import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getEffectiveRole } from "@/services/rbac.service";
import type { ServiceContext } from "@/types/service-context";

export async function resolveContext(): Promise<
  { ok: true; ctx: ServiceContext } | { ok: false; status: number; message: string }
> {
  const session = await auth();
  if (!session?.user?.id) {
    return { ok: false, status: 401, message: "Not authenticated" };
  }
  const userId = session.user.id;
  let userRole = "VIEWER";
  const roleResult = await getEffectiveRole(userId, null, { userId, userRole, prisma });
  if (roleResult.success && roleResult.data) userRole = roleResult.data;
  return { ok: true, ctx: { userId, userRole, prisma } };
}
