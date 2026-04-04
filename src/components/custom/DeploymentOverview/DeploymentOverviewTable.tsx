"use client";

import Link from "next/link";
import { DriftBadge } from "@/components/custom/DriftBadge/DriftBadge";
import { VersionBadge } from "@/components/custom/DeploymentPanel/VersionBadge";
import type { DeploymentOverviewRow } from "@/services/deployment.service";

interface DeploymentOverviewTableProps {
  rows: DeploymentOverviewRow[];
  targetFormats: string[];
}

export function DeploymentOverviewTable({
  rows,
  targetFormats,
}: DeploymentOverviewTableProps) {
  if (rows.length === 0) {
    return (
      <div className="text-center py-space-6">
        <p className="text-body-small text-muted-foreground">
          No entities with deployment tracking found.
        </p>
      </div>
    );
  }

  return (
    <div
      data-testid="deployment-overview-table"
      className="border border-border rounded-lg overflow-hidden"
    >
      <table className="w-full">
        <thead>
          <tr className="surface-1 border-b border-border">
            <th className="text-caption text-muted-foreground text-left px-space-3 py-2">
              Entity
            </th>
            <th className="text-caption text-muted-foreground text-left px-space-3 py-2">
              Domain
            </th>
            <th className="text-caption text-muted-foreground text-left px-space-3 py-2">
              Version
            </th>
            {targetFormats.map((format) => (
              <th
                key={format}
                className="text-caption text-muted-foreground text-center px-space-3 py-2"
              >
                {format}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.entityId}
              className="border-b border-border last:border-0 hover:bg-accent/30"
            >
              <td className="px-space-3 py-2">
                <Link
                  href={`/schemas/_/${row.entityId}`}
                  className="text-body-small text-primary hover:underline"
                >
                  {row.entityName}
                </Link>
              </td>
              <td className="px-space-3 py-2 text-caption text-muted-foreground">
                {row.domain}
              </td>
              <td className="px-space-3 py-2">
                <VersionBadge version={row.currentVersion} />
              </td>
              {targetFormats.map((format) => {
                const target = row.targets.find((t) => t.format === format);
                if (!target) {
                  return (
                    <td
                      key={format}
                      className="px-space-3 py-2 text-center text-caption text-muted-foreground"
                    >
                      -
                    </td>
                  );
                }
                return (
                  <td key={format} className="px-space-3 py-2 text-center">
                    <div className="flex items-center justify-center gap-1">
                      <VersionBadge version={target.deployedVersion} />
                      <DriftBadge status={target.driftStatus} compact />
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
