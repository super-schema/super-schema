import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { DashboardClientShell } from "@/components/layout/DashboardClientShell";

/**
 * Every dashboard page is behind a session. The middleware already redirects a visitor without a valid one; this check is the second
 * door (a page must never render for a request that has none, whatever the middleware's matcher does), and the one the pages'
 * own queries sit behind.
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
