"use client";

// src/features/events/builder/template/controls/IntegerControl.tsx
// kind "integer": the text is local state so a half-typed or invalid entry stays on screen. Only a whole number (or nothing) is
// written; anything else shows a message and writes nothing, so NaN never reaches the document.
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { INTEGER_PROBLEM, parseInteger } from "./validate";
import type { ControlProps } from "./types";

const show = (n: number | undefined) => (n === undefined ? "" : String(n));

export function IntegerControl({ id, value, onChange, disabled, required, invalid, describedBy, placeholder }: ControlProps) {
  const external = typeof value === "number" ? value : undefined;
  const [text, setText] = useState(show(external));
  const [seen, setSeen] = useState(external);
  // The value changed from outside: show it, unless the text already stands for it.
  if (external !== seen) {
    setSeen(external);
    if (parseInteger(text) !== external) setText(show(external));
  }
  const problem = text.trim() !== "" && parseInteger(text) === null ? INTEGER_PROBLEM : null;
  const validationId = `${id}-validation`;
  return (
    <>
      <Input
        id={id} data-testid={id} value={text} disabled={disabled} placeholder={placeholder} inputMode="numeric" autoComplete="off"
        aria-required={required || undefined} aria-invalid={invalid || problem ? true : undefined}
        aria-describedby={[describedBy, problem ? validationId : undefined].filter(Boolean).join(" ") || undefined}
        onChange={(e) => {
          const next = e.target.value;
          setText(next);
          const parsed = parseInteger(next);
          if (parsed !== null) onChange(parsed);
        }}
      />
      {problem && <p id={validationId} data-testid={validationId} className="text-body-small text-destructive">{problem}</p>}
    </>
  );
}
