"use client";

import { Loader2, Zap, History, Save } from "lucide-react";
import { Button } from "@/components/ui/button";

interface EntityToolbarProps {
  onHistory: () => void;
  onCreateVersion: () => void;
  onEmit: () => void;
  isEmitting: boolean;
  isCreatingVersion: boolean;
  readOnly: boolean;
  hasFields: boolean;
}

export function EntityToolbar({
  onHistory,
  onCreateVersion,
  onEmit,
  isEmitting,
  isCreatingVersion,
  readOnly,
  hasFields,
}: EntityToolbarProps) {
  return (
    <div className="flex items-center gap-space-2">
      {/* History button */}
      <Button
        variant="outline"
        onClick={onHistory}
        className="gap-1.5"
        title="View version history"
      >
        <History className="w-4 h-4" />
        History
      </Button>

      {/* Create Version button */}
      {!readOnly && (
        <Button
          variant="outline"
          onClick={onCreateVersion}
          disabled={isCreatingVersion}
          className="gap-1.5"
          title="Save current state as a new version"
        >
          {isCreatingVersion ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Saving...
            </>
          ) : (
            <>
              <Save className="w-4 h-4" />
              Create Version
            </>
          )}
        </Button>
      )}

      {/* Emit button */}
      {!readOnly && (
        <Button
          onClick={onEmit}
          disabled={isEmitting || !hasFields}
          className="gap-1.5"
          title={
            !hasFields
              ? "Add fields before emitting"
              : "Emit to all targets (Ctrl+E)"
          }
        >
          {isEmitting ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Emitting...
            </>
          ) : (
            <>
              <Zap className="w-4 h-4" />
              Emit
            </>
          )}
        </Button>
      )}
    </div>
  );
}
