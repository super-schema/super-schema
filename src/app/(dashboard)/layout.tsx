import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { NO_ACCESS_PATH, getActiveTenantId, isNoTenantAccess } from "@/lib/active-tenant";
import { DashboardClientShell } from "@/components/layout/DashboardClientShell";

/**
 * Every dashboard page is behind a session. The middleware redirects a visitor without a valid one (it runs before every page address;
 * `src/middleware.ts`). This check is a second door with a limit: Next renders a layout again only when the navigation needs it, so for a
 * request whose layout segment the client router already holds, this `auth()` does not run, and a page cannot count on it. What it
 * guarantees is that a HARD load of a dashboard page (and a first visit) never renders for a request without a session, and it is what
 * the page's own queries (which have no check of their own) sit behind on those loads. The middleware is the door for every request.
 *
 * A signed-in user who may access no tenant (no role assigned yet, a disabled account, a session whose user is gone) is sent to the
 * "no access yet" screen instead of an empty app. The pages that read the active tenant turn the same condition into the same redirect
 * (`requireActiveTenantId`), for the loads this layout does not run on.
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
