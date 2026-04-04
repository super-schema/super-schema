"use client";

import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  XCircle,
} from "lucide-react";
import type { ParsedEntity } from "@/lib/importers/types";
import { ConfidenceBadge } from "./ConfidenceBadge";

interface BulkImportReviewScreenProps {
  parsedEntities: ParsedEntity[];
  errors: { filename: string; error: string }[];
  warnings: string[];
  onConfirm: (entities: ParsedEntity[], domainId: string) => void;
  onCancel: () => void;
  domains: { id: string; name: string }[];
  isConfirming?: boolean;
  progress?: { current: number; total: number };
}

export function BulkImportReviewScreen({
  parsedEntities,
  errors,
  warnings,
  onConfirm,
  onCancel,
  domains,
  isConfirming = false,
  progress,
}: BulkImportReviewScreenProps) {
  const [selectedDomainId, setSelectedDomainId] = useState(
    domains[0]?.id || ""
  );
  const [expandedEntities, setExpandedEntities] = useState<Set<number>>(
    new Set()
  );
  const [skippedEntities, setSkippedEntities] = useState<Set<number>>(
    new Set()
  );

  function toggleExpand(index: number) {
    setExpandedEntities((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  function toggleSkip(index: number) {
    setSkippedEntities((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  function handleConfirm() {
    const activeEntities = parsedEntities.filter(
      (_, i) => !skippedEntities.has(i)
    );
    onConfirm(activeEntities, selectedDomainId);
  }

  const activeCount = parsedEntities.length - skippedEntities.size;
  const totalFields = parsedEntities
    .filter((_, i) => !skippedEntities.has(i))
    .reduce((sum, e) => sum + e.fields.length, 0);

  return (
    <div
      data-testid="bulk-import-review-screen"
      className="flex flex-col gap-space-4"
    >
      {/* Summary + domain selector */}
      <div className="flex items-center justify-between">
        <div className="text-body-small">
          <span className="text-foreground font-medium">
            {activeCount} entities
          </span>
          <span className="text-muted-foreground">
            , {totalFields} fields total
          </span>
          {errors.length > 0 && (
            <span className="text-destructive ml-2">
              {errors.length} errors
            </span>
          )}
        </div>
        <div className="flex items-center gap-space-2">
          <label className="text-caption text-muted-foreground">Domain:</label>
          <select
            value={selectedDomainId}
            onChange={(e) => setSelectedDomainId(e.target.value)}
            className="bg-muted rounded-lg px-space-3 py-1 text-body-small text-foreground outline-none border border-border"
          >
            {domains.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Progress bar during confirmation */}
      {isConfirming && progress && (
        <div className="space-y-1">
          <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
            <div
              className="bg-primary h-full rounded-full transition-all duration-300"
              style={{
                width: `${(progress.current / progress.total) * 100}%`,
              }}
            />
          </div>
          <p className="text-caption text-muted-foreground">
            Creating {progress.current} of {progress.total} entities...
          </p>
        </div>
      )}

      {/* Errors */}
      {errors.length > 0 && (
        <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-space-3 space-y-1">
          <p className="text-caption font-medium text-destructive">
            Import Errors
          </p>
          {errors.map((e, i) => (
            <div key={i} className="flex items-center gap-space-2">
              <XCircle className="w-3 h-3 text-destructive shrink-0" />
              <span className="text-caption text-muted-foreground">
                {e.filename}: {e.error}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Warnings */}
      {warnings.length > 0 && (
        <div className="bg-warning/10 border border-warning/30 rounded-lg p-space-3 space-y-1">
          <p className="text-caption font-medium text-warning">Warnings</p>
          {warnings.slice(0, 5).map((w, i) => (
            <div key={i} className="flex items-center gap-space-2">
              <AlertTriangle className="w-3 h-3 text-warning shrink-0" />
              <span className="text-caption text-muted-foreground">{w}</span>
            </div>
          ))}
          {warnings.length > 5 && (
            <p className="text-caption text-muted-foreground">
              ...and {warnings.length - 5} more warnings
            </p>
          )}
        </div>
      )}

      {/* Entity list */}
      <div className="border border-border rounded-lg overflow-hidden max-h-[400px] overflow-y-auto">
        {parsedEntities.map((entity, index) => {
          const isExpanded = expandedEntities.has(index);
          const isSkipped = skippedEntities.has(index);

          return (
            <div
              key={index}
              className={`border-b border-border last:border-0 ${isSkipped ? "opacity-50" : ""}`}
            >
              {/* Entity header */}
              <div
                className="flex items-center gap-space-2 px-space-3 py-2 cursor-pointer hover:bg-accent/30"
                onClick={() => toggleExpand(index)}
              >
                {isExpanded ? (
                  <ChevronDown className="w-3 h-3 shrink-0" />
                ) : (
                  <ChevronRight className="w-3 h-3 shrink-0" />
                )}
                <span className="text-body-small font-medium text-foreground flex-1">
                  {entity.name}
                </span>
                <span className="text-caption text-muted-foreground">
                  {entity.fields.length} fields
                </span>
                <span className="text-caption bg-muted px-1.5 py-0.5 rounded">
                  {entity.sourceFormat}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleSkip(index);
                  }}
                  className={`text-caption px-2 py-0.5 rounded ${
                    isSkipped
                      ? "bg-muted text-foreground"
                      : "bg-destructive/10 text-destructive hover:bg-destructive/20"
                  }`}
                >
                  {isSkipped ? "Include" : "Skip"}
                </button>
              </div>

              {/* Expanded field details */}
              {isExpanded && !isSkipped && (
                <div className="px-space-4 pb-space-3">
                  <table className="w-full">
                    <thead>
                      <tr className="text-caption text-muted-foreground">
                        <th className="text-left py-1">Name</th>
                        <th className="text-left py-1">Type</th>
                        <th className="text-center py-1">Nullable</th>
                        <th className="text-center py-1">Confidence</th>
                      </tr>
                    </thead>
                    <tbody>
                      {entity.fields.map((field, fi) => (
                        <tr key={fi} className="text-mono-small">
                          <td className="py-0.5">{field.name}</td>
                          <td className="py-0.5">{field.type}</td>
                          <td className="py-0.5 text-center">
                            {field.nullable ? "Yes" : "No"}
                          </td>
                          <td className="py-0.5 text-center">
                            <ConfidenceBadge
                              confidence={field.confidence}
                              originalType={field.originalType}
                              mappedType={field.type}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Actions */}
      <div className="flex justify-end gap-space-2">
        <button
          onClick={onCancel}
          disabled={isConfirming}
          className="px-4 py-1.5 rounded-lg text-body-small text-muted-foreground hover:bg-accent disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          data-testid="confirm-bulk-import-button"
          onClick={handleConfirm}
          disabled={isConfirming || activeCount === 0 || !selectedDomainId}
          className="px-4 py-1.5 rounded-lg text-body-small bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isConfirming
            ? "Importing..."
            : `Confirm Import (${activeCount} entities)`}
        </button>
      </div>
    </div>
  );
}
