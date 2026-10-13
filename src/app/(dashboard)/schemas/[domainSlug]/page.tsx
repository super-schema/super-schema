import { prisma } from "@/lib/db";
import { notFound } from "next/navigation";
import { getActiveTenantId } from "@/lib/active-tenant";
import { ProductGrid } from "./product-grid";

interface Props {
  params: Promise<{ domainSlug: string }>;
}

export default async function DomainProductsPage({ params }: Props) {
  const { domainSlug } = await params;
  const tenantId = await getActiveTenantId();

  const domain = await prisma.domain.findFirst({
    where: { slug: domainSlug, tenantId },
    include: {
      products: {
        orderBy: [{ isSystem: "desc" }, { name: "asc" }],
        include: {
          tier: true,
          _count: { select: { entities: true } },
        },
      },
    },
  });

  // Fall back to a tenant-agnostic lookup (handles stale cookie / shared slugs)
  const resolved =
    domain ??
    (await prisma.domain.findFirst({
      where: { slug: domainSlug },
      include: {
        products: {
          orderBy: [{ isSystem: "desc" }, { name: "asc" }],
          include: {
            tier: true,
            _count: { select: { entities: true } },
          },
        },
      },
    }));

  if (!resolved) {
    notFound();
  }

  const tiers = await prisma.productTier.findMany({
    orderBy: { sortOrder: "asc" },
  });

  return (
    <ProductGrid
      domainId={resolved.id}
      domainName={resolved.name}
      domainSlug={domainSlug}
      domainDescription={resolved.description}
      products={resolved.products.map((p) => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        description: p.description,
        ownerTeam: p.ownerTeam,
        isSystem: p.isSystem,
        entityCount: p._count.entities,
        updatedAt: p.updatedAt,
        tier: p.tier
          ? {
              id: p.tier.id,
              name: p.tier.name,
              displayColor: p.tier.displayColor,
              bgColor: p.tier.bgColor,
              textColor: p.tier.textColor,
            }
          : null,
      }))}
      tiers={tiers.map((t) => ({
        id: t.id,
        name: t.name,
        bgColor: t.bgColor,
        textColor: t.textColor,
      }))}
    />
  );
}
