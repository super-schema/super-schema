import { prisma } from "@/lib/db";
import { toSlug } from "@/lib/domain-utils";
import { LineageGraph } from "@/features/lineage/LineageGraph";
import type { EntityMetadata } from "@/types/schemas/entity-metadata.schema";

export default async function LineagePage() {
  const entities = await prisma.entity.findMany({
    include: {
      domain: true,
      _count: { select: { fields: true } },
    },
  });

  const entityData = entities.map((e) => {
    const metadata = (e.metadata as EntityMetadata) || {};
    const relationships = (metadata.relationships || []).map((r) => ({
      targetEntityId: r.targetEntityId,
      type: r.type,
    }));

    return {
      id: e.id,
      name: e.name,
      domainName: e.domain.name,
      domainSlug: toSlug(e.domain.name),
      status: e.status,
      fieldCount: e._count.fields,
      relationships,
    };
  });

  return (
    <div className="h-full">
      <h1 className="text-display text-foreground mb-space-4">Lineage Graph</h1>
      <div className="h-[calc(100%-60px)]">
        <LineageGraph entities={entityData} />
      </div>
    </div>
  );
}
