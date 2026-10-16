"use client";

// src/features/events/builder/template/controls/TextControl.tsx
// kind "text" | "url" | "email": a single-line input. The value is written as typed; url and email show a validation message once
// the user has left the field (and keep it live after that). `suggestions` become a datalist, so free text stays possible.
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { emailProblem, urlProblem } from "./validate";
import type { ControlProps } from "./types";

export function TextControl({ field, id, value, onChange, disabled, required, invalid, describedBy, placeholder }: ControlProps) {
  const text = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
  const [touched, setTouched] = useState(false);
  const problem = !touched ? null : field.kind === "url" ? urlProblem(text) : field.kind === "email" ? emailProblem(text) : null;
  const validationId = `${id}-validation`;
  const listId = field.suggestions?.length ? `${id}-options` : undefined;
  const typed = field.kind === "url" || field.kind === "email";
  return (
    <>
      <Input
        id={id} data-testid={id} value={text} disabled={disabled} placeholder={placeholder} list={listId}
        type={field.kind === "email" ? "email" : "text"} inputMode={field.kind === "url" ? "url" : undefined}
        autoComplete="off" spellCheck={typed || listId ? false : undefined}
        aria-required={required || undefined} aria-invalid={invalid || problem ? true : undefined}
        aria-describedby={[describedBy, problem ? validationId : undefined].filter(Boolean).join(" ") || undefined}
        onChange={(e) => onChange(e.target.value)} onBlur={() => setTouched(true)}
      />
      {listId && <datalist id={listId}>{field.suggestions!.map((s) => <option key={s} value={s} />)}</datalist>}
      {problem && <p id={validationId} data-testid={validationId} className="text-body-small text-destructive">{problem}</p>}
    </>
  );
}
