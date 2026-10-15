import { prisma } from "@/lib/db";
import { notFound } from "next/navigation";
import { FieldStudio } from "./field-studio";
import { domainLabel } from "@/lib/entity-placement";
import { getActiveTenantId } from "@/lib/active-tenant";
import { ENTERPRISE_ENTITIES_SEGMENT, ENTERPRISE_ROUTE_SEGMENT } from "@/lib/navigation/asset-href";
import { findEntityInScope } from "../../load-entity-workspace";

interface Props {
  params: Promise<{ domainSlug: string; productSlug: string; entityId: string; fieldId: string }>;
}

export default async function FieldDetailPage({ params }: Props) {
  const { domainSlug, productSlug, entityId, fieldId } = await params;
  const activeTenantId = await getActiveTenantId();

  // Resolve the entity within its placement (slug first, then cuid). Slugs repeat
  // across products and tenants, so the lookup is never unscoped.
  // assetHref puts a tenant-level (Enterprise) entity's fields under the enterprise/entities segments.
  const isTenantLevel =
    domainSlug === ENTERPRISE_ROUTE_SEGMENT && productSlug === ENTERPRISE_ENTITIES_SEGMENT;
  let entity: { id: string } | null = null;
  if (isTenantLevel) {
    entity = await findEntityInScope(
      { slugOrId: entityId, productId: null, tenantId: activeTenantId },
      {}
    );
  } else {
    // Tenant-scoped domain first, then tenant-agnostic to tolerate a stale tenant cookie.
    const domain =
      (await prisma.domain.findFirst({ where: { slug: domainSlug, tenantId: activeTenantId } })) ??
      (await prisma.domain.findFirst({ where: { slug: domainSlug } }));
    const product = domain
      ? await prisma.product.findFirst({
          where: { slug: productSlug, domainId: domain.id },
          select: { id: true },
        })
      : null;
    if (domain && product) {
      entity = await findEntityInScope(
        { slugOrId: entityId, productId: product.id, tenantId: domain.tenantId },
        {}
      );
    }
  }
  if (!entity) notFound();

  // Try slug-based lookup first, fall back to id-based lookup
  let field = await prisma.field.findFirst({
    where: { slug: fieldId, entityId: entity.id },
    include: {
      entity: {
        include: { domain: true },
      },
    },
  });
  if (!field) {
    field = await prisma.field.findUnique({
      where: { id: fieldId },
      include: {
        entity: {
          include: { domain: true },
        },
      },
    });
  }

  if (!field || field.entityId !== entity.id) {
    notFound();
  }

  // Tenant-level entities have no domain and therefore no domain policy.
  const domain = field.entity.domain;
  const domainPolicy =
    (domain as { policyTemplate?: Record<string, unknown> } | null)
      ?.policyTemplate ?? null;

  return (
    <FieldStudio
      field={{
        id: field.id,
        name: field.name,
        type: field.type,
        precision: field.precision,
        scale: field.scale,
        nullable: field.nullable,
        isKey: field.isKey,
        fieldNumber: field.fieldNumber,
        description: field.description,
        classification: field.classification,
        aliases: field.aliases,
        decorators: field.decorators as Record<string, unknown>,
      }}
      entity={{
        id: field.entity.id,
        name: field.entity.name,
        slug: field.entity.slug,
        // null for a tenant-level entity, so FieldStudio links through assetHref.
        domainSlug: isTenantLevel ? null : domainSlug,
        productSlug: isTenantLevel ? null : productSlug,
      }}
      domain={{
        name: domainLabel(domain),
        policy: domainPolicy as Record<string, unknown> | null,
      }}
    />
  );
}
