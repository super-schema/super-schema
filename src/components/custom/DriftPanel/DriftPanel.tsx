"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { DriftBadge } from "@/components/custom/DriftBadge/DriftBadge";
import { DriftDiffView } from "./DriftDiffView";
import type { DriftReport } from "@/lib/drift/drift-comparator";

interface DriftPanelProps {
  driftReport: DriftReport | null;
  onCheckDrift?: () => void;
  isChecking?: boolean;
}

export function DriftPanel({
  driftReport,
  onCheckDrift,
  isChecking = false,
}: DriftPanelProps) {
  const [expandedTargets, setExpandedTargets] = useState<Set<number>>(
    new Set()
  );

  function toggleTarget(index: number) {
    setExpandedTargets((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  return (
    <div data-testid="drift-panel" className="flex flex-col gap-space-3">
      {/* Header with Check Drift button */}
      <div className="flex items-center justify-between">
        <h4 className="text-caption text-muted-foreground uppercase tracking-wider">
          Drift Status
        </h4>
        {onCheckDrift && (
          <button
            data-testid="check-drift-button"
            onClick={onCheckDrift}
            disabled={isChecking}
            className="flex items-center gap-1 px-2 py-1 rounded-lg text-caption text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-50"
          >
            <RefreshCw
              className={`w-3 h-3 ${isChecking ? "animate-spin" : ""}`}
            />
            Check Drift
          </button>
        )}
      </div>

      {/* No drift report */}
      {!driftReport && (
        <p className="text-caption text-muted-foreground">
          No drift check has been performed yet. Click &quot;Check Drift&quot; to
          compare against the imported schema.
        </p>
      )}

      {/* Drift report targets */}
      {driftReport && (
        <div className="space-y-1">
          {driftReport.targets.map((target, index) => {
            const isExpanded = expandedTargets.has(index);
            const hasDiffs = target.differences.length > 0;

            return (
              <div
                key={index}
                className="border border-border rounded-lg overflow-hidden"
              >
                {/* Target header */}
                <div
                  className="flex items-center gap-space-2 px-space-3 py-2 cursor-pointer hover:bg-accent/30"
                  onClick={() => hasDiffs && toggleTarget(index)}
                >
                  {hasDiffs ? (
                    isExpanded ? (
                      <ChevronDown className="w-3 h-3 shrink-0" />
                    ) : (
                      <ChevronRight className="w-3 h-3 shrink-0" />
                    )
                  ) : (
                    <span className="w-3" />
                  )}
                  <span className="text-body-small text-foreground flex-1">
                    {target.targetFormat}
                  </span>
                  <DriftBadge status={target.driftStatus} />
                  {hasDiffs && (
                    <span className="text-caption text-muted-foreground">
                      {target.differences.length} differences
                    </span>
                  )}
                </div>

                {/* Expanded diff view */}
                {isExpanded && hasDiffs && (
                  <div className="px-space-3 pb-space-3">
                    <DriftDiffView differences={target.differences} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
