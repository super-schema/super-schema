import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { DEFAULT_TENANT_ID } from "@/lib/org-defaults";

export const ACTIVE_TENANT_COOKIE = "active_tenant";

/**
 * Resolve the active tenant id for the current request.
 *
 * Tenant is an org label (soft grouping) — RBAC governs real visibility, so this
 * is purely a UI scoping convenience. Falls back to the default tenant when the
 * cookie is missing or points at a tenant that no longer exists.
 */
export async function getActiveTenantId(): Promise<string> {
  const store = await cookies();
  const cookieValue = store.get(ACTIVE_TENANT_COOKIE)?.value;

  if (cookieValue) {
    const tenant = await prisma.tenant.findUnique({
      where: { id: cookieValue },
      select: { id: true },
    });
    if (tenant) {
      return tenant.id;
    }
  }

  const fallback = await prisma.tenant.findFirst({
    where: { isActive: true },
    orderBy: [{ isSystem: "desc" }, { name: "asc" }],
    select: { id: true },
  });

  return fallback?.id ?? DEFAULT_TENANT_ID;
}
