import { requirePageAccess } from "@/lib/access/page-access";
import { TenantDeploymentSettings } from "@/components/custom/deployments/TenantDeploymentSettings";

export default async function WorkflowsTargetsPage() {
  await requirePageAccess();
  return <TenantDeploymentSettings view="targets" />;
}
