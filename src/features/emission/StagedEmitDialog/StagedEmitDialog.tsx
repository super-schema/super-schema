"use client";

/**
 * StagedEmitDialog
 *
 * Modal dialog for per-target staged emission.
 * Shows a checklist of targets with compatibility and complexity badges.
 * Non-breaking targets are pre-checked; breaking targets are unchecked.
 */

import { useState } from "react";
import type { PerTargetImpact } from "@/types/schemas/governance";

interface TargetRow {
  target: string;
  compatible: boolean;
  migrationComplexity: "trivial" | "moderate" | "complex";
  details: string;
}

interface StagedEmitDialogProps {
  open: boolean;
  onClose: () => void;
  targets: TargetRow[];
  entityName: string;
  versionId: number;
  onEmitSelected: (selectedTargets: string[]) => void;
  onStageForLater?: (target: string) => void;
}

const COMPLEXITY_STYLES: Record<string, { bg: string; text: string }> = {
  trivial: { bg: "bg-emerald-500/20", text: "text-emerald-400" },
  moderate: { bg: "bg-amber-500/20", text: "text-amber-400" },
  complex: { bg: "bg-red-500/20", text: "text-red-400" },
};

export function StagedEmitDialog({
  open,
  onClose,
  targets,
  entityName,
  versionId,
  onEmitSelected,
  onStageForLater,
}: StagedEmitDialogProps) {
  const [selected, setSelected] = useState<Set<string>>(() => {
    // Pre-check compatible targets
    const initial = new Set<string>();
    for (const t of targets) {
      if (t.compatible) initial.add(t.target);
    }
    return initial;
  });

  if (!open) return null;

  const toggleTarget = (target: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(target)) {
        next.delete(target);
      } else {
        next.add(target);
      }
      return next;
    });
  };

  const handleEmit = () => {
    onEmitSelected(Array.from(selected));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60"
        onClick={onClose}
      />

      {/* Dialog */}
      <div
        data-testid="staged-emit-dialog"
        className="relative w-[560px] max-h-[80vh] rounded-xl border border-border overflow-hidden flex flex-col"
        style={{
          background: "rgba(28, 28, 38, 0.95)",
          backdropFilter: "blur(16px)",
        }}
      >
        {/* Header */}
        <div className="p-5 border-b border-border">
          <h2 className="text-heading-2 text-foreground">
            Emit Schema &mdash; Select Targets
          </h2>
          <p className="text-caption text-muted-foreground mt-1">
            {entityName} v{versionId}
          </p>
        </div>

        {/* Target list */}
        <div className="flex-1 overflow-y-auto p-5 space-y-2">
          {targets.map((t) => {
            const isSelected = selected.has(t.target);
            const compStyle =
              COMPLEXITY_STYLES[t.migrationComplexity] ??
              COMPLEXITY_STYLES.moderate;

            return (
              <div
                key={t.target}
                className={`flex items-center gap-3 p-3 rounded-lg border transition-colors cursor-pointer ${
                  isSelected
                    ? "border-primary/50 bg-primary/5"
                    : "border-border hover:border-border/80"
                }`}
                onClick={() => toggleTarget(t.target)}
              >
                {/* Checkbox */}
                <div
                  className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 ${
                    isSelected
                      ? "border-primary bg-primary"
                      : "border-muted-foreground"
                  }`}
                >
                  {isSelected && (
                    <span className="text-white text-mono-small">{"\u2713"}</span>
                  )}
                </div>

                {/* Target name */}
                <span className="text-caption font-medium text-foreground w-24">
                  {t.target}
                </span>

                {/* Compatibility badge */}
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded text-mono-small font-medium ${
                    t.compatible
                      ? "bg-emerald-500/20 text-emerald-400"
                      : "bg-red-500/20 text-red-400"
                  }`}
                >
                  {t.compatible ? "Compatible" : "Breaking"}
                </span>

                {/* Complexity badge */}
                <span
                  className={`inline-flex items-center px-2 py-0.5 rounded text-mono-small font-medium ${compStyle.bg} ${compStyle.text}`}
                >
                  {t.migrationComplexity}
                </span>

                {/* Stage for later link (for breaking targets) */}
                {!t.compatible && !isSelected && onStageForLater && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onStageForLater(t.target);
                    }}
                    className="ml-auto text-mono-small text-amber-400 hover:text-amber-300 transition-colors"
                  >
                    Stage for Later
                  </button>
                )}

                {/* Warning for breaking */}
                {!t.compatible && !isSelected && !onStageForLater && (
                  <span className="ml-auto text-mono-small text-amber-400">
                    {"\u26A0"} Breaking
                  </span>
                )}
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="p-5 border-t border-border flex items-center justify-between">
          <span className="text-caption text-muted-foreground">
            {selected.size} of {targets.length} target
            {targets.length !== 1 ? "s" : ""} selected
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded text-caption font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleEmit}
              disabled={selected.size === 0}
              className="px-5 py-2 rounded text-caption font-medium text-white transition-colors disabled:opacity-50"
              style={{
                background: "linear-gradient(135deg, #A477B2, #8B5CF6)",
              }}
            >
              Emit Selected
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
