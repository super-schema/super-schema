import { prisma } from "@/lib/db";
import { notFound, redirect } from "next/navigation";
import { can, canListDomain, canListProduct } from "@/lib/access";
import { requirePageAccess } from "@/lib/access/page-access";
import { DomainWorkspace } from "../domain-workspace";
import { assetHref } from "@/lib/navigation/asset-href";
import { loadEventsList } from "@/features/events/event-page/load-events-list";
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
  const { principal, tenantId } = await requirePageAccess();
  const assignments = principal.assignments;

  // Domain and product resolve in a single query, inside the tenant in view and nowhere else: a slug is not unique across tenants, and a domain of
  // another tenant is a missing one (it used to be found by a tenant-agnostic fallback).
  const domain = await prisma.domain.findFirst({
    where: { slug: domainSlug, tenantId },
    include: { products: { where: { slug: productSlug }, take: 1 } },
  });

  // A role that covers the domain or one of its products lets the caller see that it is there; anyone else gets a 404.
  if (!domain || !canListDomain(assignments, { tenantId, domainId: domain.id })) {
    notFound();
  }

  const product = domain.products[0];

  if (product && !canListProduct(assignments, { tenantId, domainId: domain.id, productId: product.id })) {
    // A product the caller has no role over reads exactly like a missing one.
    notFound();
  }

  if (!product) {
    // Back-compat: legacy 2-segment entity links (/schemas/<domain>/<entity>)
    // land here with productSlug holding the entity slug. Resolve and redirect
    // to the canonical 3-segment URL, but only to an entity the caller may read (the redirect would otherwise say that it exists).
    const found = await prisma.entity.findFirst({
      where: { slug: productSlug, domainId: domain.id, tenantId },
      select: { slug: true, productId: true, product: { select: { slug: true } } },
    });
    const legacyEntity = found && can(assignments, "entity.read", { tenantId, domainId: domain.id, productId: found.productId }) ? found : null;
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

  // What the product page may show beyond the product itself: the assets it inherits from its domain and from the Enterprise, each only where a role covers them.
  const readDomain = can(assignments, "asset.read", { tenantId, domainId: domain.id });
  const readTenant = can(assignments, "asset.read", { tenantId });
  // A query that is not allowed is not run at all (a lazy loader, not a promise that already started).
  const rowsIf = <T,>(allowed: boolean, load: () => Promise<T[]>): Promise<T[]> => (allowed ? load() : Promise.resolve([] as T[]));

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
    eventItems,
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
    // Inherited from the domain (read-only), only when a role of the caller covers the domain itself (a role at this product does not).
    rowsIf(readDomain, () => prisma.sharedEnum.findMany({ where: { domainId: domain.id, productId: null }, orderBy: { name: "asc" } })),
    rowsIf(readDomain, () => prisma.customScalar.findMany({ where: { domainId: domain.id, productId: null }, orderBy: { name: "asc" } })),
    rowsIf(readDomain, () => prisma.unionType.findMany({ where: { domainId: domain.id, productId: null }, orderBy: { name: "asc" } })),
    rowsIf(readDomain, () => prisma.serviceDefinition.findMany({ where: { domainId: domain.id, productId: null }, orderBy: { name: "asc" }, include: SERVICE_INCLUDE })),
    // Inherited from the Enterprise (read-only), only when a role of the caller covers the tenant as a whole.
    rowsIf(readTenant, () => prisma.sharedEnum.findMany({ where: { tenantId: domain.tenantId, domainId: null }, orderBy: { name: "asc" } })),
    rowsIf(readTenant, () => prisma.customScalar.findMany({ where: { tenantId: domain.tenantId, domainId: null }, orderBy: { name: "asc" } })),
    rowsIf(readTenant, () => prisma.unionType.findMany({ where: { tenantId: domain.tenantId, domainId: null }, orderBy: { name: "asc" } })),
    // Events tab: the product's events, scoped by the route's tenant and product. Legacy v1 event specs are skipped by the loader.
    loadEventsList({
      tenantId: domain.tenantId,
      productId: product.id,
      domainSlug,
      productSlug,
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
      domainPolicy={domainPolicy as Record<string, unknown> | null}
      entities={entities}
      sharedEnums={sharedEnums}
      customScalars={customScalars}
      unionTypes={unionTypes}
      services={services}
      inheritedDataTypes={inheritedDataTypes}
      inheritedServices={inheritedServices}
      events={eventItems}
      productContacts={{
        engineeringLead: product.engineeringLead ?? null,
        manager: product.manager ?? null,
        teamEmails: product.teamEmails ?? [],
      }}
    />
  );
}
