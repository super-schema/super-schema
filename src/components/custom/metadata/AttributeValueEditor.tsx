"use client";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { AttributeControl, SELECT_CLASS } from "@/components/custom/FieldAttributes/AttributeControl";
import { validateValue, type ValueProblem, type ValueSchema } from "@/lib/metadata-attributes/value-schema";

export const DERIVED_NOTE = "Follows the field's classification";

interface Props {
  schema: ValueSchema;
  value: unknown;
  /** Object members the dictionary derives (the keys of `definition.derive`); shown read-only. */
  derivedKeys?: string[];
  onChange: (value: unknown) => void;
  /** Label of the control for a non-object schema (an object's properties are labelled by their names). */
  label?: string;
  disabled?: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A form driven by a value schema: text / number / checkbox / select (enum) / tag list (string[]) / one row per property (object).
 * Validation problems from `validateValue` are shown inline as warnings; they never stop an edit from being emitted.
 */
export function AttributeValueEditor({ schema, value, derivedKeys = [], onChange, label, disabled }: Props) {
  const problems = value === undefined ? [] : validateValue(value, schema);
  return <Node schema={schema} value={value} derivedKeys={derivedKeys} onChange={onChange} label={label} disabled={disabled} path="" problems={problems} />;
}

function problemsAt(problems: ValueProblem[], path: string): string | undefined {
  const here = problems.filter((p) => p.path === path).map((p) => p.message);
  return here.length ? here.join("; ") : undefined;
}

function escapePtr(s: string) {
  return s.replace(/~/g, "~0").replace(/\//g, "~1");
}

interface NodeProps extends Props {
  path: string;
  problems: ValueProblem[];
}

function Node({ schema, value, derivedKeys = [], onChange, label = "Value", disabled, path, problems }: NodeProps) {
  const error = problemsAt(problems, path);

  if (schema.type === "object" && schema.properties) {
    const current = isObj(value) ? value : {};
    return (
      <div className="flex min-w-0 flex-col gap-3">
        {Object.entries(schema.properties).map(([name, sub]) => {
          const childPath = `${path}/${escapePtr(name)}`;
          if (derivedKeys.includes(name)) {
            const v = current[name];
            return (
              <AttributeControl key={name} label={name} help={DERIVED_NOTE}>
                <Input readOnly value={v === undefined || v === null ? "" : String(v)} placeholder="Derived on save" />
              </AttributeControl>
            );
          }
          return (
            <Node
              key={name}
              schema={sub}
              value={current[name]}
              label={name}
              disabled={disabled}
              path={childPath}
              problems={problems}
              onChange={(next) => {
                const copy = { ...current };
                if (next === undefined) delete copy[name];
                else copy[name] = next;
                onChange(copy);
              }}
            />
          );
        })}
        {error && <FieldError>{error}</FieldError>}
      </div>
    );
  }

  if (schema.enum && schema.enum.length > 0) {
    const options = schema.enum;
    const selected = options.find((o) => o === value);
    return (
      <AttributeControl label={label} error={error}>
        <select
          className={SELECT_CLASS}
          disabled={disabled}
          value={selected === undefined ? "" : String(selected)}
          onChange={(e) => onChange(e.target.value === "" ? undefined : options.find((o) => String(o) === e.target.value))}
        >
          <option value="" disabled hidden>
            Select…
          </option>
          {options.map((o) => (
            <option key={String(o)} value={String(o)}>
              {String(o)}
            </option>
          ))}
        </select>
      </AttributeControl>
    );
  }

  if (schema.type === "boolean") {
    return (
      <AttributeControl label={label} error={error}>
        <input type="checkbox" disabled={disabled} checked={value === true} onChange={(e) => onChange(e.target.checked)} />
      </AttributeControl>
    );
  }

  if (schema.type === "number" || schema.type === "integer") {
    return (
      <NumberControl
        label={label}
        error={error}
        disabled={disabled}
        integer={schema.type === "integer"}
        value={value}
        // A top-level value is never un-set by clearing the box (only the Remove button deletes the attribute); a property is.
        onChange={(n) => {
          if (n !== undefined || path !== "") onChange(n);
        }}
      />
    );
  }

  if (schema.type === "string") {
    return (
      <AttributeControl label={label} error={error}>
        <Input
          disabled={disabled}
          spellCheck={false}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.target.value === "" && path !== "" ? undefined : e.target.value)}
        />
      </AttributeControl>
    );
  }

  if (schema.type === "array" && schema.items?.type === "string" && !schema.items.enum) {
    return <TagList label={label} value={Array.isArray(value) ? value.map(String) : []} error={error} disabled={disabled} onChange={onChange} />;
  }

  return <JsonValue label={label} value={value} error={error} disabled={disabled} onChange={onChange} />;
}

/**
 * A number box that keeps what is typed: a half-typed number ("-", "1e") reports "" from the browser and is not a value yet, so it emits nothing
 * and the last number stands; a cleared box emits `undefined` (the caller decides what that means).
 */
function NumberControl({ label, error, disabled, integer, value, onChange }: { label: string; error?: string; disabled?: boolean; integer: boolean; value: unknown; onChange: (n: number | undefined) => void }) {
  const [text, setText] = useState(typeof value === "number" && Number.isFinite(value) ? String(value) : "");
  const current = typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const [emitted, setEmitted] = useState<number | undefined>(current);
  // An outside change of the number (not one this box emitted) wins over the typed text.
  const shown = current !== emitted && current !== undefined ? String(current) : text;
  return (
    <AttributeControl label={label} error={error}>
      <Input
        type="number"
        disabled={disabled}
        step={integer ? 1 : "any"}
        value={shown}
        onChange={(e) => {
          setText(e.target.value);
          if (e.target.value === "") {
            onChange(undefined);
            return;
          }
          const n = Number(e.target.value);
          if (Number.isFinite(n)) {
            setEmitted(n);
            onChange(n);
          }
        }}
      />
    </AttributeControl>
  );
}

/** What a freshly picked attribute starts as, so its editor has something to show. */
export function initialAttributeValue(def: { valueSchema: ValueSchema }): unknown {
  switch (def.valueSchema.type) {
    case "object":
      return {};
    case "array":
      return [];
    case "boolean":
      return false;
    case "string":
      return "";
    default:
      return def.valueSchema.minimum ?? 0;
  }
}

function TagList({ label, value, error, disabled, onChange }: { label: string; value: string[]; error?: string; disabled?: boolean; onChange: (v: unknown) => void }) {
  const [draft, setDraft] = useState("");
  function add() {
    const t = draft.trim();
    if (!t) return;
    onChange([...value, t]);
    setDraft("");
  }
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span className="text-sm font-medium text-foreground">{label}</span>
      <div className="flex flex-wrap gap-1">
        {value.map((tag, i) => (
          <span key={`${tag}-${i}`} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs">
            {tag}
            <button type="button" disabled={disabled} aria-label={`Remove ${tag}`} onClick={() => onChange(value.filter((_, j) => j !== i))}>
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <AttributeControl label="New value">
          <Input
            disabled={disabled}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
          />
        </AttributeControl>
        <Button type="button" size="sm" variant="outline" disabled={disabled || !draft.trim()} onClick={add}>
          Add value
        </Button>
      </div>
      {error && <FieldError>{error}</FieldError>}
    </div>
  );
}

/** Fallback for shapes with no dedicated control (arrays of non-strings, objects without declared properties): raw JSON. */
function JsonValue({ label, value, error, disabled, onChange }: { label: string; value: unknown; error?: string; disabled?: boolean; onChange: (v: unknown) => void }) {
  const [text, setText] = useState(value === undefined ? "" : JSON.stringify(value));
  const [parseError, setParseError] = useState<string | undefined>();
  return (
    <AttributeControl label={label} error={parseError ?? error}>
      <Textarea
        disabled={disabled}
        rows={3}
        spellCheck={false}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (e.target.value.trim() === "") {
            setParseError(undefined);
            onChange(undefined);
            return;
          }
          try {
            onChange(JSON.parse(e.target.value));
            setParseError(undefined);
          } catch {
            setParseError("Enter valid JSON.");
          }
        }}
      />
    </AttributeControl>
  );
}
