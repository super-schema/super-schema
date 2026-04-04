"use client";

interface DeploymentOverviewFiltersProps {
  domains: string[];
  targetFormats: string[];
  filters: {
    domain?: string;
    driftStatus?: string;
    targetFormat?: string;
  };
  onFilterChange: (
    filters: Partial<{
      domain: string;
      driftStatus: string;
      targetFormat: string;
    }>
  ) => void;
}

export function DeploymentOverviewFilters({
  domains,
  targetFormats,
  filters,
  onFilterChange,
}: DeploymentOverviewFiltersProps) {
  return (
    <div
      data-testid="deployment-overview-filters"
      className="flex items-center gap-space-3 flex-wrap"
    >
      {/* Domain filter */}
      <div className="flex items-center gap-1">
        <label className="text-caption text-muted-foreground">Domain:</label>
        <select
          value={filters.domain || ""}
          onChange={(e) =>
            onFilterChange({
              ...filters,
              domain: e.target.value || undefined,
            })
          }
          className="bg-muted rounded-lg px-space-2 py-1 text-caption text-foreground outline-none border border-border"
        >
          <option value="">All</option>
          {domains.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </div>

      {/* Drift status filter */}
      <div className="flex items-center gap-1">
        <label className="text-caption text-muted-foreground">Status:</label>
        <select
          value={filters.driftStatus || ""}
          onChange={(e) =>
            onFilterChange({
              ...filters,
              driftStatus: e.target.value || undefined,
            })
          }
          className="bg-muted rounded-lg px-space-2 py-1 text-caption text-foreground outline-none border border-border"
        >
          <option value="">All</option>
          <option value="in-sync">In Sync</option>
          <option value="drifted">Drifted</option>
          <option value="unknown">Unknown</option>
        </select>
      </div>

      {/* Target format filter */}
      <div className="flex items-center gap-1">
        <label className="text-caption text-muted-foreground">Target:</label>
        <select
          value={filters.targetFormat || ""}
          onChange={(e) =>
            onFilterChange({
              ...filters,
              targetFormat: e.target.value || undefined,
            })
          }
          className="bg-muted rounded-lg px-space-2 py-1 text-caption text-foreground outline-none border border-border"
        >
          <option value="">All</option>
          {targetFormats.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </div>

      {/* Clear filters */}
      {(filters.domain || filters.driftStatus || filters.targetFormat) && (
        <button
          onClick={() => onFilterChange({})}
          className="text-caption text-primary hover:underline"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}
