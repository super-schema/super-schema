import { notFound } from "next/navigation";
import { requireActiveTenantId } from "@/lib/active-tenant";
import { loadEntityWorkspace } from "../../../[domainSlug]/[productSlug]/[entityId]/load-entity-workspace";
import { EntityWorkspace } from "../../../[domainSlug]/[productSlug]/[entityId]/entity-workspace";

interface Props {
  params: Promise<{ entityId: string }>;
}

export default async function EnterpriseEntityPage({ params }: Props) {
  const { entityId } = await params;
  const tenantId = await requireActiveTenantId();
  const data = await loadEntityWorkspace({ slugOrId: entityId, productId: null, tenantId });
  if (!data) notFound();
  return <EntityWorkspace {...data.props} />;
}
