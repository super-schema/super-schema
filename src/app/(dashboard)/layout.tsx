import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { NO_ACCESS_PATH, getActiveTenantId, isNoTenantAccess } from "@/lib/active-tenant";
import { DashboardClientShell } from "@/components/layout/DashboardClientShell";

/**
 * A convenience for a HARD load of a dashboard page, NOT a boundary. Next renders a layout again only when the navigation needs it: for a request
 * whose layout segment the client router already holds, this code does not run at all, so no page and no loader may count on it. What it does is send
 * a hard load (a first visit, a refresh, a pasted address) the right way:
 *
 * - a request without a session goes to /login (the middleware, `src/middleware.ts`, is the door that runs for every request and does the same first);
 * - a signed-in user who may access no tenant (no role assigned yet, a disabled account, a session whose user is gone: `getActiveTenantId` throws
 *   `NoTenantAccess`) is sent to the "no access yet" screen (`/no-access`) instead of an empty app. A user with a role in a tenant passes whatever the role.
 *
 * What a user may SEE and DO is decided where the data is read: every page and loader that reads the database asks the principal's assignments itself
 * (`requirePageAccess`, `can`, `canListDomain`, `canListProduct`, `readableWhere`: `src/lib/access`), every server action asks `authorize`, every API route
 * `withApiAuth`; a repository scan fails for an action or a route that has none (`tests/unit/access/deny-by-default.test.ts`). A page the layout let through is
 * not thereby readable: it answers 404 for what the caller's roles do not cover.
 */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  try {
    await getActiveTenantId();
  } catch (e: unknown) {
    if (isNoTenantAccess(e)) redirect(NO_ACCESS_PATH);
    throw e;
  }

  return <DashboardClientShell>{children}</DashboardClientShell>;
}
