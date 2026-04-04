"use client";

import { ChevronDown, ChevronRight, X, ChevronsUpDown } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { DiffViewerProps } from "./DiffViewer.types";
import type { DiffField, PropertyChange, FieldSnapshot } from "@/services/version-history/version.types";
import { useDiffViewer } from "./useDiffViewer";

/** Map change type to row background class */
const ROW_BG: Record<string, string> = {
  added: "bg-emerald-500/10",
  removed: "bg-red-500/10",
  modified: "bg-amber-500/10",
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
    <tr className="border-b border-border/20 last:border-b-0">
      <td className="px-3 py-1.5 text-caption text-muted-foreground font-mono pl-12">
        {change.property}
      </td>
      <td className="px-3 py-1.5 text-caption text-muted-foreground">
        {change.category}
      </td>
      <td className="px-3 py-1.5 text-caption font-mono text-red-400/80">
        {formatValue(change.before)}
      </td>
      <td className="px-3 py-1.5 text-caption font-mono text-emerald-400/80">
        {formatValue(change.after)}
      </td>
    </tr>
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
      <tr
        className={`border-b border-border/30 transition-colors ${ROW_BG[field.changeType]} ${
          hasExpandableContent ? "cursor-pointer hover:opacity-80" : ""
        }`}
        onClick={hasExpandableContent ? onToggle : undefined}
        data-testid={`diff-row-${field.fieldName}`}
        data-change-type={field.changeType}
      >
        {/* Expand indicator */}
        <td className="w-8 px-2 py-2.5 text-center">
          {hasExpandableContent ? (
            <span className="text-muted-foreground">
              {isExpanded ? (
                <ChevronDown className="w-3.5 h-3.5 inline" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 inline" />
              )}
            </span>
          ) : null}
        </td>

        {/* Field Name */}
        <td className="px-3 py-2.5">
          <span className="font-mono text-body-small text-foreground">
            {field.fieldName}
          </span>
        </td>

        {/* Change Type Badge */}
        <td className="px-3 py-2.5">
          <Badge variant={BADGE_VARIANT[field.changeType]}>
            {BADGE_LABEL[field.changeType]}
          </Badge>
        </td>

        {/* Version A Type */}
        <td className="px-3 py-2.5 font-mono text-body-small text-muted-foreground">
          {getFieldType(field.versionA)}
        </td>

        {/* Version B Type */}
        <td className="px-3 py-2.5 font-mono text-body-small text-muted-foreground">
          {getFieldType(field.versionB)}
        </td>
      </tr>

      {/* Expanded property changes */}
      {isExpanded && hasExpandableContent && (
        <>
          <tr className="bg-background/30">
            <td />
            <td
              colSpan={4}
              className="px-3 py-1 text-caption text-muted-foreground font-medium"
            >
              Changed properties:
            </td>
          </tr>
          {field.changedProperties!.map((change) => (
            <tr
              key={change.property}
              className="bg-background/30 border-b border-border/10 last:border-b-0"
            >
              <td />
              <td className="px-3 py-1.5 text-caption text-muted-foreground font-mono pl-6">
                {change.property}
              </td>
              <td className="px-3 py-1.5 text-caption text-muted-foreground">
                {change.category}
              </td>
              <td className="px-3 py-1.5 text-caption font-mono text-red-400/80">
                {formatValue(change.before)}
              </td>
              <td className="px-3 py-1.5 text-caption font-mono text-emerald-400/80">
                {formatValue(change.after)}
              </td>
            </tr>
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
        <table className="w-full text-left" data-testid="diff-table">
          <thead>
            <tr className="border-b border-border/50 bg-muted/30">
              <th className="w-8" />
              <th
                className="px-3 py-2 text-caption font-medium text-muted-foreground cursor-pointer select-none"
                onClick={() => handleSort("fieldName")}
              >
                <span className="flex items-center gap-1">
                  Field Name
                  {sortKey === "fieldName" && (
                    <ChevronsUpDown className="w-3 h-3" />
                  )}
                </span>
              </th>
              <th
                className="px-3 py-2 text-caption font-medium text-muted-foreground cursor-pointer select-none"
                onClick={() => handleSort("changeType")}
              >
                <span className="flex items-center gap-1">
                  Change
                  {sortKey === "changeType" && (
                    <ChevronsUpDown className="w-3 h-3" />
                  )}
                </span>
              </th>
              <th className="px-3 py-2 text-caption font-medium text-muted-foreground">
                v{diff.fromVersion}
              </th>
              <th className="px-3 py-2 text-caption font-medium text-muted-foreground">
                v{diff.toVersion}
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedFields.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-3 py-8 text-center text-body-small text-muted-foreground"
                >
                  No differences found between these versions.
                </td>
              </tr>
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
          </tbody>
        </table>
      </div>
    </div>
  );
}
