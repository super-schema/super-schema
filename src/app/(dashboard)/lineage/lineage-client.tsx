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
  entities: Parameters<typeof LineageGraph>[0]["entities"];
}

export function LineagePageClient({ entities }: LineagePageClientProps) {
  return <LineageGraph entities={entities} />;
}
