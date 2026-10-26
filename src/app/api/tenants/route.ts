import { NextResponse } from "next/server";
import { APP_ERRORS, withApiAuth } from "@/lib/access/api";
import { accessibleTenants, getActiveTenantId, isNoTenantAccess } from "@/lib/active-tenant";

/**
 * The tenants the signed-in user may access (a role at any depth in them; a global administrator: every active tenant) and the active one.
 * A user with no role at all gets an empty list and no active tenant (200, not an error: the shell shows its "no access yet" state).
 *
 * The action is `profile.own` (the user's own, any active principal): the list IS the user's own memberships, so a user with no role is answered
 * (an empty list) instead of refused; what the list holds is decided by `accessibleTenants` (the data layer), not by this guard. Answers to a session only.
 */
export const GET = withApiAuth(
  "profile.own",
  async (_request, api) => {
    const { principal } = api;
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
  },
  { respond: APP_ERRORS, allowApiKey: false }
);
