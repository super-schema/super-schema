"use client";

import { useRouter } from "next/navigation";
import {
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { assetHref } from "@/lib/navigation/asset-href";
import type { ComplianceFieldResult } from "@/types/schemas/compliance";
import { pluralize } from "@/lib/pluralize";

/** Entity route of a result row; null slugs are a tenant-level entity (assetHref handles it). */
export function entityHref(field: ComplianceFieldResult): string {
  return assetHref({
    kind: "entity",
    slug: field.entitySlug || field.entityId,
    domainSlug: field.domainSlug,
    productSlug: field.productSlug,
  });
}

interface ComplianceResultsTableProps {
  fields: ComplianceFieldResult[];
  total: number;
  page: number;
  pageSize: number;
  sortBy: string;
  sortOrder: "asc" | "desc";
  onSort: (column: string) => void;
  onPageChange: (page: number) => void;
  loading: boolean;
}

const COLUMNS = [
  { key: "entityName", label: "Entity Name" },
  { key: "fieldName", label: "Field Name" },
  { key: "fieldType", label: "Type" },
  { key: "classification", label: "Classification" },
  { key: "retention", label: "Retention" },
  { key: "anonymization", label: "Anonymization" },
  { key: "domain", label: "Domain" },
];

function ClassificationBadge({ level }: { level: string | null }) {
  if (!level) return <span className="text-muted-foreground">--</span>;
  const colors: Record<string, string> = {
    PII: "bg-red-500/20 text-red-400",
    SENSITIVE: "bg-amber-500/20 text-amber-400",
    INTERNAL: "bg-blue-500/20 text-blue-400",
    PUBLIC: "bg-green-500/20 text-green-400",
  };
  return (
    <span
      className={`inline-block px-1.5 py-0.5 rounded text-caption font-medium ${colors[level] || "bg-muted text-muted-foreground"}`}
    >
      {level}
    </span>
  );
}

export function ComplianceResultsTable({
  fields,
  total,
  page,
  pageSize,
  sortBy,
  sortOrder,
  onSort,
  onPageChange,
  loading,
}: ComplianceResultsTableProps) {
  const router = useRouter();
  const totalPages = Math.ceil(total / pageSize);
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <div className="flex-1 flex flex-col overflow-hidden" data-testid="compliance-results-table">
      {/* Result count */}
      <div data-testid="compliance-result-count" className="px-space-4 py-space-2 text-body-small text-muted-foreground">
        Showing {total > 0 ? `${from}-${to}` : "0"} of {pluralize(total, "field")} matching
        filters
      </div>

      {/* Table */}
      {/* A scroll area has to be reachable by keyboard to be scrolled by it */}
      <div className="flex-1 overflow-auto" tabIndex={0} role="region" aria-label="Compliance results">
        <Table containerProps={{ className: "overflow-visible" }} className="text-body-small">
          <TableHeader className="sticky top-0 surface-1 border-b border-border">
            <TableRow className="hover:bg-transparent">
              {COLUMNS.map((col) => (
                <TableHead
                  key={col.key}
                  className="text-muted-foreground uppercase tracking-wider cursor-pointer hover:text-foreground transition-colors select-none"
                  onClick={() => onSort(col.key)}
                >
                  <span className="flex items-center gap-1 text-caption">
                    {col.label}
                    <ArrowUpDown
                      className={`w-3 h-3 ${sortBy === col.key ? "text-primary" : "opacity-30"}`}
                    />
                    {sortBy === col.key && (
                      <span className="text-primary text-[10px]">
                        {sortOrder === "asc" ? "A" : "D"}
                      </span>
                    )}
                  </span>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow
                  key={`skeleton-${i}`}
                  className="border-border/50"
                >
                  {COLUMNS.map((col) => (
                    <TableCell key={col.key}>
                      <div className="h-4 bg-muted rounded animate-pulse w-20" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : fields.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={COLUMNS.length}
                  className="text-center py-space-8 text-muted-foreground whitespace-normal"
                >
                  No fields match the current filters. Try adjusting your filter
                  criteria.
                </TableCell>
              </TableRow>
            ) : (
              fields.map((field) => (
                <TableRow
                  key={field.fieldId}
                  data-testid="compliance-row"
                  data-entity={field.entityName}
                  data-field={field.fieldName}
                  className="border-border/50 hover:bg-accent/30 cursor-pointer"
                  onClick={() =>
                    router.push(entityHref(field))
                  }
                >
                  <TableCell className="text-primary hover:underline font-mono">
                    {field.entityName}
                  </TableCell>
                  <TableCell className="font-mono">
                    {field.fieldName}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {field.fieldType}
                  </TableCell>
                  <TableCell>
                    <ClassificationBadge level={field.classification} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {field.retention || "--"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {field.anonymization || "--"}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {field.domain}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-space-4 py-space-2 border-t border-border">
          <span className="text-caption text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <div className="flex items-center gap-space-2">
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={page <= 1}
              onClick={() => onPageChange(page - 1)}
              aria-label="Previous page"
            >
              <ChevronLeft className="w-4 h-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={page >= totalPages}
              onClick={() => onPageChange(page + 1)}
              aria-label="Next page"
            >
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
