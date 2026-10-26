import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { DEFAULT_TENANT_ID } from "@/lib/org-defaults";
import { can } from "@/lib/access/policy";
import { NO_ACCESS_PATH, NoTenantAccess, isNoTenantAccess } from "@/lib/access/no-tenant-access";
import { getPrincipal, type Principal } from "@/lib/access/principal";

export const ACTIVE_TENANT_COOKIE = "active_tenant";

export { NO_ACCESS_PATH, NoTenantAccess, isNoTenantAccess };

/** The order tenants are offered in: the system tenant first, then by name. */
const TENANT_ORDER = [{ isSystem: "desc" as const }, { name: "asc" as const }];

/**
 * The ids of the tenants a (non-global) principal may access: every tenant in which they hold a role at ANY depth (a domain or product
 * role is membership of its tenant), judged by the policy's `tenant.access` so the rule has one home. A global administrator is not
 * listed here: they may access every tenant (`principal.isGlobalAdmin`).
 */
function memberTenantIds(principal: Principal): string[] {
  const ids = new Set<string>();
  for (const { scope } of principal.assignments) {
    if (scope.kind !== "GLOBAL") ids.add(scope.tenantId);
  }
  return [...ids].filter((tenantId) => can(principal.assignments, "tenant.access", { tenantId }));
}

/**
 * The active tenants the principal may access, in the order the switcher shows them, each with its domain count: every active tenant
 * for a global administrator, the tenants they hold a role in otherwise, none for a user with no role (no query is made for them).
 */
export async function accessibleTenants(principal: Principal) {
  const include = { _count: { select: { domains: true } } } as const;
  if (principal.isGlobalAdmin) return prisma.tenant.findMany({ where: { isActive: true }, orderBy: TENANT_ORDER, include });
  const ids = memberTenantIds(principal);
  if (ids.length === 0) return [];
  return prisma.tenant.findMany({ where: { isActive: true, id: { in: ids } }, orderBy: TENANT_ORDER, include });
}

/**
 * Resolve the active tenant id for the current request.
 *
 * The `active_tenant` cookie is a choice, not an entitlement: it counts only when the principal may access that tenant. Otherwise the
 * first tenant they can access (system tenant first, then by name; for a global administrator the first active tenant, and the default
 * tenant when none exists yet). A principal who may access no tenant (no role assigned yet, a disabled user, a stale session) gets a
 * `NoTenantAccess`: pages turn it into the "no access yet" screen (`requireActiveTenantId`), actions and routes answer it as not found.
 *
 * Pass the principal when the caller already holds it (`/api/tenants`) to skip loading it again.
 */
export async function getActiveTenantId(principal?: Principal | null): Promise<string> {
  const who = principal === undefined ? await getPrincipal() : principal;
  if (!who) throw new NoTenantAccess();

  const store = await cookies();
  const cookieValue = store.get(ACTIVE_TENANT_COOKIE)?.value;

  if (who.isGlobalAdmin) {
    if (cookieValue) {
      const tenant = await prisma.tenant.findUnique({ where: { id: cookieValue }, select: { id: true } });
      if (tenant) return tenant.id;
    }
    const fallback = await prisma.tenant.findFirst({ where: { isActive: true }, orderBy: TENANT_ORDER, select: { id: true } });
    return fallback?.id ?? DEFAULT_TENANT_ID;
  }

  // A role row has a foreign key to its tenant: a tenant the user holds a role in exists, so the cookie needs no look-up.
  const accessible = memberTenantIds(who);
  if (cookieValue && accessible.includes(cookieValue)) return cookieValue;
  if (accessible.length === 0) throw new NoTenantAccess();

  const first = await prisma.tenant.findFirst({ where: { isActive: true, id: { in: accessible } }, orderBy: TENANT_ORDER, select: { id: true } });
  if (!first) throw new NoTenantAccess();
  return first.id;
}

/**
 * `getActiveTenantId` for PAGES: a user with no tenant access is redirected to the "no access yet" screen instead of the page failing.
 * Any other failure is not hidden.
 */
export async function requireActiveTenantId(principal?: Principal | null): Promise<string> {
  try {
    return await getActiveTenantId(principal);
  } catch (e: unknown) {
    if (isNoTenantAccess(e)) redirect(NO_ACCESS_PATH);
    throw e;
  }
}
