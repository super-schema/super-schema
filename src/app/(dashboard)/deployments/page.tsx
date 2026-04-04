"use client";

import { useState } from "react";
import { DeploymentOverviewTable } from "@/components/custom/DeploymentOverview/DeploymentOverviewTable";
import { DeploymentOverviewFilters } from "@/components/custom/DeploymentOverview/DeploymentOverviewFilters";
import type { DeploymentOverviewRow } from "@/services/deployment.service";

export default function DeploymentsPage() {
  const [filters, setFilters] = useState<{
    domain?: string;
    driftStatus?: string;
    targetFormat?: string;
  }>({});

  // TODO: Fetch from API — for now show empty state
  const rows: DeploymentOverviewRow[] = [];
  const domains: string[] = [];
  const targetFormats: string[] = ["avro", "bigquery-ddl", "protobuf"];

  return (
    <div className="flex-1 flex flex-col p-space-4 gap-space-4 overflow-auto">
      {/* Header */}
      <div>
        <h1 className="text-heading-2 text-foreground">
          Deployment Overview
        </h1>
        <p className="text-body-small text-muted-foreground mt-1">
          Track schema deployments across all entities and target systems.
        </p>
      </div>

      {/* Filters */}
      <DeploymentOverviewFilters
        domains={domains}
        targetFormats={targetFormats}
        filters={filters}
        onFilterChange={setFilters}
      />

      {/* Table */}
      <DeploymentOverviewTable rows={rows} targetFormats={targetFormats} />
    </div>
  );
}
