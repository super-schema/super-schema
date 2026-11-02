"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2, ChevronDown, ChevronRight } from "lucide-react";
import type { VisualEditorProps } from "./types";
import {
  type JsonSchemaField,
  type FieldType,
  JSON_TYPES,
  STRING_FORMATS_2020_12,
  enumIssues,
  serializeJsonSchema,
} from "./serialize";
import { ReferenceTargetPicker } from "./ReferenceTargetPicker";

/** Field-type options for the selector: JSON types + reference. */
const FIELD_TYPES: FieldType[] = [...JSON_TYPES, "reference"];

function newField(): JsonSchemaField {
  return {
    id: crypto.randomUUID(),
    name: "",
    type: "string",
    required: true,
    description: "",
  };
}

// Small helpers for controlled numeric inputs (empty → undefined).
function numVal(v: number | undefined): string {
  return v === undefined || Number.isNaN(v) ? "" : String(v);
}
function parseNum(s: string): number | undefined {
  if (s.trim() === "") return undefined;
  const n = Number(s);
  return Number.isNaN(n) ? undefined : n;
}

const inputCls =
  "bg-muted rounded-lg px-space-2 py-1.5 text-body-small text-foreground outline-none border border-border focus:border-primary";

export function JsonSchemaVisualEditor({
  defaultName = "NewEntity",
  referenceTargets = [],
  onContentChange,
  hydrate,
}: VisualEditorProps) {
  const [title, setTitle] = useState(defaultName);
  const [description, setDescription] = useState("");
  const [fields, setFields] = useState<JsonSchemaField[]>([newField()]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    onContentChange(serializeJsonSchema(title, description, fields));
  }, [title, description, fields, onContentChange]);

  useEffect(() => {
    if (!hydrate || hydrate.state.format !== "json-schema") return;
    setTitle(hydrate.state.title);
    setDescription(hydrate.state.description);
    setFields(hydrate.state.fields.length > 0 ? hydrate.state.fields : [newField()]);
    setExpanded(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- apply only when the nonce changes
  }, [hydrate?.nonce]);

  const update = useCallback((id: string, patch: Partial<JsonSchemaField>) => {
    setFields((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }, []);

  const toggleExpand = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  return (
    <div className="flex flex-col gap-space-4" data-testid="jsonschema-visual-editor">
      {/* Schema-level title + description */}
      <div className="flex flex-col gap-space-2">
        <div>
          <label className="text-caption text-muted-foreground block mb-1">Schema title</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className={`${inputCls} w-full`}
          />
        </div>
        <div>
          <label className="text-caption text-muted-foreground block mb-1">
            Description <span className="opacity-60">(optional)</span>
          </label>
          <input
            type="text"
            value={description}
            placeholder="What this schema represents"
            onChange={(e) => setDescription(e.target.value)}
            className={`${inputCls} w-full`}
          />
        </div>
      </div>

      {/* Fields */}
      <div className="flex flex-col gap-space-2">
        <span className="text-caption text-muted-foreground uppercase tracking-wider">
          Properties
        </span>

        {fields.map((field) => {
          const isOpen = expanded.has(field.id);
          const enumLeftOut = field.type === "reference" ? [] : enumIssues(field);
          return (
            <div
              key={field.id}
              className="rounded-lg border border-border p-space-2 flex flex-col gap-space-2"
            >
              {/* Row 1: name · type · required · expand · delete */}
              <div className="flex items-center gap-space-2">
                <button
                  onClick={() => toggleExpand(field.id)}
                  disabled={field.type === "reference"}
                  className="p-0.5 rounded hover:bg-accent text-muted-foreground disabled:opacity-30"
                  title="Advanced options"
                >
                  {isOpen ? (
                    <ChevronDown className="w-4 h-4" />
                  ) : (
                    <ChevronRight className="w-4 h-4" />
                  )}
                </button>
                <input
                  type="text"
                  value={field.name}
                  placeholder="propertyName"
                  onChange={(e) => update(field.id, { name: e.target.value })}
                  className={`${inputCls} flex-1 text-mono-small`}
                />
                <select
                  value={field.type}
                  onChange={(e) => {
                    // enum, const and default were written for the type the field had: a new type starts without them.
                    update(field.id, {
                      type: e.target.value as FieldType,
                      enumValues: undefined,
                      constValue: undefined,
                      defaultValue: undefined,
                    });
                  }}
                  className={inputCls}
                >
                  {FIELD_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <label className="flex items-center gap-1 text-caption text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={field.required}
                    onChange={(e) => update(field.id, { required: e.target.checked })}
                    className="accent-primary"
                  />
                  required
                </label>
                <button
                  onClick={() =>
                    setFields((prev) => prev.filter((f) => f.id !== field.id))
                  }
                  className="p-1 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive"
                  title="Remove property"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Row 2: description on its own line */}
              <input
                type="text"
                value={field.description}
                placeholder="description (optional)"
                onChange={(e) => update(field.id, { description: e.target.value })}
                className={`${inputCls} w-full`}
              />

              {/* Enum symbols the type does not take are left out of the schema: shown on the row, not only under Advanced options */}
              {enumLeftOut.length > 0 && (
                <p className="text-caption text-destructive">
                  Left out of the schema (not valid for {field.type}): {enumLeftOut.join(", ")}
                  {enumLeftOut.length === (field.enumValues ?? []).length && ". No enum value fits, so the property has no enum"}
                </p>
              )}

              {/* Reference target (type === reference) */}
              {field.type === "reference" && (
                <ReferenceTargetPicker
                  label="references entity"
                  value={field.refTarget ?? ""}
                  targets={referenceTargets}
                  onChange={(refTarget) => update(field.id, { refTarget })}
                />
              )}

              {/* Advanced (2020-12) */}
              {isOpen && field.type !== "reference" && (
                <div className="flex flex-col gap-space-2 border-t border-border/60 pt-space-2 mt-1">
                  <AdvancedFields
                    field={field}
                    update={update}
                    referenceTargets={referenceTargets}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      <button
        onClick={() => setFields((prev) => [...prev, newField()])}
        className="flex items-center gap-space-1 self-start px-space-3 py-1.5 rounded-lg text-body-small bg-muted hover:bg-accent text-foreground"
      >
        <Plus className="w-4 h-4" />
        Add Property
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Type-aware advanced keyword editor (JSON Schema 2020-12)
// ---------------------------------------------------------------------------

function AdvancedFields({
  field,
  update,
  referenceTargets,
}: {
  field: JsonSchemaField;
  update: (id: string, patch: Partial<JsonSchemaField>) => void;
  referenceTargets: { id?: string; name: string }[];
}) {
  const set = (patch: Partial<JsonSchemaField>) => update(field.id, patch);

  return (
    <div className="grid grid-cols-2 gap-space-2 text-caption">
      {/* String keywords */}
      {field.type === "string" && (
        <>
          <Labeled label="format">
            <select
              value={field.format ?? ""}
              onChange={(e) => set({ format: e.target.value || undefined })}
              className={`${inputCls} w-full`}
            >
              {STRING_FORMATS_2020_12.map((f) => (
                <option key={f} value={f}>
                  {f === "" ? "(none)" : f}
                </option>
              ))}
            </select>
          </Labeled>
          <Labeled label="pattern (regex)">
            <input
              className={`${inputCls} w-full`}
              value={field.pattern ?? ""}
              onChange={(e) => set({ pattern: e.target.value || undefined })}
            />
          </Labeled>
          <Labeled label="minLength">
            <input
              type="number"
              className={`${inputCls} w-full`}
              value={numVal(field.minLength)}
              onChange={(e) => set({ minLength: parseNum(e.target.value) })}
            />
          </Labeled>
          <Labeled label="maxLength">
            <input
              type="number"
              className={`${inputCls} w-full`}
              value={numVal(field.maxLength)}
              onChange={(e) => set({ maxLength: parseNum(e.target.value) })}
            />
          </Labeled>
        </>
      )}

      {/* Number / integer keywords */}
      {(field.type === "number" || field.type === "integer") && (
        <>
          <Labeled label="minimum">
            <input
              type="number"
              className={`${inputCls} w-full`}
              value={numVal(field.minimum)}
              onChange={(e) => set({ minimum: parseNum(e.target.value) })}
            />
          </Labeled>
          <Labeled label="maximum">
            <input
              type="number"
              className={`${inputCls} w-full`}
              value={numVal(field.maximum)}
              onChange={(e) => set({ maximum: parseNum(e.target.value) })}
            />
          </Labeled>
          <Labeled label="exclusiveMinimum">
            <input
              type="number"
              className={`${inputCls} w-full`}
              value={numVal(field.exclusiveMinimum)}
              onChange={(e) => set({ exclusiveMinimum: parseNum(e.target.value) })}
            />
          </Labeled>
          <Labeled label="exclusiveMaximum">
            <input
              type="number"
              className={`${inputCls} w-full`}
              value={numVal(field.exclusiveMaximum)}
              onChange={(e) => set({ exclusiveMaximum: parseNum(e.target.value) })}
            />
          </Labeled>
          <Labeled label="multipleOf">
            <input
              type="number"
              className={`${inputCls} w-full`}
              value={numVal(field.multipleOf)}
              onChange={(e) => set({ multipleOf: parseNum(e.target.value) })}
            />
          </Labeled>
        </>
      )}

      {/* Array keywords */}
      {field.type === "array" && (
        <>
          <Labeled label="items type">
            <select
              value={field.itemsType ?? "string"}
              onChange={(e) => set({ itemsType: e.target.value as FieldType })}
              className={`${inputCls} w-full`}
            >
              {FIELD_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </Labeled>
          {field.itemsType === "reference" && (
            <div className="col-span-2">
              <ReferenceTargetPicker
                label="items reference entity"
                value={field.itemsRefTarget ?? ""}
                targets={referenceTargets}
                onChange={(itemsRefTarget) => set({ itemsRefTarget })}
              />
            </div>
          )}
          <Labeled label="uniqueItems">
            <input
              type="checkbox"
              checked={field.uniqueItems ?? false}
              onChange={(e) => set({ uniqueItems: e.target.checked || undefined })}
              className="accent-primary"
            />
          </Labeled>
          <Labeled label="minItems">
            <input
              type="number"
              className={`${inputCls} w-full`}
              value={numVal(field.minItems)}
              onChange={(e) => set({ minItems: parseNum(e.target.value) })}
            />
          </Labeled>
          <Labeled label="maxItems">
            <input
              type="number"
              className={`${inputCls} w-full`}
              value={numVal(field.maxItems)}
              onChange={(e) => set({ maxItems: parseNum(e.target.value) })}
            />
          </Labeled>
        </>
      )}

      {/* Common value keywords */}
      <Labeled label="enum (comma-separated)">
        <input
          className={`${inputCls} w-full`}
          value={(field.enumValues ?? []).join(", ")}
          onChange={(e) =>
            set({
              enumValues: e.target.value.trim()
                ? e.target.value.split(",").map((v) => v.trim()).filter(Boolean)
                : undefined,
            })
          }
        />
      </Labeled>
      <Labeled label="default">
        <input
          className={`${inputCls} w-full`}
          value={field.defaultValue ?? ""}
          onChange={(e) => set({ defaultValue: e.target.value || undefined })}
        />
      </Labeled>
      <Labeled label="const">
        <input
          className={`${inputCls} w-full`}
          value={field.constValue ?? ""}
          onChange={(e) => set({ constValue: e.target.value || undefined })}
        />
      </Labeled>
      <div className="flex items-center gap-space-3 col-span-2">
        <label className="flex items-center gap-1 text-muted-foreground">
          <input
            type="checkbox"
            checked={field.deprecated ?? false}
            onChange={(e) => set({ deprecated: e.target.checked || undefined })}
            className="accent-primary"
          />
          deprecated
        </label>
        <label className="flex items-center gap-1 text-muted-foreground">
          <input
            type="checkbox"
            checked={field.readOnly ?? false}
            onChange={(e) => set({ readOnly: e.target.checked || undefined })}
            className="accent-primary"
          />
          readOnly
        </label>
        <label className="flex items-center gap-1 text-muted-foreground">
          <input
            type="checkbox"
            checked={field.writeOnly ?? false}
            onChange={(e) => set({ writeOnly: e.target.checked || undefined })}
            className="accent-primary"
          />
          writeOnly
        </label>
      </div>
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-0.5 text-muted-foreground">
      <span>{label}</span>
      {children}
    </label>
  );
}

