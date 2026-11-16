"use client";

import { useState } from "react";
import { pluralize } from "@/lib/pluralize";
import {
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  XCircle,
} from "lucide-react";
import type { ParsedEntity } from "@/lib/importers/types";
import { ConfidenceBadge } from "./ConfidenceBadge";

import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
            {pluralize(activeCount, "entity", "entities")}
          </span>
          <span className="text-muted-foreground">
            , {pluralize(totalFields, "field")} total
          </span>
          {errors.length > 0 && (
            <span className="text-destructive ml-2">
              {pluralize(errors.length, "error")}
            </span>
          )}
        </div>
        <div className="flex items-center gap-space-2">
          <label className="text-caption text-muted-foreground">Domain:</label>
          <NativeSelect
            value={selectedDomainId}
            onChange={(e) => setSelectedDomainId(e.target.value)}
          >
            {domains.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </NativeSelect>
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
            Creating {progress.current} of {pluralize(progress.total, "entity", "entities")}...
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
                  {pluralize(entity.fields.length, "field")}
                </span>
                <span className="text-caption bg-muted px-1.5 py-0.5 rounded">
                  {entity.sourceFormat}
                </span>
                <Button
                  size="xs"
                  variant={isSkipped ? "secondary" : "destructive"}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleSkip(index);
                  }}
                >
                  {isSkipped ? "Include" : "Skip"}
                </Button>
              </div>

              {/* Expanded field details */}
              {isExpanded && !isSkipped && (
                <div className="px-space-4 pb-space-3">
                  <Table>
                    <TableHeader>
                      <TableRow className="text-caption text-muted-foreground hover:bg-transparent">
                        <TableHead className="h-auto py-1">Name</TableHead>
                        <TableHead className="h-auto py-1">Type</TableHead>
                        <TableHead className="h-auto py-1 text-center">Nullable</TableHead>
                        <TableHead className="h-auto py-1 text-center">Confidence</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {entity.fields.map((field, fi) => (
                        <TableRow key={fi} className="text-mono-small">
                          <TableCell>{field.name}</TableCell>
                          <TableCell>{field.type}</TableCell>
                          <TableCell className="text-center">
                            {field.nullable ? "Yes" : "No"}
                          </TableCell>
                          <TableCell className="text-center">
                            <ConfidenceBadge
                              confidence={field.confidence}
                              originalType={field.originalType}
                              mappedType={field.type}
                            />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Actions */}
      <div className="flex justify-end gap-space-2">
        <Button
          variant="ghost"
          onClick={onCancel}
          disabled={isConfirming}
          className="text-muted-foreground"
        >
          Cancel
        </Button>
        <Button
          data-testid="confirm-bulk-import-button"
          onClick={handleConfirm}
          disabled={isConfirming || activeCount === 0 || !selectedDomainId}
        >
          {isConfirming
            ? "Importing..."
            : `Confirm Import (${pluralize(activeCount, "entity", "entities")})`}
        </Button>
      </div>
    </div>
  );
}
