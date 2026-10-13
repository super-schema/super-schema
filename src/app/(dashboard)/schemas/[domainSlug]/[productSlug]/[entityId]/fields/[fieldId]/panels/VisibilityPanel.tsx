"use client";

import { Button } from "@/components/ui/button";
import type { Visibility } from "@/types/schemas/typespec-decorator.schema";

const ALL_PHASES = ["Create", "Read", "Update", "Delete", "Query"] as const;
type Phase = (typeof ALL_PHASES)[number];

interface VisibilityPanelProps {
  visibility: Visibility;
  onChange: (visibility: Visibility) => void;
}

export function VisibilityPanel({
  visibility,
  onChange,
}: VisibilityPanelProps) {
  const phases = (visibility.phases ?? [...ALL_PHASES]) as Phase[];
  const isInvisible = visibility.invisible ?? false;
  const removeVisibility = visibility.removeVisibility ?? false;

  function update(partial: Partial<Visibility>) {
    onChange({ ...visibility, ...partial });
  }

  function togglePhase(phase: Phase) {
    const next = phases.includes(phase)
      ? phases.filter((p) => p !== phase)
      : [...phases, phase];
    update({
      phases: next as Visibility["phases"],
      invisible: next.length === 0,
    });
  }

  function setPhases(newPhases: Phase[]) {
    update({
      phases: newPhases as Visibility["phases"],
      invisible: newPhases.length === 0,
    });
  }

  // Generate TypeSpec decorator preview
  function getDecoratorPreview(): string {
    if (isInvisible || phases.length === 0) {
      return "@invisible";
    }
    if (phases.length === ALL_PHASES.length) {
      return "// visible in all phases (default)";
    }
    if (removeVisibility) {
      const removed = ALL_PHASES.filter((p) => !phases.includes(p));
      return `@removeVisibility(${removed.map((p) => `Lifecycle.${p}`).join(", ")})`;
    }
    return `@visibility(${phases.map((p) => `Lifecycle.${p}`).join(", ")})`;
  }

  return (
    <div className="space-y-space-4 pb-space-2">
      {/* Checkbox matrix */}
      <div>
        <div className="flex items-center gap-space-4">
          {ALL_PHASES.map((phase) => (
            <label
              key={phase}
              className="flex flex-col items-center gap-1 cursor-pointer"
            >
              <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">
                {phase}
              </span>
              <input
                type="checkbox"
                checked={phases.includes(phase)}
                onChange={() => togglePhase(phase)}
                className="accent-primary w-4 h-4"
              />
            </label>
          ))}
        </div>
      </div>

      {/* Bulk action buttons */}
      <div className="flex items-center gap-space-2 flex-wrap">
        <Button
          size="xs"
          variant="outline"
          onClick={() => setPhases(["Read"])}
        >
          Read Only
        </Button>
        <Button
          size="xs"
          variant="outline"
          onClick={() => setPhases(["Create", "Read"])}
        >
          Create + Read
        </Button>
        <Button
          size="xs"
          variant="outline"
          onClick={() => setPhases([...ALL_PHASES])}
        >
          All
        </Button>
        <Button
          size="xs"
          variant="outline"
          onClick={() => setPhases([])}
        >
          None / @invisible
        </Button>
      </div>

      {/* Decorator preview */}
      <div className="bg-muted/50 rounded-md px-space-3 py-space-2">
        <code className="text-caption font-mono text-foreground">
          {getDecoratorPreview()}
        </code>
      </div>

      {/* @removeVisibility toggle */}
      <label className="flex items-center gap-2 text-caption text-muted-foreground cursor-pointer">
        <input
          type="checkbox"
          checked={removeVisibility}
          onChange={(e) => update({ removeVisibility: e.target.checked })}
          className="accent-primary"
        />
        Use @removeVisibility (advanced — invert to specify which phases to
        remove)
      </label>
    </div>
  );
}
