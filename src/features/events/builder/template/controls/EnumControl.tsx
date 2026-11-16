"use client";

// src/features/events/builder/template/controls/EnumControl.tsx
// kind "enum": a native select with an empty choice. The selected option's help is shown under the select; a value that is not
// among the options (a newer spec, a hand-edited document) stays visible and flagged so it can be changed.
import type { ControlProps } from "./types";

import { NativeSelect } from "@/components/ui/native-select";
export function EnumControl({ field, id, value, onChange, disabled, required, invalid, describedBy }: ControlProps) {
  const options = field.options ?? [];
  const current = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
  const selected = options.find((o) => o.value === current);
  const stray = current !== "" && !selected;
  return (
    <>
      <NativeSelect
        id={id} data-testid={id} value={current} disabled={disabled}
        aria-required={required || undefined} aria-invalid={invalid ? true : undefined} aria-describedby={describedBy}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{required ? "Select…" : "— none —"}</option>
        {options.map((o) => <option key={o.value} value={o.value} title={o.help}>{o.label}</option>)}
        {stray && <option value={current}>{`${current} (not in the list)`}</option>}
      </NativeSelect>
      {selected?.help && <p id={`${id}-option-help`} data-testid={`${id}-option-help`} className="text-caption text-muted-foreground">{selected.help}</p>}
    </>
  );
}
