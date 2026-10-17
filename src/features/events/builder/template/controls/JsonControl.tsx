"use client";

// src/features/events/builder/template/controls/JsonControl.tsx
// kind "json": a JSON editor (see JsonEditor: CodeMirror, or a textarea until it has loaded). The text is local state: invalid JSON stays
// in the editor with a message and writes nothing until it parses; empty text removes the value. The text is not reformatted after
// the user typed it. A `schema` only adds warnings in the editor: it never decides whether the value is written or whether it is invalid.
// The example payload / headers of a message also get a "Generate from payload" button: it writes an example built from that schema.
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { Result } from "@/types/result";
import {
  generateExampleLabel, GENERATE_EMPTY, GENERATE_FAILED, GENERATE_KEEP, GENERATE_REPLACE, GENERATE_REPLACE_QUESTION, generateUnavailableText,
} from "../../labels";
import { isEmptyValue } from "../value";
import { jsonProblem } from "./editor-text";
import { exampleSource } from "./example-schema";
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

/** The example for `schema`. The generator (and the sampler it wraps) is loaded on the first click, not with the page. */
async function generate(schema: Record<string, unknown>): Promise<Result<unknown>> {
  const { exampleFromSchema } = await import("@/lib/events/example-from-schema");
  return exampleFromSchema(schema);
}

export function JsonControl({ field, id, value, onChange, disabled, required, invalid, describedBy, placeholder, schema, path, context }: ControlProps) {
  const [text, setText] = useState(pretty(value));
  const [seen, setSeen] = useState(value);
  const [confirming, setConfirming] = useState(false);
  const [generateProblem, setGenerateProblem] = useState<string | null>(null);
  const generateRef = useRef<HTMLButtonElement>(null);
  // The value changed from outside: show it, unless the text already stands for it.
  if (!same(seen, value)) {
    setSeen(value);
    const parsed = parse(text);
    if (!parsed.ok || !same(parsed.value, value)) setText(pretty(value));
  }
  const parsed = parse(text);
  const problem = parsed.ok ? null : `Not valid JSON: ${parsed.message}`;
  const validationId = `${id}-validation`;

  // "Generate from payload" belongs to the example payload / headers of a message (the context says whose schemas there are).
  const source = context?.pinSchemas === undefined ? null : exampleSource(path);
  const hintId = `${id}-generate-hint`;

  async function build() {
    setConfirming(false);
    setGenerateProblem(null);
    if (!schema) return;
    let result: Result<unknown>;
    try {
      result = await generate(schema);
    } catch {
      result = { success: false, error: { code: "EXAMPLE_FAILED", message: GENERATE_FAILED } };
    }
    // Nothing to write is not a value to write: `{}` and `null` would clear the field.
    if (result.success && isEmptyValue(result.data)) setGenerateProblem(GENERATE_EMPTY);
    else if (result.success) {
      // The text is set here too: the form only changes it when the stored value changes, and the stored value can already be this very
      // example while the text next to it is broken (the way back from a typo: Generate, Replace).
      setText(pretty(result.data));
      onChange(result.data);
    } else setGenerateProblem(GENERATE_FAILED);
    generateRef.current?.focus();
  }
  function ask() {
    setGenerateProblem(null);
    if (text.trim() === "") void build();
    else setConfirming(true);
  }

  return (
    <>
      <JsonEditor
        id={id} value={text} language="json" ariaLabel={field.label} disabled={disabled} placeholder={placeholder} schema={schema}
        required={required} invalid={invalid || problem !== null}
        describedBy={[describedBy, problem ? validationId : undefined].filter(Boolean).join(" ") || undefined}
        onChange={(next) => {
          setText(next);
          const result = parse(next);
          if (result.ok) onChange(result.value);
        }}
      />
      {problem && <p id={validationId} data-testid={validationId} className="text-body-small text-destructive">{problem}</p>}
      {source !== null && (
        <div className="flex flex-wrap items-center justify-end gap-space-2">
          {!schema && <span id={hintId} data-testid={hintId} className="text-caption text-muted-foreground">{generateUnavailableText(source)}</span>}
          {generateProblem && <span role="status" data-testid={`${id}-generate-error`} className="text-caption text-destructive">{generateProblem}</span>}
          {confirming && (
            <span role="group" aria-label={GENERATE_REPLACE_QUESTION} data-testid={`${id}-generate-confirm`} className="inline-flex items-center gap-space-1 text-body-small">
              <span>{GENERATE_REPLACE_QUESTION}</span>
              <Button type="button" size="xs" variant="outline" data-testid={`${id}-generate-replace`} onClick={() => void build()}>{GENERATE_REPLACE}</Button>
              <Button
                type="button" size="xs" variant="ghost" autoFocus data-testid={`${id}-generate-keep`}
                onClick={() => { setConfirming(false); generateRef.current?.focus(); }}
              >
                {GENERATE_KEEP}
              </Button>
            </span>
          )}
          <Button
            ref={generateRef} type="button" size="xs" variant="outline" data-testid={`${id}-generate`}
            disabled={disabled || !schema} aria-describedby={schema ? undefined : hintId} onClick={ask}
          >
            {generateExampleLabel(source)}
          </Button>
        </div>
      )}
    </>
  );
}
