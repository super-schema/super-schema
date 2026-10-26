/**
 * What a PAGE (a server component that reads the database) asks first: who is looking, and at which tenant (access-control design, goal 3).
 *
 * The dashboard layout is NOT the boundary. Next renders a layout again only when the navigation needs it, so a page cannot count on the layout's
 * checks having run for its request; every page and every loader that reads the database decides for itself, at the data layer, from the principal's
 * assignments (`can`, `canListDomain`, `canListProduct`, `readableWhere`): this module is the first line of each of them. A user with no role, a
 * disabled user and a session whose user is gone are sent to the "no access yet" screen, exactly as the layout sends them.
 */

import { redirect } from "next/navigation";
import { NO_ACCESS_PATH, requireActiveTenantId } from "@/lib/active-tenant";
import { getPrincipal, type Principal } from "./principal";

export type PageAccess = {
  principal: Principal;
  /** The tenant being viewed: one the principal holds a role in (a platform administrator: any). */
  tenantId: string;
};

/** The principal and the tenant in view of the current page, or the redirect to /no-access (which never returns). */
export async function requirePageAccess(): Promise<PageAccess> {
  const principal = await getPrincipal();
  if (!principal) redirect(NO_ACCESS_PATH);
  const tenantId = await requireActiveTenantId(principal);
  return { principal, tenantId };
}
