import { prisma } from "@/lib/db";
import { notFound } from "next/navigation";
import { requirePageAccess } from "@/lib/access/page-access";
import { EntityWorkspace } from "./entity-workspace";
import { loadEntityWorkspace } from "./load-entity-workspace";

interface Props {
  params: Promise<{ domainSlug: string; productSlug: string; entityId: string }>;
}

export default async function EntityDetailPage({ params }: Props) {
  const { domainSlug, productSlug, entityId } = await params;
  const { tenantId: activeTenantId } = await requirePageAccess();

  // Resolve the URL's domain and product INSIDE the tenant in view (a slug is not unique across tenants, and a domain of another tenant is a missing one: it
  // used to fall back to a tenant-agnostic lookup), then load the entity within that product. `loadEntityWorkspace` answers null for an entity the caller's
  // roles do not let them read (`entity.read` over its own tenant, domain and product), so the page is a 404 for it, as for a missing one.
  const domain = await prisma.domain.findFirst({ where: { slug: domainSlug, tenantId: activeTenantId } });
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
  // resolves to the entity's real placement, so old URLs keep working: inside the tenant in view only.
  if (!data) {
    const placed = await prisma.entity.findFirst({
      where: {
        tenantId: activeTenantId,
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
