"use client";

import type { DeploymentOverviewFilters as OverviewFilters } from "@/services/deployment.service";

import { NativeSelect } from "@/components/ui/native-select";
const DRIFT_STATUSES: readonly NonNullable<OverviewFilters["driftStatus"]>[] = ["in-sync", "drifted", "unknown"];

/** The drift status a Status option stands for; the empty "All" option (and anything else) is no drift filter. */
function driftStatusOf(value: string): OverviewFilters["driftStatus"] {
  return DRIFT_STATUSES.find((status) => status === value);
}

interface DeploymentOverviewFiltersProps {
  domains: string[];
  targetFormats: string[];
  filters: OverviewFilters;
  onFilterChange: (filters: OverviewFilters) => void;
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
        <label htmlFor="deployment-filter-domain" className="text-caption text-muted-foreground">Domain:</label>
        <NativeSelect
          id="deployment-filter-domain"
          value={filters.domain || ""}
          onChange={(e) =>
            onFilterChange({
              ...filters,
              domain: e.target.value || undefined,
            })
          }
          className="text-caption"
        >
          <option value="">All</option>
          {domains.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </NativeSelect>
      </div>

      {/* Drift status filter */}
      <div className="flex items-center gap-1">
        <label htmlFor="deployment-filter-status" className="text-caption text-muted-foreground">Status:</label>
        <NativeSelect
          id="deployment-filter-status"
          value={filters.driftStatus || ""}
          onChange={(e) =>
            onFilterChange({
              ...filters,
              driftStatus: driftStatusOf(e.target.value),
            })
          }
          className="text-caption"
        >
          <option value="">All</option>
          <option value="in-sync">In Sync</option>
          <option value="drifted">Drifted</option>
          <option value="unknown">Unknown</option>
        </NativeSelect>
      </div>

      {/* Target format filter */}
      <div className="flex items-center gap-1">
        <label htmlFor="deployment-filter-target" className="text-caption text-muted-foreground">Target:</label>
        <NativeSelect
          id="deployment-filter-target"
          value={filters.targetFormat || ""}
          onChange={(e) =>
            onFilterChange({
              ...filters,
              targetFormat: e.target.value || undefined,
            })
          }
          className="text-caption"
        >
          <option value="">All</option>
          {targetFormats.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </NativeSelect>
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
