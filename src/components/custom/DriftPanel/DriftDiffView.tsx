"use client";

import type { DriftDifference } from "@/lib/drift/drift-comparator";

interface DriftDiffViewProps {
  differences: DriftDifference[];
}

const DIFF_TYPE_CONFIG: Record<
  string,
  { label: string; rowClass: string }
> = {
  added: { label: "Added", rowClass: "bg-success/5" },
  removed: { label: "Removed", rowClass: "bg-destructive/5" },
  "type-mismatch": { label: "Type Mismatch", rowClass: "bg-warning/5" },
  "metadata-mismatch": {
    label: "Metadata Mismatch",
    rowClass: "bg-warning/5",
  },
};

export function DriftDiffView({ differences }: DriftDiffViewProps) {
  if (differences.length === 0) {
    return (
      <p className="text-caption text-muted-foreground py-2">
        No differences found.
      </p>
    );
  }

  return (
    <div
      data-testid="drift-diff-view"
      className="border border-border rounded-lg overflow-hidden"
    >
      <table className="w-full">
        <thead>
          <tr className="surface-1 border-b border-border">
            <th className="text-caption text-muted-foreground text-left px-space-3 py-1.5">
              Field
            </th>
            <th className="text-caption text-muted-foreground text-left px-space-3 py-1.5">
              Difference
            </th>
            <th className="text-caption text-muted-foreground text-left px-space-3 py-1.5">
              Logical
            </th>
            <th className="text-caption text-muted-foreground text-left px-space-3 py-1.5">
              Implementation
            </th>
          </tr>
        </thead>
        <tbody>
          {differences.map((diff, i) => {
            const config = DIFF_TYPE_CONFIG[diff.type] || {
              label: diff.type,
              rowClass: "",
            };
            return (
              <tr
                key={i}
                className={`border-b border-border last:border-0 ${config.rowClass}`}
              >
                <td className="px-space-3 py-1.5 text-mono-small">
                  {diff.fieldName}
                </td>
                <td className="px-space-3 py-1.5 text-caption">
                  {config.label}
                </td>
                <td className="px-space-3 py-1.5 text-mono-small text-muted-foreground">
                  {diff.logicalValue || "-"}
                </td>
                <td className="px-space-3 py-1.5 text-mono-small text-muted-foreground">
                  {diff.implementationValue || "-"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
