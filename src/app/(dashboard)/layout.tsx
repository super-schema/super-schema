import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { DashboardClientShell } from "@/components/layout/DashboardClientShell";

/**
 * Every dashboard page is behind a session. The middleware redirects a visitor without a valid one (it runs before every page address;
 * `src/middleware.ts`). This check is a second door with a limit: Next renders a layout again only when the navigation needs it, so for a
 * request whose layout segment the client router already holds, this `auth()` does not run, and a page cannot count on it. What it
 * guarantees is that a HARD load of a dashboard page (and a first visit) never renders for a request without a session, and it is what
 * the page's own queries (which have no check of their own) sit behind on those loads. The middleware is the door for every request.
 */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();
  if (!session?.user) redirect("/login");

  return <DashboardClientShell>{children}</DashboardClientShell>;
}
