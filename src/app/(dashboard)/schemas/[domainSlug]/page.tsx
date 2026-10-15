import { prisma } from "@/lib/db";
import { notFound } from "next/navigation";
import { getActiveTenantId } from "@/lib/active-tenant";
import { assetHref } from "@/lib/navigation/asset-href";
import { loadLevelTraits } from "@/features/events/workspace/load-events-tab-data";
import { EVENTS_ASSET_COUNT_SELECT, productDataTypeCount } from "@/lib/product-deletion";
import { DomainTabs } from "./domain-tabs";
import {
  mapCustomScalarRows,
  mapServiceRows,
  mapSharedEnumRows,
  mapUnionTypeRows,
} from "./map-asset-rows";

/** Everything a product delete would cascade (see productDeleteBlocker). */
const PRODUCT_CONTENT_COUNTS = {
  entities: true,
  sharedEnums: true,
  customScalars: true,
  unionTypes: true,
  services: true,
  ...EVENTS_ASSET_COUNT_SELECT,
} as const;

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
          _count: { select: PRODUCT_CONTENT_COUNTS },
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
            _count: { select: PRODUCT_CONTENT_COUNTS },
          },
        },
      },
    }));

  if (!resolved) {
    notFound();
  }

  const [
    tiers,
    enums,
    scalars,
    unions,
    services,
    tenantEnums,
    tenantScalars,
    tenantUnions,
    traits,
  ] = await Promise.all([
    prisma.productTier.findMany({ orderBy: { sortOrder: "asc" } }),
    prisma.sharedEnum.findMany({
      where: { domainId: resolved.id, productId: null },
      orderBy: { name: "asc" },
    }),
    prisma.customScalar.findMany({
      where: { domainId: resolved.id, productId: null },
      orderBy: { name: "asc" },
    }),
    prisma.unionType.findMany({
      where: { domainId: resolved.id, productId: null },
      orderBy: { name: "asc" },
    }),
    prisma.serviceDefinition.findMany({
      where: { domainId: resolved.id, productId: null },
      orderBy: { name: "asc" },
      include: {
        entity: { select: { id: true, name: true, slug: true } },
        operations: {
          orderBy: { name: "asc" },
          include: { parameters: true, responses: true },
        },
      },
    }),
    prisma.sharedEnum.findMany({
      where: { tenantId: resolved.tenantId, domainId: null },
      orderBy: { name: "asc" },
    }),
    prisma.customScalar.findMany({
      where: { tenantId: resolved.tenantId, domainId: null },
      orderBy: { name: "asc" },
    }),
    prisma.unionType.findMany({
      where: { tenantId: resolved.tenantId, domainId: null },
      orderBy: { name: "asc" },
    }),
    // Domain traits + the Enterprise traits read-only, scoped by the domain's tenant.
    loadLevelTraits({
      scope: { tenantId: resolved.tenantId, domainId: resolved.id, productId: null },
      domainSlug,
    }),
  ]);

  const enterpriseDataTypes = {
    label: "From Enterprise",
    href: assetHref({ kind: "dataTypes", domainSlug: null, productSlug: null }),
    sharedEnums: mapSharedEnumRows(tenantEnums),
    customScalars: mapCustomScalarRows(tenantScalars),
    unionTypes: mapUnionTypeRows(tenantUnions),
  };
  const hasEnterpriseDataTypes =
    enterpriseDataTypes.sharedEnums.length +
      enterpriseDataTypes.customScalars.length +
      enterpriseDataTypes.unionTypes.length >
    0;

  return (
    <DomainTabs
      domain={{
        id: resolved.id,
        name: resolved.name,
        slug: domainSlug,
        description: resolved.description,
      }}
      productGridProps={{
        products: resolved.products.map((p) => ({
          id: p.id,
          name: p.name,
          slug: p.slug,
          description: p.description,
          ownerTeam: p.ownerTeam,
          isSystem: p.isSystem,
          entityCount: p._count.entities,
          dataTypeCount: productDataTypeCount(p._count),
          apiCount: p._count.services,
          eventsAssets: {
            channels: p._count.channels,
            messages: p._count.messages,
            traits: p._count.traits,
            eventSpecs: p._count.eventSpecs,
          },
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
        })),
        tiers: tiers.map((t) => ({
          id: t.id,
          name: t.name,
          bgColor: t.bgColor,
          textColor: t.textColor,
        })),
      }}
      dataTypes={{
        sharedEnums: mapSharedEnumRows(enums),
        customScalars: mapCustomScalarRows(scalars),
        unionTypes: mapUnionTypeRows(unions),
      }}
      inheritedDataTypes={hasEnterpriseDataTypes ? [enterpriseDataTypes] : []}
      services={mapServiceRows(services)}
      traits={traits}
    />
  );
}
