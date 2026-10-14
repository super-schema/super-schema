import { prisma } from "@/lib/db";
import { notFound, redirect } from "next/navigation";
import { getActiveTenantId } from "@/lib/active-tenant";
import { DomainWorkspace } from "../domain-workspace";
import { assetHref } from "@/lib/navigation/asset-href";
import {
  classificationCountsFromGroups,
  emptyClassificationCounts,
} from "@/lib/classification-counts";
import {
  buildProductInheritedDataTypes,
  buildProductInheritedServices,
  mapCustomScalarRows,
  mapServiceRows,
  mapSharedEnumRows,
  mapUnionTypeRows,
} from "../map-asset-rows";

const SERVICE_INCLUDE = {
  entity: { select: { id: true, name: true, slug: true } },
  operations: {
    orderBy: { name: "asc" },
    include: { parameters: true, responses: true },
  },
} as const;

interface Props {
  params: Promise<{ domainSlug: string; productSlug: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ProductWorkspacePage({
  params,
  searchParams,
}: Props) {
  const { domainSlug, productSlug } = await params;
  const tenantId = await getActiveTenantId();

  // Domain and product resolve in a single query. The tenant-scoped lookup
  // wins; the unscoped one is only a fallback for a slug outside the active tenant.
  const findDomain = (where: { slug: string; tenantId?: string }) =>
    prisma.domain.findFirst({
      where,
      include: { products: { where: { slug: productSlug }, take: 1 } },
    });
  const domain =
    (await findDomain({ slug: domainSlug, tenantId })) ??
    (await findDomain({ slug: domainSlug }));

  if (!domain) {
    notFound();
  }

  const product = domain.products[0];

  if (!product) {
    // Back-compat: legacy 2-segment entity links (/schemas/<domain>/<entity>)
    // land here with productSlug holding the entity slug. Resolve and redirect
    // to the canonical 3-segment URL.
    const legacyEntity = await prisma.entity.findFirst({
      where: { slug: productSlug, domainId: domain.id },
      select: { slug: true, product: { select: { slug: true } } },
    });
    if (legacyEntity) {
      const resolvedSearchParams: Record<string, string | string[] | undefined> =
        (await searchParams) ?? {};
      const qs = new URLSearchParams();
      for (const [key, value] of Object.entries(resolvedSearchParams)) {
        if (Array.isArray(value)) {
          value.forEach((v) => qs.append(key, v));
        } else if (value !== undefined) {
          qs.set(key, value);
        }
      }
      const suffix = qs.toString();
      // The query is forwarded verbatim (it may repeat a key), so it is appended
      // to the assetHref path rather than passed through assetHref's single-value query.
      const canonical = assetHref({
        kind: "entity",
        slug: legacyEntity.slug,
        domainSlug,
        productSlug: legacyEntity.product?.slug ?? null,
      });
      redirect(suffix ? `${canonical}?${suffix}` : canonical);
    }
    notFound();
  }

  // Everything else is independent of each other: one parallel stage.
  const [
    entityRows,
    classificationGroups,
    sharedEnumsRaw,
    customScalarsRaw,
    unionTypesRaw,
    servicesRaw,
    domainEnumsRaw,
    domainScalarsRaw,
    domainUnionsRaw,
    domainServicesRaw,
    tenantEnumsRaw,
    tenantScalarsRaw,
    tenantUnionsRaw,
  ] = await Promise.all([
    prisma.entity.findMany({
      where: { productId: product.id },
      orderBy: { updatedAt: "desc" },
      include: { _count: { select: { fields: true } } },
    }),
    // Classification tallies without loading every field row.
    prisma.field.groupBy({
      by: ["entityId", "classification"],
      where: { entity: { productId: product.id } },
      _count: true,
    }),
    // Product-level assets (managed on this page).
    prisma.sharedEnum.findMany({
      where: { productId: product.id },
      orderBy: { name: "asc" },
    }),
    prisma.customScalar.findMany({
      where: { productId: product.id },
      orderBy: { name: "asc" },
    }),
    prisma.unionType.findMany({
      where: { productId: product.id },
      orderBy: { name: "asc" },
    }),
    // Includes entity-scoped APIs: those live at their entity's product scope.
    prisma.serviceDefinition.findMany({
      where: { productId: product.id },
      orderBy: { name: "asc" },
      include: SERVICE_INCLUDE,
    }),
    // Inherited from the domain (read-only).
    prisma.sharedEnum.findMany({
      where: { domainId: domain.id, productId: null },
      orderBy: { name: "asc" },
    }),
    prisma.customScalar.findMany({
      where: { domainId: domain.id, productId: null },
      orderBy: { name: "asc" },
    }),
    prisma.unionType.findMany({
      where: { domainId: domain.id, productId: null },
      orderBy: { name: "asc" },
    }),
    prisma.serviceDefinition.findMany({
      where: { domainId: domain.id, productId: null },
      orderBy: { name: "asc" },
      include: SERVICE_INCLUDE,
    }),
    // Inherited from the Enterprise (read-only).
    prisma.sharedEnum.findMany({
      where: { tenantId: domain.tenantId, domainId: null },
      orderBy: { name: "asc" },
    }),
    prisma.customScalar.findMany({
      where: { tenantId: domain.tenantId, domainId: null },
      orderBy: { name: "asc" },
    }),
    prisma.unionType.findMany({
      where: { tenantId: domain.tenantId, domainId: null },
      orderBy: { name: "asc" },
    }),
  ]);

  const classificationsByEntity = classificationCountsFromGroups(
    classificationGroups,
    entityRows.map((e) => e.id)
  );
  const entities = entityRows.map((e) => ({
    id: e.id,
    name: e.name,
    slug: e.slug,
    description: e.description,
    status: e.status,
    version: e.version,
    fieldCount: e._count.fields,
    updatedAt: e.updatedAt,
    classifications: classificationsByEntity.get(e.id) ?? emptyClassificationCounts(),
  }));

  const sharedEnums = mapSharedEnumRows(sharedEnumsRaw);
  const customScalars = mapCustomScalarRows(customScalarsRaw);
  const unionTypes = mapUnionTypeRows(unionTypesRaw);

  const services = mapServiceRows(servicesRaw);

  const inheritedDataTypes = buildProductInheritedDataTypes({
    domainSlug,
    domain: {
      sharedEnums: mapSharedEnumRows(domainEnumsRaw),
      customScalars: mapCustomScalarRows(domainScalarsRaw),
      unionTypes: mapUnionTypeRows(domainUnionsRaw),
    },
    enterprise: {
      sharedEnums: mapSharedEnumRows(tenantEnumsRaw),
      customScalars: mapCustomScalarRows(tenantScalarsRaw),
      unionTypes: mapUnionTypeRows(tenantUnionsRaw),
    },
  });
  const inheritedServices = buildProductInheritedServices({
    domainSlug,
    domain: mapServiceRows(domainServicesRaw),
  });

  const domainPolicy =
    (domain as { policyTemplate?: Record<string, unknown> }).policyTemplate ??
    null;

  return (
    <DomainWorkspace
      domainId={domain.id}
      domainName={domain.name}
      domainSlug={domainSlug}
      productId={product.id}
      productSlug={productSlug}
      productName={product.name}
      domainDescription={domain.description}
      isSystemDomain={domain.isSystem}
      canDeleteDomain={false}
      domainPolicy={domainPolicy as Record<string, unknown> | null}
      entities={entities}
      sharedEnums={sharedEnums}
      customScalars={customScalars}
      unionTypes={unionTypes}
      services={services}
      inheritedDataTypes={inheritedDataTypes}
      inheritedServices={inheritedServices}
    />
  );
}
