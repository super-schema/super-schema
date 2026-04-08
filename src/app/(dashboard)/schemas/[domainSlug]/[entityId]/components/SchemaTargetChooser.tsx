"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Zap } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { generateSchemaAction } from "../actions";
import type { TargetInfo } from "./TechnologyCard";

interface SchemaTargetChooserProps {
  entityId: string;
  fieldsCount: number;
  availableTargets: TargetInfo[];
  unavailableTargets?: Array<TargetInfo & { reason: string }>;
  compact?: boolean;
  onGenerated: () => Promise<void> | void;
}

export function SchemaTargetChooser({
  entityId,
  fieldsCount,
  availableTargets,
  unavailableTargets = [],
  compact = false,
  onGenerated,
}: SchemaTargetChooserProps) {
  const [selectedTargetKey, setSelectedTargetKey] = useState(availableTargets[0]?.key ?? "");
  const [isGenerating, setIsGenerating] = useState(false);

  useEffect(() => {
    if (availableTargets.some((target) => target.key === selectedTargetKey)) {
      return;
    }
    setSelectedTargetKey(availableTargets[0]?.key ?? "");
  }, [availableTargets, selectedTargetKey]);

  const selectedTarget = useMemo(
    () => availableTargets.find((target) => target.key === selectedTargetKey) ?? null,
    [availableTargets, selectedTargetKey]
  );

  async function handleGenerate() {
    if (!selectedTarget) return;

    if (fieldsCount === 0) {
      toast.error("Add fields before generating schemas");
      return;
    }

    setIsGenerating(true);
    try {
      const result = await generateSchemaAction(entityId, selectedTarget.key);
      if (result.error) {
        toast.error(result.error);
        return;
      }

      toast.success(
        `${selectedTarget.displayName} v${result.schemaVersion?.version} generated`
      );
      await onGenerated();
    } catch {
      toast.error("Generation failed unexpectedly");
    } finally {
      setIsGenerating(false);
    }
  }

  if (availableTargets.length === 0) {
    return null;
  }

  return (
    <section
      className={cn(
        "rounded-xl border border-border/50 bg-muted/15",
        compact ? "px-space-3 py-space-3" : "px-space-4 py-space-4"
      )}
      data-testid="schema-target-chooser"
    >
      <div className="flex flex-col gap-1">
        <h3 className="text-body-small font-semibold text-foreground">
          {compact ? "Generate Another Schema" : "Generate Schema"}
        </h3>
        <p className="text-body-small text-muted-foreground">
          {compact
            ? "Pick another technology from the list when you need a new generated output."
            : "No schemas have been generated for this entity yet. Choose a technology from the list to generate the first one."}
        </p>
      </div>

      <div className="mt-space-3 flex flex-col gap-space-3 md:flex-row md:items-end">
        <div className="min-w-0 flex-1 space-y-1">
          <label
            htmlFor="schema-target-select"
            className="text-caption font-medium text-foreground"
          >
            Technology
          </label>
          <select
            id="schema-target-select"
            value={selectedTargetKey}
            onChange={(event) => setSelectedTargetKey(event.target.value)}
            className="flex h-9 w-full rounded-lg border border-input bg-background px-space-3 text-body-small text-foreground outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            data-testid="schema-target-select"
          >
            {availableTargets.length > 0 && (
              <optgroup label="Generate Now">
                {availableTargets.map((target) => (
                  <option
                    key={target.key}
                    value={target.key}
                    data-testid={`schema-target-option-${target.key}`}
                  >
                    {target.displayName}
                  </option>
                ))}
              </optgroup>
            )}
            {unavailableTargets.length > 0 && (
              <optgroup label="Cataloged But Not Generateable Here">
                {unavailableTargets.map((target) => (
                  <option
                    key={target.key}
                    value={target.key}
                    disabled
                    data-testid={`schema-target-unavailable-${target.key}`}
                  >
                    {target.displayName} ({target.reason})
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>

        <Button
          size="sm"
          className="gap-1.5 md:shrink-0"
          disabled={!selectedTarget || isGenerating || fieldsCount === 0}
          onClick={handleGenerate}
          data-testid="generate-selected-schema"
        >
          {isGenerating ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Generating...
            </>
          ) : (
            <>
              <Zap className="w-3.5 h-3.5" />
              Generate Schema
            </>
          )}
        </Button>
      </div>

      <p className="mt-space-2 text-caption text-muted-foreground">
        {fieldsCount === 0
          ? "Add at least one field before generating."
          : selectedTarget
            ? `Ready to generate ${selectedTarget.displayName}.`
            : "Select a technology to continue."}
      </p>

      {unavailableTargets.length > 0 && (
        <p className="text-caption text-muted-foreground">
          {unavailableTargets.length} additional TypeSpec generators are cataloged here but stay disabled in the Schemas tab because they emit multi-file code artifacts instead of a single schema file.
        </p>
      )}
    </section>
  );
}
