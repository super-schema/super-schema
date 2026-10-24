import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { getActiveTenantId } from "@/lib/active-tenant";
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
  // The compliance pages show the tenant being viewed (the fields and gaps; the audit trail has no tenant column: KD-016).
  return { ok: true, ctx: { userId, userRole, tenantId: await getActiveTenantId(), prisma } };
}
