import { prisma } from "@/lib/db";
import { notFound } from "next/navigation";
import { requireActiveTenantId } from "@/lib/active-tenant";
import { EntityWorkspace } from "./entity-workspace";
import { loadEntityWorkspace } from "./load-entity-workspace";

interface Props {
  params: Promise<{ domainSlug: string; productSlug: string; entityId: string }>;
}

export default async function EntityDetailPage({ params }: Props) {
  const { domainSlug, productSlug, entityId } = await params;
  const activeTenantId = await requireActiveTenantId();

  // Resolve the URL's domain and product (tenant-scoped, then tenant-agnostic to
  // tolerate a stale tenant cookie), then load the entity within that product.
  const domain =
    (await prisma.domain.findFirst({ where: { slug: domainSlug, tenantId: activeTenantId } })) ??
    (await prisma.domain.findFirst({ where: { slug: domainSlug } }));
  const product = domain
    ? await prisma.product.findFirst({
        where: { slug: productSlug, domainId: domain.id },
        select: { id: true },
      })
    : null;

  let data =
    domain && product
      ? await loadEntityWorkspace({
          slugOrId: entityId,
          productId: product.id,
          tenantId: domain.tenantId,
        })
      : null;

  // Legacy links: an id (or slug) link under a stale domain/product segment still
  // resolves to the entity's real placement, so old URLs keep working.
  if (!data) {
    const placed = await prisma.entity.findFirst({
      where: {
        OR: [{ id: entityId }, ...(domain ? [{ slug: entityId, domainId: domain.id }] : [])],
      },
      select: { productId: true, tenantId: true },
    });
    if (placed) {
      data = await loadEntityWorkspace({
        slugOrId: entityId,
        productId: placed.productId,
        tenantId: placed.tenantId,
      });
    }
  }

  if (!data) {
    notFound();
  }

  return <EntityWorkspace {...data.props} />;
}
