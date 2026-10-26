import { prisma } from "@/lib/db";
import { readableWhere } from "@/lib/access";
import { requirePageAccess } from "@/lib/access/page-access";
import type { EntityMetadata } from "@/types/schemas/entity-metadata.schema";
import { LineagePageClient } from "./lineage-client";
import { domainLabel } from "@/lib/entity-placement";
import { entityRelationships } from "@/lib/lineage/entity-relationships";

export default async function LineagePage() {
  // The graph of the tenant being viewed (the explorer, the retention page and the other lists scope the same way), and of the entities the caller may read
  // in it: the restriction is in the query, so an entity of a domain their roles do not cover is no node and no edge.
  const { principal, tenantId } = await requirePageAccess();
  const entities = await prisma.entity.findMany({
    where: { tenantId, ...readableWhere(principal.assignments, "entity.read", tenantId) },
    include: {
      domain: true,
      product: true,
      fields: {
        select: {
          name: true,
          type: true,
          classification: true,
          // A reference field keeps the id of the entity it references here: that is where the edges of the graph come from.
          decorators: true,
        },
      },
      _count: { select: { fields: true } },
    },
  });

  const visibleIds = new Set(entities.map((e) => e.id));
  const entityData = entities.map((e) => {
    const metadata = (e.metadata as EntityMetadata) || {};
    // An edge to an entity the caller may not read is no edge (its id would name an entity that is not on their graph).
    const relationships = entityRelationships({ metadataRelationships: metadata.relationships || [], fields: e.fields }).filter((r) => visibleIds.has(r.targetEntityId));

    const piiCount = e.fields.filter(
      (f) => f.classification === "PII"
    ).length;
    const sensitiveCount = e.fields.filter(
      (f) => f.classification === "SENSITIVE"
    ).length;

    return {
      id: e.id,
      name: e.name,
      slug: e.slug,
      description: (e as Record<string, unknown>).description as string ?? "",
      domainName: domainLabel(e.domain),
      // null for a tenant-level entity.
      domainSlug: e.domain?.slug ?? null,
      productSlug: e.product?.slug ?? null,
      status: e.status,
      fieldCount: e._count.fields,
      piiCount,
      sensitiveCount,
      fields: e.fields.map((f) => ({
        name: f.name,
        type: f.type,
        classification: f.classification ?? undefined,
      })),
      relationships,
    };
  });

  return (
    <div className="h-full flex flex-col">
      <h1 className="text-[24px] font-semibold text-foreground px-4 py-3">
        Lineage Graph
      </h1>
      <div className="flex-1 min-h-0">
        <LineagePageClient entities={entityData} />
      </div>
    </div>
  );
}
