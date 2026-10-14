import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { domainLabel } from "@/lib/entity-placement";
import type { EntityWorkspaceProps } from "./entity-workspace";

const ENTITY_INCLUDE = {
  domain: true,
  product: { select: { slug: true, name: true } },
  fields: { orderBy: { sortOrder: "asc" as const } },
  services: {
    include: {
      operations: {
        include: { parameters: true, responses: true },
        orderBy: { createdAt: "asc" as const },
      },
    },
  },
};

export interface EntityScope {
  slugOrId: string;
  /** The product the entity lives in, or `null` for a tenant-level (Enterprise) entity. */
  productId: string | null;
  tenantId: string;
}

/**
 * Find one entity by slug first (human-readable URL), then by cuid (backward-compatible /
 * legacy links), scoped to its placement. A product-level entity is scoped by `productId`
 * and `tenantId`; a tenant-level entity (`productId: null`) must also have `domainId: null`,
 * the same predicate the Enterprise list and reference-target queries use. Slugs repeat
 * across products and tenants, so every entity page resolves through this scoped lookup.
 */
export async function findEntityInScope<I extends Prisma.EntityInclude>(
  scope: EntityScope,
  include: I
) {
  const { slugOrId, productId, tenantId } = scope;
  const placement =
    productId === null
      ? { productId: null, domainId: null, tenantId }
      : { productId, tenantId };

  return (
    (await prisma.entity.findFirst({ where: { slug: slugOrId, ...placement }, include })) ??
    (await prisma.entity.findFirst({ where: { id: slugOrId, ...placement }, include }))
  );
}

/**
 * Load everything EntityWorkspace renders for one entity, resolved through
 * `findEntityInScope`. Returns `null` when nothing matches, so callers decide how to 404.
 */
export async function loadEntityWorkspace(where: EntityScope): Promise<{ props: EntityWorkspaceProps } | null> {
  const { productId } = where;

  const entity = await findEntityInScope(where, ENTITY_INCLUDE);

  if (!entity) return null;

  // Tenant-level entities have no domain and therefore no domain policy.
  const domainPolicy =
    (entity.domain as { policyTemplate?: Record<string, unknown> } | null)
      ?.policyTemplate ?? null;

  return {
    props: {
      level: productId === null ? "TENANT" : "PRODUCT",
      entity: {
        id: entity.id,
        name: entity.name,
        slug: entity.slug,
        description: entity.description,
        status: entity.status,
        version: entity.version,
        domainId: entity.domainId,
        domainName: domainLabel(entity.domain),
        domainSlug: entity.domain?.slug ?? null,
        productSlug: entity.product?.slug ?? null,
        productName: entity.product?.name ?? null,
        metadata: entity.metadata as Record<string, unknown> | null,
      },
      domainPolicy: domainPolicy as Record<string, unknown> | null,
      fields: entity.fields.map((f) => ({
        id: f.id,
        slug: f.slug,
        name: f.name,
        type: f.type,
        precision: f.precision,
        scale: f.scale,
        nullable: f.nullable,
        isKey: f.isKey,
        fieldNumber: f.fieldNumber,
        description: f.description,
        classification: f.classification,
        aliases: f.aliases,
        decorators: f.decorators as Record<string, unknown>,
        sortOrder: f.sortOrder,
      })),
      apiServiceId: entity.services[0]?.id ?? null,
      apiOperations: entity.services.flatMap((service) =>
        service.operations.map((op) => ({
          id: op.id,
          serviceId: service.id,
          name: op.name,
          httpMethod: op.httpMethod,
          httpPath: op.httpPath,
          description: op.description,
          parameters: op.parameters.map((p) => ({
            name: p.name,
            type: p.type,
            location: p.location,
            required: p.required,
            description: p.description,
          })),
          responses: op.responses.map((r) => ({
            statusCode: r.statusCode,
            type: r.type,
            description: r.description,
          })),
        }))
      ),
    },
  };
}
