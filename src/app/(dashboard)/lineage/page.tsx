import { prisma } from "@/lib/db";
import type { EntityMetadata } from "@/types/schemas/entity-metadata.schema";
import { LineagePageClient } from "./lineage-client";

export default async function LineagePage() {
  const entities = await prisma.entity.findMany({
    include: {
      domain: true,
      product: true,
      fields: {
        select: {
          name: true,
          type: true,
          classification: true,
        },
      },
      _count: { select: { fields: true } },
    },
  });

  const entityData = entities.map((e) => {
    const metadata = (e.metadata as EntityMetadata) || {};
    const relationships = (metadata.relationships || []).map((r) => ({
      targetEntityId: r.targetEntityId,
      type: r.cardinality,
    }));

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
      domainName: e.domain.name,
      domainSlug: e.domain.slug,
      productSlug: e.product.slug,
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
