import { getPrincipal } from "@/lib/access/principal";
import { contextOf } from "@/lib/action-context";
import { getActiveTenantId } from "@/lib/active-tenant";
import { isNoTenantAccess } from "@/lib/access/no-tenant-access";
import type { ServiceContext } from "@/types/service-context";

/**
 * The service context of a compliance request: the signed-in principal (the user and the assignments the policy judges; `compliance.service`
 * decides with `can` over them, never from a role name) and the tenant being viewed. Nobody signed in, a disabled user or a stale session is 401; a
 * user who may reach no tenant at all is told the same `Not found` every refusal to see gets. (The routes themselves move to `withApiAuth` in Task 6.)
 */
export async function resolveContext(): Promise<
  { ok: true; ctx: ServiceContext } | { ok: false; status: number; message: string }
> {
  const principal = await getPrincipal();
  if (!principal) return { ok: false, status: 401, message: "Not authenticated" };
  let tenantId: string;
  try {
    tenantId = await getActiveTenantId(principal);
  } catch (e: unknown) {
    if (isNoTenantAccess(e)) return { ok: false, status: 404, message: "Not found" };
    throw e;
  }
  // The compliance pages show the tenant being viewed (the fields and gaps; the audit trail has no tenant column yet: KD-016).
  return { ok: true, ctx: { ...contextOf(principal), tenantId } };
}
