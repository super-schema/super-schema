"use client";

import { useEffect } from "react";
import { toast } from "sonner";
import { AlertTriangle, Shield, Loader2, Check } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import type { TypeMappingOverrideDialogProps } from "./TypeMappingOverrideDialog.types";
import { useOverrideDialog } from "./useOverrideDialog";

// ---------------------------------------------------------------------------
// Target type selector with autocomplete
// ---------------------------------------------------------------------------

function TargetTypeSelector({
  value,
  onChange,
  filter,
  onFilterChange,
  filteredTypes,
}: {
  value: string;
  onChange: (v: string) => void;
  filter: string;
  onFilterChange: (v: string) => void;
  filteredTypes: string[];
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-caption text-muted-foreground block">
        New mapped type
      </label>
      <input
        type="text"
        value={filter || value}
        onChange={(e) => {
          onFilterChange(e.target.value);
          onChange(e.target.value);
        }}
        placeholder="Start typing to search..."
        className="w-full rounded-lg border border-border bg-transparent px-3 py-2 text-body-small text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-ring"
      />
      {filter && filteredTypes.length > 0 && (
        <div className="rounded-lg border border-border bg-popover max-h-[160px] overflow-auto">
          {filteredTypes.map((type) => (
            <button
              key={type}
              type="button"
              className="w-full text-left px-3 py-1.5 text-body-small hover:bg-accent/50 transition-colors flex items-center gap-2"
              onClick={() => {
                onChange(type);
                onFilterChange("");
              }}
            >
              {type === value && <Check className="w-3 h-3 text-success" />}
              <span className="font-mono">{type}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main dialog component
// ---------------------------------------------------------------------------

export function TypeMappingOverrideDialog({
  open,
  onClose,
  mappingContext,
  entityId,
  userRole,
  onCreateOverride,
  onAcknowledge,
}: TypeMappingOverrideDialogProps) {
  const {
    mode,
    setMode,
    newMappedType,
    setNewMappedType,
    justification,
    setJustification,
    isSubmitting,
    setIsSubmitting,
    typeFilter,
    setTypeFilter,
    canCreateGlobal,
    canCreateEntity,
    canAcknowledge,
    filteredTypes,
    isValid,
    reset,
  } = useOverrideDialog(mappingContext, userRole);

  // Reset form when dialog opens/closes or context changes
  useEffect(() => {
    if (open) {
      reset();
    }
  }, [open, mappingContext, reset]);

  const handleSubmit = async () => {
    if (!mappingContext || !isValid) return;

    setIsSubmitting(true);
    try {
      if (mode === "accept") {
        await onAcknowledge?.(
          mappingContext.sourceType,
          mappingContext.targetFormat
        );
        toast.success("Lossy mapping acknowledged");
      } else if (mode === "global" || mode === "per-entity") {
        await onCreateOverride({
          sourceType: mappingContext.sourceType,
          targetFormat: mappingContext.targetFormat,
          mappedType: newMappedType,
          justification,
          scope: mode,
          isLossy: false,
        });
        toast.success(
          `${mode === "global" ? "Global" : "Per-entity"} override created`
        );
      }
      onClose();
    } catch {
      toast.error("Failed to create override");
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!mappingContext) return null;

  return (
    <Sheet open={open}>
      <SheetContent
        side="right"
        className="sm:max-w-md w-full"
        style={{
          backgroundColor: "rgba(28, 28, 38, 0.8)",
          backdropFilter: "blur(12px)",
        }}
      >
        <SheetHeader className="border-b border-border pb-4">
          <SheetTitle className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-blue-400" />
            Type Mapping Override
          </SheetTitle>
          <SheetDescription>
            Override the default type mapping for this emission target
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 overflow-auto p-4 space-y-5">
          {/* Current mapping info */}
          <div className="rounded-lg border border-border bg-muted/20 p-3 space-y-2">
            <h4 className="text-caption font-medium text-muted-foreground uppercase tracking-wider">
              Current Mapping
            </h4>
            <div className="grid grid-cols-2 gap-2 text-body-small">
              <div>
                <span className="text-muted-foreground">Source type:</span>
                <span className="ml-1 font-mono text-foreground">
                  {mappingContext.sourceType}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">Target:</span>
                <span className="ml-1 font-mono text-foreground">
                  {mappingContext.targetFormat}
                </span>
              </div>
              <div className="col-span-2">
                <span className="text-muted-foreground">Mapped type:</span>
                <span className="ml-1 font-mono text-foreground">
                  {mappingContext.currentMappedType || "(default)"}
                </span>
              </div>
            </div>
            {mappingContext.lossDescription && (
              <div className="flex items-start gap-1.5 text-caption text-warning mt-2 pt-2 border-t border-border">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>{mappingContext.lossDescription}</span>
              </div>
            )}
          </div>

          {/* Action selection */}
          <div className="space-y-2">
            <h4 className="text-caption font-medium text-muted-foreground uppercase tracking-wider">
              Action
            </h4>
            <div className="space-y-1.5">
              {canAcknowledge && mappingContext.lossDescription && (
                <button
                  type="button"
                  onClick={() => setMode("accept")}
                  className={`w-full text-left rounded-lg border p-3 transition-colors ${
                    mode === "accept"
                      ? "border-warning bg-warning/10"
                      : "border-border hover:border-warning/50"
                  }`}
                >
                  <div className="text-body-small font-medium text-foreground">
                    Accept Lossy Mapping
                  </div>
                  <div className="text-caption text-muted-foreground">
                    Acknowledge the warning for this entity — dismisses it
                  </div>
                </button>
              )}
              {canCreateEntity && (
                <button
                  type="button"
                  onClick={() => setMode("per-entity")}
                  className={`w-full text-left rounded-lg border p-3 transition-colors ${
                    mode === "per-entity"
                      ? "border-blue-500 bg-blue-500/10"
                      : "border-border hover:border-blue-500/50"
                  }`}
                >
                  <div className="text-body-small font-medium text-foreground">
                    Create Per-Entity Override
                  </div>
                  <div className="text-caption text-muted-foreground">
                    Change the mapping for this entity only
                  </div>
                </button>
              )}
              {canCreateGlobal && (
                <button
                  type="button"
                  onClick={() => setMode("global")}
                  className={`w-full text-left rounded-lg border p-3 transition-colors ${
                    mode === "global"
                      ? "border-purple-500 bg-purple-500/10"
                      : "border-border hover:border-purple-500/50"
                  }`}
                >
                  <div className="flex items-center gap-1.5 text-body-small font-medium text-foreground">
                    Create Global Override
                    <Badge variant="secondary" className="text-[10px]">
                      Steward/Admin
                    </Badge>
                  </div>
                  <div className="text-caption text-muted-foreground">
                    Change the mapping for all entities
                  </div>
                </button>
              )}
            </div>
          </div>

          {/* Override form (visible when global or per-entity is selected) */}
          {(mode === "global" || mode === "per-entity") && (
            <div className="space-y-4 border-t border-border pt-4">
              <TargetTypeSelector
                value={newMappedType}
                onChange={setNewMappedType}
                filter={typeFilter}
                onFilterChange={setTypeFilter}
                filteredTypes={filteredTypes}
              />
              <div className="space-y-1.5">
                <label className="text-caption text-muted-foreground block">
                  Justification <span className="text-destructive">*</span>
                </label>
                <Textarea
                  value={justification}
                  onChange={(e) => setJustification(e.target.value)}
                  placeholder="Explain why this override is needed..."
                  rows={3}
                  className="resize-none"
                />
                {justification.length === 0 && (
                  <p className="text-caption text-muted-foreground">
                    A justification is required for all overrides.
                  </p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        {mode && (
          <div className="border-t border-border p-4 flex items-center gap-2">
            <Button
              onClick={handleSubmit}
              disabled={!isValid || isSubmitting}
              className="flex-1"
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin mr-1.5" />
                  Applying...
                </>
              ) : mode === "accept" ? (
                "Acknowledge Warning"
              ) : (
                `Create ${mode === "global" ? "Global" : "Per-Entity"} Override`
              )}
            </Button>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
