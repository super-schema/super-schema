import { prisma } from "@/lib/db";
import { notFound } from "next/navigation";
import { can, canListDomain, canListProduct } from "@/lib/access";
import { requirePageAccess } from "@/lib/access/page-access";
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
  const { principal, tenantId } = await requirePageAccess();
  const assignments = principal.assignments;

  // The domain of the tenant in view, and only that tenant's: a slug is not unique across tenants, and a domain of another tenant is a missing one.
  const found = await prisma.domain.findFirst({
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

  // A role that covers the domain, or one of its products (the domain is then a parent, name only), lets the caller in; anyone else gets a 404.
  if (!found || !canListDomain(assignments, { tenantId, domainId: found.id })) {
    notFound();
  }
  // The products the caller may list (a role at a product shows that product only, never its siblings), and the domain's OWN assets and traits only when a role
  // covers the domain itself; the Enterprise ones it inherits only when a role covers the tenant as a whole.
  const resolved = { ...found, products: found.products.filter((p) => canListProduct(assignments, { tenantId, domainId: found.id, productId: p.id })) };
  const readDomain = can(assignments, "asset.read", { tenantId, domainId: resolved.id });
  const readTenant = can(assignments, "asset.read", { tenantId });
  const traitsRead = { own: can(assignments, "trait.read", { tenantId, domainId: resolved.id }), enterprise: can(assignments, "trait.read", { tenantId }) };
  // A query that is not allowed is not run at all (a lazy loader, not a promise that already started).
  const rowsIf = <T,>(allowed: boolean, load: () => Promise<T[]>): Promise<T[]> => (allowed ? load() : Promise.resolve([] as T[]));

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
    rowsIf(readDomain, () => prisma.sharedEnum.findMany({ where: { domainId: resolved.id, productId: null }, orderBy: { name: "asc" } })),
    rowsIf(readDomain, () => prisma.customScalar.findMany({ where: { domainId: resolved.id, productId: null }, orderBy: { name: "asc" } })),
    rowsIf(readDomain, () => prisma.unionType.findMany({ where: { domainId: resolved.id, productId: null }, orderBy: { name: "asc" } })),
    rowsIf(readDomain, () =>
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
      })
    ),
    rowsIf(readTenant, () => prisma.sharedEnum.findMany({ where: { tenantId: resolved.tenantId, domainId: null }, orderBy: { name: "asc" } })),
    rowsIf(readTenant, () => prisma.customScalar.findMany({ where: { tenantId: resolved.tenantId, domainId: null }, orderBy: { name: "asc" } })),
    rowsIf(readTenant, () => prisma.unionType.findMany({ where: { tenantId: resolved.tenantId, domainId: null }, orderBy: { name: "asc" } })),
    // Domain traits + the Enterprise traits read-only, scoped by the domain's tenant, each only where a role of the caller covers it.
    loadLevelTraits({
      scope: { tenantId: resolved.tenantId, domainId: resolved.id, productId: null },
      domainSlug,
      read: traitsRead,
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
