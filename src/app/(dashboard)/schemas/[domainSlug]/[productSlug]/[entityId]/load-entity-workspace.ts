import { prisma } from "@/lib/db";
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

/**
 * Load everything EntityWorkspace renders for one entity.
 *
 * The entity is looked up by slug first (human-readable URL), then by cuid
 * (backward-compatible / legacy links). Both lookups are scoped to the placement:
 * `productId` is the product the entity lives in, or `null` for a tenant-level
 * (Enterprise) entity; `tenantId` keeps the lookup inside the tenant.
 *
 * Returns `null` when nothing matches, so callers decide how to 404.
 */
export async function loadEntityWorkspace(where: {
  slugOrId: string;
  productId: string | null;
  tenantId: string;
}): Promise<{ props: EntityWorkspaceProps } | null> {
  const { slugOrId, productId, tenantId } = where;

  const entity =
    (await prisma.entity.findFirst({
      where: { slug: slugOrId, productId, tenantId },
      include: ENTITY_INCLUDE,
    })) ??
    (await prisma.entity.findFirst({
      where: { id: slugOrId, productId, tenantId },
      include: ENTITY_INCLUDE,
    }));

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
