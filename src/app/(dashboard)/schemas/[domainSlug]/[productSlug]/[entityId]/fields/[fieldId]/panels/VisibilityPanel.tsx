"use client";
import { Button } from "@/components/ui/button";
import { FieldGroup, FieldDescription } from "@/components/ui/field";
import { LIFECYCLE_PHASES } from "@/lib/field-attributes";
import type { Visibility } from "@/types/schemas/typespec-decorator.schema";
import { Checkbox } from "@/components/ui/checkbox";
export function VisibilityPanel({
  visibility: v,
  onChange,
}: {
  visibility: Visibility;
  onChange: (v: Visibility) => void;
}) {
  const phases = v.invisible ? [] : (v.phases ?? [...LIFECYCLE_PHASES]);
  function set(phases: Visibility["phases"]) {
    onChange({ ...v, phases, invisible: phases?.length === 0 });
  }
  const removed = LIFECYCLE_PHASES.filter((phase) => !phases.includes(phase));
  const preview = !phases.length
    ? "@invisible(Lifecycle)"
    : v.removeVisibility && removed.length
      ? `@removeVisibility(${removed.map((p) => `Lifecycle.${p}`).join(", ")})`
      : `@visibility(${phases.map((p) => `Lifecycle.${p}`).join(", ")})`;
  return (
    <FieldGroup>
      <FieldDescription>
        Controls when emitters include this field in lifecycle-specific schemas.
        User and role authorization is managed separately.
      </FieldDescription>
      <fieldset className="flex flex-wrap gap-4">
        <legend className="mb-2 text-sm font-medium">
          Include field during
        </legend>
        {LIFECYCLE_PHASES.map((phase) => (
          <label key={phase} className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={phases.includes(phase)}
              onChange={() =>
                set(
                  phases.includes(phase)
                    ? phases.filter((p) => p !== phase)
                    : [...phases, phase],
                )
              }
            />
            {phase}
          </label>
        ))}
      </fieldset>
      <div className="flex flex-wrap gap-2">
        {[
          ["Read only", ["Read"]],
          ["Create and read", ["Create", "Read"]],
          ["Write only", ["Create", "Update"]],
          ["All phases", [...LIFECYCLE_PHASES]],
          ["Invisible", []],
        ].map(([label, selected]) => (
          <Button
            key={String(label)}
            type="button"
            variant="outline"
            size="sm"
            onClick={() => set(selected as Visibility["phases"])}
          >
            {label}
          </Button>
        ))}
      </div>
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">
          Advanced visibility syntax
        </summary>
        <label className="mt-2 flex items-center gap-2 text-sm">
          <Checkbox
            checked={v.removeVisibility ?? false}
            onChange={(e) =>
              onChange({ ...v, removeVisibility: e.target.checked })
            }
          />
          Express omitted phases with removeVisibility
        </label>
      </details>
      <code className="whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs">
        {preview}
      </code>
    </FieldGroup>
  );
}
