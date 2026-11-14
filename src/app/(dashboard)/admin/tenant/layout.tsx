import { requirePageAccess } from "@/lib/access/page-access";
import { contextOf } from "@/lib/action-context";
import { ctxCan } from "@/lib/access";
import { AdminNoPermission } from "@/components/custom/admin/AdminShell";
import { TenantShell } from "@/components/custom/admin/TenantShell";

export default async function TenantLayout({ children }: { children: React.ReactNode }) {
  const { principal, tenantId } = await requirePageAccess();
  if (!ctxCan(contextOf(principal), "tenant.admin", { tenantId }))
    return <AdminNoPermission settingsHref="/admin/settings" />;
  return <TenantShell>{children}</TenantShell>;
}
