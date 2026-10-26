import { prisma } from "@/lib/db";
import { notFound, redirect } from "next/navigation";
import { FieldStudio } from "./field-studio";
import { domainLabel } from "@/lib/entity-placement";
import { can, readableWhere } from "@/lib/access";
import { requirePageAccess } from "@/lib/access/page-access";
import { ENTERPRISE_ENTITIES_SEGMENT, ENTERPRISE_ROUTE_SEGMENT, assetHref, type QueryParams } from "@/lib/navigation/asset-href";
import { findEntityInScope } from "../../load-entity-workspace";
import { loadPickableEntities } from "@/lib/references/pickable-entities";

interface Props {
  params: Promise<{ domainSlug: string; productSlug: string; entityId: string; fieldId: string }>;
  /** Next hands a page its query string; the redirect below hands it on (`?version=`, `?panel=`). */
  searchParams?: Promise<QueryParams>;
}

export default async function FieldDetailPage({ params, searchParams }: Props) {
  const { domainSlug, productSlug, entityId, fieldId } = await params;
  const { principal, tenantId: activeTenantId } = await requirePageAccess();

  // Resolve the entity within its placement (slug first, then cuid). Slugs repeat
  // across products and tenants, so the lookup is never unscoped.
  // assetHref puts a tenant-level (Enterprise) entity's fields under the enterprise/entities segments.
  const isTenantLevel =
    domainSlug === ENTERPRISE_ROUTE_SEGMENT && productSlug === ENTERPRISE_ENTITIES_SEGMENT;
  type Placed = { id: string; tenantId: string; domainId: string | null; productId: string | null; product: { domainId: string | null } | null };
  const placedInclude = { product: { select: { domainId: true } } } as const;
  let entity: Placed | null = null;
  if (isTenantLevel) {
    entity = await findEntityInScope(
      { slugOrId: entityId, productId: null, tenantId: activeTenantId },
      placedInclude
    );
  } else {
    // The domain of the tenant in view, and no other (a slug is not unique across tenants: there is no tenant-agnostic fallback).
    const domain = await prisma.domain.findFirst({ where: { slug: domainSlug, tenantId: activeTenantId } });
    const product = domain
      ? await prisma.product.findFirst({
          where: { slug: productSlug, domainId: domain.id },
          select: { id: true },
        })
      : null;
    if (domain && product) {
      entity = await findEntityInScope(
        { slugOrId: entityId, productId: product.id, tenantId: domain.tenantId },
        placedInclude
      );
    }
  }
  // The caller must be able to READ the entity (a role over its own tenant, domain and product): one they cannot read is a missing one, before any of its
  // fields is loaded. The studio's controls write through actions that ask `entity.write` again.
  if (!entity || !can(principal.assignments, "entity.read", { tenantId: entity.tenantId, domainId: entity.domainId ?? entity.product?.domainId ?? null, productId: entity.productId })) notFound();

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

  // The studio is addressed by the field's ID: a rename changes the slug, and every save revalidates the page behind this address, so
  // an address that names the slug would be a 404 at the next render. A link by the (old) name is sent to the id's address, and the
  // page is rendered from there with the right segment from the first render. The query string goes with the address (a link to
  // `?version=1.2.0` still means that version).
  if (field.id !== fieldId) {
    redirect(
      assetHref(
        {
          kind: "field",
          entitySlug: entityId,
          fieldId: field.id,
          domainSlug: isTenantLevel ? null : domainSlug,
          productSlug: isTenantLevel ? null : productSlug,
        },
        { query: (await searchParams) ?? {} }
      )
    );
  }

  // Tenant-level entities have no domain and therefore no domain policy.
  const domain = field.entity.domain;
  const domainPolicy =
    (domain as { policyTemplate?: Record<string, unknown> } | null)
      ?.policyTemplate ?? null;

  // The entities of the entity's own tenant a reference can point at, for the type picker (fail-soft: a typed name still works).
  const referenceTargets = await loadPickableEntities(prisma, field.entity.tenantId, readableWhere(principal.assignments, "entity.read", field.entity.tenantId));

  return (
    <FieldStudio
      referenceTargets={referenceTargets}
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
