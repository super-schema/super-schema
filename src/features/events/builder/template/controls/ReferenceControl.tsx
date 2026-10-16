"use client";

// src/features/events/builder/template/controls/ReferenceControl.tsx
// kind "reference": a select (one) or a checkbox list (`multiple`) over `context.references[field.refersTo]`. The value is the chosen
// option's `value` (a string, or an array of strings). A value that is no longer offered stays visible and is flagged "unavailable",
// so the user can see it and remove it.
import { selectClass } from "../../controls";
import type { ControlProps } from "./types";

const NOUNS: Record<string, string> = {
  server: "servers", channel: "channels", message: "messages", securityScheme: "security schemes",
  messageTrait: "message properties", operationTrait: "operation properties",
};

export function ReferenceControl({ field, id, value, onChange, disabled, required, invalid, describedBy, context }: ControlProps) {
  const target = field.refersTo ?? "";
  const options = context?.references?.[target] ?? [];
  const noun = NOUNS[target] ?? "options";
  const empty = options.length === 0 ? <p id={`${id}-empty`} data-testid={`${id}-empty`} className="text-body-small text-muted-foreground">{`No ${noun} are defined yet.`}</p> : null;

  if (field.multiple) {
    const current = Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
    const stray = current.filter((v, i) => current.indexOf(v) === i && !options.some((o) => o.value === v));
    const all = [...options.map((o) => ({ ...o, unavailable: false })), ...stray.map((v) => ({ value: v, label: `${v} (unavailable)`, hint: undefined, unavailable: true }))];
    return (
      <>
        {empty}
        {all.length > 0 && (
          <ul className="space-y-space-1">
            {all.map((o) => (
              <li key={o.value}>
                <label className="flex items-center gap-space-2 text-body-small text-foreground" title={o.hint}>
                  <input
                    type="checkbox" data-testid={`${id}-option-${o.value}`} className="size-4 shrink-0 accent-primary" disabled={disabled}
                    checked={current.includes(o.value)}
                    onChange={(e) => onChange(e.target.checked ? [...current, o.value] : current.filter((v) => v !== o.value))}
                  />
                  <span>{o.label}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
        {stray.length > 0 && (
          <p id={`${id}-unavailable`} data-testid={`${id}-unavailable`} className="text-caption text-warning">
            {`No longer available: ${stray.join(", ")}. Untick to remove.`}
          </p>
        )}
      </>
    );
  }

  const current = typeof value === "string" ? value : "";
  const unavailable = current !== "" && !options.some((o) => o.value === current);
  return (
    <>
      <select
        id={id} data-testid={id} className={selectClass} value={current} disabled={disabled}
        aria-required={required || undefined} aria-invalid={invalid ? true : undefined} aria-describedby={describedBy}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{required ? "Select…" : "— none —"}</option>
        {options.map((o) => <option key={o.value} value={o.value} title={o.hint}>{o.label}</option>)}
        {unavailable && <option value={current}>{`${current} (unavailable)`}</option>}
      </select>
      {empty}
      {unavailable && (
        <p id={`${id}-unavailable`} data-testid={`${id}-unavailable`} className="text-caption text-warning">
          {`"${current}" is no longer available. Choose another, or clear it.`}
        </p>
      )}
    </>
  );
}
