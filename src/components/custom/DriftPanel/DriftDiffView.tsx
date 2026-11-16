"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { DriftDifference } from "@/lib/drift/drift-comparator";

interface DriftDiffViewProps {
  differences: DriftDifference[];
}

const DIFF_TYPE_CONFIG: Record<
  string,
  { label: string; rowClass: string }
> = {
  added: { label: "Added", rowClass: "bg-success/5 hover:bg-success/10" },
  removed: { label: "Removed", rowClass: "bg-destructive/5 hover:bg-destructive/10" },
  "type-mismatch": { label: "Type Mismatch", rowClass: "bg-warning/5 hover:bg-warning/10" },
  "metadata-mismatch": {
    label: "Metadata Mismatch",
    rowClass: "bg-warning/5 hover:bg-warning/10",
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
      <Table>
        <TableHeader>
          <TableRow className="surface-1 hover:bg-transparent">
            <TableHead className="text-caption text-muted-foreground">
              Field
            </TableHead>
            <TableHead className="text-caption text-muted-foreground">
              Difference
            </TableHead>
            <TableHead className="text-caption text-muted-foreground">
              Logical
            </TableHead>
            <TableHead className="text-caption text-muted-foreground">
              Implementation
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {differences.map((diff, i) => {
            const config = DIFF_TYPE_CONFIG[diff.type] || {
              label: diff.type,
              rowClass: "",
            };
            return (
              <TableRow key={i} className={config.rowClass}>
                <TableCell className="text-mono-small">
                  {diff.fieldName}
                </TableCell>
                <TableCell className="text-caption">
                  {config.label}
                </TableCell>
                <TableCell className="whitespace-normal text-mono-small text-muted-foreground">
                  {diff.logicalValue || "-"}
                </TableCell>
                <TableCell className="whitespace-normal text-mono-small text-muted-foreground">
                  {diff.implementationValue || "-"}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
