"use client";

// src/features/events/builder/template/controls/JsonControl.tsx
// kind "json": a JSON editor (see JsonEditor: CodeMirror, or a textarea until it has loaded). The text is local state: invalid JSON stays
// in the editor with a message and writes nothing until it parses; empty text removes the value. The text is not reformatted after
// the user typed it.
import { useState } from "react";
import { isEmptyValue } from "../value";
import { jsonProblem } from "./editor-text";
import { JsonEditor } from "./JsonEditor";
import type { ControlProps } from "./types";

type Parsed = { ok: true; value: unknown } | { ok: false; message: string };

function parse(text: string): Parsed {
  if (text.trim() === "") return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, message: jsonProblem(text)?.message ?? "Invalid JSON" };
  }
}

const pretty = (v: unknown) => (v === undefined ? "" : JSON.stringify(v, null, 2));
/** Two values are the same for the form when their JSON is, with nothing and `{}` / `[]` counting as one. */
const same = (a: unknown, b: unknown) => (isEmptyValue(a) && isEmptyValue(b)) || JSON.stringify(a) === JSON.stringify(b);

export function JsonControl({ field, id, value, onChange, disabled, required, invalid, describedBy, placeholder }: ControlProps) {
  const [text, setText] = useState(pretty(value));
  const [seen, setSeen] = useState(value);
  // The value changed from outside: show it, unless the text already stands for it.
  if (!same(seen, value)) {
    setSeen(value);
    const parsed = parse(text);
    if (!parsed.ok || !same(parsed.value, value)) setText(pretty(value));
  }
  const parsed = parse(text);
  const problem = parsed.ok ? null : `Not valid JSON: ${parsed.message}`;
  const validationId = `${id}-validation`;
  return (
    <>
      <JsonEditor
        id={id} value={text} language="json" ariaLabel={field.label} disabled={disabled} placeholder={placeholder}
        required={required} invalid={invalid || problem !== null}
        describedBy={[describedBy, problem ? validationId : undefined].filter(Boolean).join(" ") || undefined}
        onChange={(next) => {
          setText(next);
          const result = parse(next);
          if (result.ok) onChange(result.value);
        }}
      />
      {problem && <p id={validationId} data-testid={validationId} className="text-body-small text-destructive">{problem}</p>}
    </>
  );
}
