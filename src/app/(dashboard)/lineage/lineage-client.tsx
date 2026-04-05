"use client";

import dynamic from "next/dynamic";

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

interface LineagePageClientProps {
  entities: Array<{
    id: string;
    name: string;
    slug: string;
    description: string;
    domainName: string;
    domainSlug: string;
    status: string;
    fieldCount: number;
    piiCount: number;
    sensitiveCount: number;
    fields: Array<{ name: string; type: string; classification?: string }>;
    relationships: Array<{ targetEntityId: string; type: string }>;
  }>;
}

export function LineagePageClient({ entities }: LineagePageClientProps) {
  return <LineageGraph entities={entities} />;
}
