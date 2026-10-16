"use client";

// src/features/events/builder/template/controls/BooleanControl.tsx
// kind "boolean": a three-way select (Not set / Yes / No). A boolean is omitted from the output until the user sets it, and false is a
// value (it can differ from the spec's default), so a plain checkbox cannot say "not set".
import { selectClass } from "../../controls";
import type { ControlProps } from "./types";

const words = (v: string | number | boolean) => (v === true ? "yes" : v === false ? "no" : String(v));

export function BooleanControl({ field, id, value, onChange, disabled, required, invalid, describedBy }: ControlProps) {
  const current = typeof value === "boolean" ? String(value) : "";
  const unset = field.default !== undefined ? `Not set (default: ${words(field.default)})` : "Not set";
  return (
    <select
      id={id} data-testid={id} className={selectClass} value={current} disabled={disabled}
      aria-required={required || undefined} aria-invalid={invalid ? true : undefined} aria-describedby={describedBy}
      onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value === "true")}
    >
      <option value="">{unset}</option>
      <option value="true">Yes</option>
      <option value="false">No</option>
    </select>
  );
}
