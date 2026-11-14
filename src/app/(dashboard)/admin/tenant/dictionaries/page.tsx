import { requirePageAccess } from "@/lib/access/page-access";
import { contextOf } from "@/lib/action-context";
import { ctxCan } from "@/lib/access";
import { AdminNoPermission } from "@/components/custom/admin/AdminShell";
import { DictionariesAdmin } from "@/components/custom/admin/DictionariesAdmin";
import { dictionariesOverviewAction } from "../../settings/dictionaries/actions";

/** Tenant dictionaries: the Field Dictionary and the Metadata Attribute Dictionary (with packs). A tenant administrator's page (`tenant.admin`). */
export default async function DictionariesPage() {
  const { principal, tenantId } = await requirePageAccess(),
    ctx = { ...contextOf(principal), tenantId };
  if (!ctxCan(ctx, "tenant.admin", { tenantId })) return <AdminNoPermission settingsHref="/admin/settings" />;
  const overview = await dictionariesOverviewAction();
  if ("error" in overview) return <AdminNoPermission settingsHref="/admin/settings" />;
  return <DictionariesAdmin key={tenantId} initial={overview.data} section="fields" />;
}
