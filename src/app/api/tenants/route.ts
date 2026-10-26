import { NextResponse } from "next/server";
import { accessibleTenants, getActiveTenantId, isNoTenantAccess } from "@/lib/active-tenant";
import { requirePrincipal } from "@/lib/require-session";

/**
 * The tenants the signed-in user may access (a role at any depth in them; a global administrator: every active tenant) and the active one.
 * A user with no role at all gets an empty list and no active tenant (200, not an error: the shell shows its "no access yet" state).
 */
export async function GET() {
  const { principal, denied } = await requirePrincipal();
  if (denied) return denied;

  const tenants = await accessibleTenants(principal);
  let activeTenantId: string | null = null;
  try {
    activeTenantId = await getActiveTenantId(principal);
  } catch (e: unknown) {
    if (!isNoTenantAccess(e)) throw e;
  }

  return NextResponse.json({
    activeTenantId,
    tenants: tenants.map((t) => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      description: t.description,
      isSystem: t.isSystem,
      domainCount: t._count.domains,
    })),
  });
}
