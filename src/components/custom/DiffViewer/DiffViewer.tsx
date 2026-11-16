"use client";

import { ChevronDown, ChevronRight, X, ChevronsUpDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { DiffViewerProps } from "./DiffViewer.types";
import type { DiffField, PropertyChange, FieldSnapshot } from "@/services/version-history/version.types";
import { useDiffViewer } from "./useDiffViewer";

/** Map change type to row background class */
const ROW_BG: Record<string, string> = {
  added: "bg-success/10 hover:bg-success/15",
  removed: "bg-destructive/10 hover:bg-destructive/15",
  modified: "bg-warning/10 hover:bg-warning/15",
  unchanged: "",
};

/** Map change type to badge variant */
const BADGE_VARIANT: Record<string, "success" | "destructive" | "warning" | "secondary"> = {
  added: "success",
  removed: "destructive",
  modified: "warning",
  unchanged: "secondary",
};

/** Map change type to badge label */
const BADGE_LABEL: Record<string, string> = {
  added: "+ Added",
  removed: "- Removed",
  modified: "~ Modified",
  unchanged: "Unchanged",
};

/** Format a value for display */
function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return value || '""';
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[${value.join(", ")}]`;
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value, null, 0);
    } catch {
      return "[object]";
    }
  }
  return String(value);
}

/** Get the primary type string for a field snapshot */
function getFieldType(field?: FieldSnapshot): string {
  if (!field) return "-";
  return field.type;
}

function SummaryBar({ summary }: { summary: DiffViewerProps["diff"]["summary"] }) {
  return (
    <div className="flex items-center gap-space-4 px-space-4 py-space-2 rounded-lg border border-border/50 bg-background/50 mb-space-4">
      <span className="text-body-small text-muted-foreground">Summary:</span>
      <div className="flex items-center gap-space-3">
        {summary.added > 0 && (
          <span className="flex items-center gap-1 text-body-small">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            <span className="text-emerald-400 font-medium">{summary.added}</span>
            <span className="text-muted-foreground">added</span>
          </span>
        )}
        {summary.removed > 0 && (
          <span className="flex items-center gap-1 text-body-small">
            <span className="w-2 h-2 rounded-full bg-red-400" />
            <span className="text-red-400 font-medium">{summary.removed}</span>
            <span className="text-muted-foreground">removed</span>
          </span>
        )}
        {summary.modified > 0 && (
          <span className="flex items-center gap-1 text-body-small">
            <span className="w-2 h-2 rounded-full bg-amber-400" />
            <span className="text-amber-400 font-medium">{summary.modified}</span>
            <span className="text-muted-foreground">modified</span>
          </span>
        )}
        {summary.unchanged > 0 && (
          <span className="flex items-center gap-1 text-body-small">
            <span className="w-2 h-2 rounded-full bg-muted-foreground/50" />
            <span className="text-muted-foreground font-medium">{summary.unchanged}</span>
            <span className="text-muted-foreground">unchanged</span>
          </span>
        )}
      </div>
    </div>
  );
}

function PropertyChangeRow({ change }: { change: PropertyChange }) {
  return (
    <TableRow className="border-b border-border/20 last:border-b-0">
      <TableCell className="text-caption text-muted-foreground font-mono pl-12">
        {change.property}
      </TableCell>
      <TableCell className="text-caption text-muted-foreground">
        {change.category}
      </TableCell>
      <TableCell className="whitespace-normal text-caption font-mono text-red-400/80">
        {formatValue(change.before)}
      </TableCell>
      <TableCell className="whitespace-normal text-caption font-mono text-emerald-400/80">
        {formatValue(change.after)}
      </TableCell>
    </TableRow>
  );
}

function DiffFieldRow({
  field,
  isExpanded,
  onToggle,
}: {
  field: DiffField;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const hasExpandableContent =
    field.changeType === "modified" &&
    field.changedProperties &&
    field.changedProperties.length > 0;

  return (
    <>
      <TableRow
        className={`border-border/30 ${ROW_BG[field.changeType]} ${
          hasExpandableContent ? "cursor-pointer" : ""
        }`}
        onClick={hasExpandableContent ? onToggle : undefined}
        data-testid={`diff-row-${field.fieldName}`}
        data-change-type={field.changeType}
      >
        {/* Expand indicator */}
        <TableCell className="w-8 text-center">
          {hasExpandableContent ? (
            <span className="text-muted-foreground">
              {isExpanded ? (
                <ChevronDown className="w-3.5 h-3.5 inline" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 inline" />
              )}
            </span>
          ) : null}
        </TableCell>

        {/* Field Name */}
        <TableCell>
          <span className="font-mono text-body-small text-foreground">
            {field.fieldName}
          </span>
        </TableCell>

        {/* Change Type Badge */}
        <TableCell>
          <Badge variant={BADGE_VARIANT[field.changeType]}>
            {BADGE_LABEL[field.changeType]}
          </Badge>
        </TableCell>

        {/* Version A Type */}
        <TableCell className="font-mono text-body-small text-muted-foreground">
          {getFieldType(field.versionA)}
        </TableCell>

        {/* Version B Type */}
        <TableCell className="font-mono text-body-small text-muted-foreground">
          {getFieldType(field.versionB)}
        </TableCell>
      </TableRow>

      {/* Expanded property changes */}
      {isExpanded && hasExpandableContent && (
        <>
          <TableRow className="bg-background/30">
            <TableCell />
            <TableCell
              colSpan={4}
              className="py-1 text-caption text-muted-foreground font-medium"
            >
              Changed properties:
            </TableCell>
          </TableRow>
          {field.changedProperties!.map((change) => (
            <TableRow
              key={change.property}
              className="bg-background/30 border-border/10 last:border-b-0"
            >
              <TableCell />
              <TableCell className="text-caption text-muted-foreground font-mono pl-6">
                {change.property}
              </TableCell>
              <TableCell className="text-caption text-muted-foreground">
                {change.category}
              </TableCell>
              <TableCell className="whitespace-normal text-caption font-mono text-red-400/80">
                {formatValue(change.before)}
              </TableCell>
              <TableCell className="whitespace-normal text-caption font-mono text-emerald-400/80">
                {formatValue(change.after)}
              </TableCell>
            </TableRow>
          ))}
        </>
      )}
    </>
  );
}

export function DiffViewer({ diff, onClose }: DiffViewerProps) {
  const {
    sortedFields,
    sortKey,
    sortDirection,
    handleSort,
    isExpanded,
    toggleExpand,
    expandAll,
    collapseAll,
  } = useDiffViewer(diff.fields);

  const hasModifiedFields = diff.fields.some((f) => f.changeType === "modified");

  return (
    <div className="animate-auth-fade-up" data-testid="diff-viewer">
      {/* Header */}
      <div className="flex items-center justify-between mb-space-4">
        <div className="flex items-center gap-space-3">
          <h2 className="text-heading-2 text-foreground">
            Diff: v{diff.fromVersion} → v{diff.toVersion}
          </h2>
        </div>
        <div className="flex items-center gap-space-2">
          {hasModifiedFields && (
            <>
              <Button variant="ghost" size="sm" onClick={expandAll}>
                Expand All
              </Button>
              <Button variant="ghost" size="sm" onClick={collapseAll}>
                Collapse All
              </Button>
            </>
          )}
          <Button variant="ghost" size="sm" onClick={onClose} data-testid="close-diff">
            <X className="w-4 h-4 mr-1" />
            Close Diff
          </Button>
        </div>
      </div>

      {/* Summary Bar */}
      <SummaryBar summary={diff.summary} />

      {/* Diff Table */}
      <div className="rounded-xl border border-border/50 overflow-hidden">
        <Table data-testid="diff-table">
          <TableHeader>
            <TableRow className="border-border/50 bg-muted/30 hover:bg-muted/30">
              <TableHead className="w-8" />
              <TableHead
                className="text-caption text-muted-foreground cursor-pointer select-none"
                onClick={() => handleSort("fieldName")}
              >
                <span className="flex items-center gap-1">
                  Field Name
                  {sortKey === "fieldName" && (
                    <ChevronsUpDown className="w-3 h-3" />
                  )}
                </span>
              </TableHead>
              <TableHead
                className="text-caption text-muted-foreground cursor-pointer select-none"
                onClick={() => handleSort("changeType")}
              >
                <span className="flex items-center gap-1">
                  Change
                  {sortKey === "changeType" && (
                    <ChevronsUpDown className="w-3 h-3" />
                  )}
                </span>
              </TableHead>
              <TableHead className="text-caption text-muted-foreground">
                v{diff.fromVersion}
              </TableHead>
              <TableHead className="text-caption text-muted-foreground">
                v{diff.toVersion}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedFields.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="py-8 text-center text-body-small text-muted-foreground"
                >
                  No differences found between these versions.
                </TableCell>
              </TableRow>
            ) : (
              sortedFields.map((field) => (
                <DiffFieldRow
                  key={field.fieldName}
                  field={field}
                  isExpanded={isExpanded(field.fieldName)}
                  onToggle={() => toggleExpand(field.fieldName)}
                />
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
