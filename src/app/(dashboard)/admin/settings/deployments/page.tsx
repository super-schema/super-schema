import Link from "next/link";
import { requirePageAccess } from "@/lib/access/page-access";
import { TenantDeploymentSettings } from "@/components/custom/deployments/TenantDeploymentSettings";

export default async function DeploymentSettingsPage() {
  await requirePageAccess();
  return <div className="flex min-w-0 flex-col gap-5"><Link href="/admin/settings" className="text-sm text-muted-foreground hover:text-foreground">← Settings</Link><div><h1 className="text-heading-2">Deployment settings</h1><p className="text-sm text-muted-foreground">Shared environments and outbound connections for the active tenant. Tenant administrators manage these settings.</p></div><TenantDeploymentSettings /></div>;
}
