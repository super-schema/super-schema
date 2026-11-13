import { requirePageAccess } from "@/lib/access/page-access";
import { contextOf } from "@/lib/action-context";
import { ctxCan } from "@/lib/access";
import { AdminNoPermission } from "@/components/custom/admin/AdminShell";
import { getTenantStorageSettings } from "@/services/tenant-storage.service";
import { TenantStorageSettings } from "@/components/custom/tenant-storage/TenantStorageSettings";

export default async function TenantStoragePage() {
  const { principal, tenantId } = await requirePageAccess(),
    ctx = { ...contextOf(principal), tenantId };
  if (!ctxCan(ctx, "tenant.storage.configure", { tenantId }))
    return <AdminNoPermission settingsHref="/admin/settings" />;
  const data = await getTenantStorageSettings(tenantId, ctx);
  return <TenantStorageSettings key={tenantId} initial={data} />;
}
