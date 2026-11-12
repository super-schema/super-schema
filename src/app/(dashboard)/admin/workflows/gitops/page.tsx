import { requirePageAccess } from "@/lib/access/page-access";
import { contextOf } from "@/lib/action-context";
import { getGitOpsWorkspace } from "@/services/gitops/workspace";
import { GitOpsWorkspace } from "@/components/custom/gitops/GitOpsWorkspace";

export default async function WorkflowsGitOpsPage({ searchParams }: { searchParams: Promise<{ productId?: string }> }) {
  const [{ tenantId, principal }, query] = await Promise.all([requirePageAccess(), searchParams]);
  const data = await getGitOpsWorkspace(tenantId, query.productId, { ...contextOf(principal), tenantId });
  return <GitOpsWorkspace key={data.selectedProductId ?? "tenant"} initial={data} />;
}
