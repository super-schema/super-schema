import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requirePageAccess } from "@/lib/access/page-access";
import { can } from "@/lib/access";
import { assetHref } from "@/lib/navigation/asset-href";

export default async function ProductWorkflowsPage({ params }: { params: Promise<{ domainSlug: string; productSlug: string }> }) {
  const { domainSlug, productSlug } = await params;
  const { tenantId, principal } = await requirePageAccess();
  const product = await prisma.product.findFirst({ where: { slug: productSlug, domain: { slug: domainSlug, tenantId } } });
  if (!product || !can(principal.assignments, "deploy.read", { tenantId, domainId: product.domainId, productId: product.id })) notFound();
  redirect(assetHref({ kind: "product", domainSlug, productSlug }, { query: { tab: "workflows" } }));
}
