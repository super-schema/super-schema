import { AdminShell } from "@/components/custom/admin/AdminShell";
import { adminCapabilities } from "@/lib/access/capabilities";
import { requirePageAccess } from "@/lib/access/page-access";

/**
 * The Admin area's layout, decided on the server: who is looking, which tenant is in view, and from the policy which tabs of the area they may use
 * (`adminCapabilities`). A person with no role goes to /no-access like everywhere in the dashboard (`requirePageAccess`); a person with a role but no
 * administrative right gets the area's shell with personal settings only, and the no-permission screen on every other page, never an empty shell and never
 * a tab they cannot use. The tabs are what a person is SHOWN: every action the pages call asks `authorize` itself, and a layout is not a boundary (Next
 * does not render it again for every navigation), so nothing here is a guard.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { principal, tenantId } = await requirePageAccess();
  return <AdminShell capabilities={adminCapabilities(principal.assignments, tenantId)}>{children}</AdminShell>;
}
