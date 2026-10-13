"use client";

import { useRouter } from "next/navigation";
import {
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import type { ComplianceFieldResult } from "@/types/schemas/compliance";

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
      <div className="px-space-4 py-space-2 text-body-small text-muted-foreground">
        Showing {total > 0 ? `${from}-${to}` : "0"} of {total} fields matching
        filters
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-body-small">
          <thead className="sticky top-0 surface-1 border-b border-border">
            <tr>
              {COLUMNS.map((col) => (
                <th
                  key={col.key}
                  className="text-left px-space-3 py-space-2 text-caption text-muted-foreground uppercase tracking-wider cursor-pointer hover:text-foreground transition-colors select-none"
                  onClick={() => onSort(col.key)}
                >
                  <span className="flex items-center gap-1">
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
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <tr
                  key={`skeleton-${i}`}
                  className="border-b border-border/50"
                >
                  {COLUMNS.map((col) => (
                    <td key={col.key} className="px-space-3 py-space-2">
                      <div className="h-4 bg-muted rounded animate-pulse w-20" />
                    </td>
                  ))}
                </tr>
              ))
            ) : fields.length === 0 ? (
              <tr>
                <td
                  colSpan={COLUMNS.length}
                  className="text-center py-space-8 text-muted-foreground"
                >
                  No fields match the current filters. Try adjusting your filter
                  criteria.
                </td>
              </tr>
            ) : (
              fields.map((field) => (
                <tr
                  key={field.fieldId}
                  className="border-b border-border/50 hover:bg-accent/30 cursor-pointer transition-colors"
                  onClick={() =>
                    router.push(
                      field.domainSlug && field.productSlug
                        ? `/schemas/${field.domainSlug}/${field.productSlug}/${field.entitySlug || field.entityId}`
                        : `/schemas?entityId=${encodeURIComponent(field.entityId)}`
                    )
                  }
                >
                  <td className="px-space-3 py-space-2 text-primary hover:underline font-mono">
                    {field.entityName}
                  </td>
                  <td className="px-space-3 py-space-2 font-mono">
                    {field.fieldName}
                  </td>
                  <td className="px-space-3 py-space-2 text-muted-foreground">
                    {field.fieldType}
                  </td>
                  <td className="px-space-3 py-space-2">
                    <ClassificationBadge level={field.classification} />
                  </td>
                  <td className="px-space-3 py-space-2 text-muted-foreground">
                    {field.retention || "--"}
                  </td>
                  <td className="px-space-3 py-space-2 text-muted-foreground">
                    {field.anonymization || "--"}
                  </td>
                  <td className="px-space-3 py-space-2 text-muted-foreground">
                    {field.domain}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-space-4 py-space-2 border-t border-border">
          <span className="text-caption text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <div className="flex items-center gap-space-2">
            <button
              disabled={page <= 1}
              onClick={() => onPageChange(page - 1)}
              className="p-1 rounded hover:bg-accent/50 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              disabled={page >= totalPages}
              onClick={() => onPageChange(page + 1)}
              className="p-1 rounded hover:bg-accent/50 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
