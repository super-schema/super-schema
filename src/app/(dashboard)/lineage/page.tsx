import dynamic from "next/dynamic";
import { prisma } from "@/lib/db";
import { toSlug } from "@/lib/domain-utils";
import type { EntityMetadata } from "@/types/schemas/entity-metadata.schema";

function LineageGraphSkeleton() {
  return (
    <div
      data-testid="lineage-skeleton"
      className="flex flex-col items-center justify-center h-full gap-4 animate-pulse"
    >
      <div className="w-48 h-6 rounded bg-card" />
      <div className="w-64 h-4 rounded bg-card" />
      <div className="flex gap-8 mt-8">
        {[1, 2, 3].map((i) => (
          <div key={i} className="w-[200px] h-[120px] rounded-[12px] bg-card border border-border" />
        ))}
      </div>
    </div>
  );
}

const LineageGraph = dynamic(
  () =>
    import("@/features/lineage/LineageGraph").then((m) => ({
      default: m.LineageGraph,
    })),
  {
    ssr: false,
    loading: () => <LineageGraphSkeleton />,
  }
);

export default async function LineagePage() {
  const entities = await prisma.entity.findMany({
    include: {
      domain: true,
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
      type: r.type,
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
      description: (e as Record<string, unknown>).description as string ?? "",
      domainName: e.domain.name,
      domainSlug: toSlug(e.domain.name),
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
        <LineageGraph entities={entityData} />
      </div>
    </div>
  );
}
