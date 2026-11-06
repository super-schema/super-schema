"use client";

/** Modal checklist for generating schemas for selected targets. */

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

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

const COMPLEXITY_VARIANTS = {
  trivial: "success",
  moderate: "warning",
  complex: "destructive",
} as const;

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

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <DialogContent
        data-testid="staged-emit-dialog"
        className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden sm:max-w-xl"
      >
        <DialogHeader className="shrink-0 pr-8">
          <DialogTitle>Emit Schema &mdash; Select Targets</DialogTitle>
          <DialogDescription>
            {entityName} v{versionId}. Generate draft schemas for the selected
            targets. Deployment is a separate step.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <fieldset className="flex min-w-0 flex-col gap-2 p-1">
            <legend className="sr-only">Schema targets</legend>
            {targets.map((t) => {
              const isSelected = selected.has(t.target);

              return (
                <div
                  key={t.target}
                  data-testid="staged-emit-target"
                  data-target={t.target}
                  data-selected={isSelected ? "true" : "false"}
                  className={cn(
                    "flex shrink-0 flex-wrap items-center gap-3 rounded-lg border p-3 transition-colors focus-within:ring-2 focus-within:ring-ring",
                    isSelected
                      ? "border-primary/50 bg-primary/5"
                      : "border-border hover:bg-muted/50"
                  )}
                >
                  <label className="flex min-w-0 flex-1 cursor-pointer flex-wrap items-center gap-3">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleTarget(t.target)}
                      aria-label={t.details || t.target}
                      className="size-4 shrink-0 accent-primary"
                    />
                    <span className="min-w-0 flex-1 basis-24 break-words font-medium">
                      {t.details || t.target}
                    </span>
                    <span className="flex flex-wrap items-center gap-2">
                      <Badge variant={t.compatible ? "success" : "destructive"}>
                        {t.compatible ? "Compatible" : "Breaking"}
                      </Badge>
                      <Badge variant={COMPLEXITY_VARIANTS[t.migrationComplexity] ?? "warning"}>
                        {t.migrationComplexity}
                      </Badge>
                    </span>
                  </label>

                  {!t.compatible && !isSelected && onStageForLater && (
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      onClick={() => onStageForLater(t.target)}
                    >
                      Stage for Later
                    </Button>
                  )}
                  {!t.compatible && !isSelected && !onStageForLater && (
                    <span className="text-xs text-warning">⚠ Breaking</span>
                  )}
                </div>
              );
            })}
          </fieldset>
        </div>

        <DialogFooter className="shrink-0">
          <span
            data-testid="staged-emit-count"
            className="text-sm text-muted-foreground sm:mr-auto sm:self-center"
          >
            {selected.size} of {targets.length} target
            {targets.length !== 1 ? "s" : ""} selected
          </span>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              data-testid="staged-emit-cancel"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => onEmitSelected(Array.from(selected))}
              data-testid="staged-emit-submit"
              disabled={selected.size === 0}
            >
              Emit Selected
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
