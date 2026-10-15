"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2, ChevronDown, ChevronRight } from "lucide-react";
import type { VisualEditorProps } from "./types";
import {
  type AvroField,
  type AvroFieldType,
  AVRO_FIELD_TYPES,
  AVRO_ELEMENT_TYPES,
  AVRO_ORDERS,
  serializeAvroSchema,
} from "./avro-serialize";
import { ReferenceTargetPicker } from "./ReferenceTargetPicker";

function newField(): AvroField {
  return {
    id: crypto.randomUUID(),
    name: "",
    type: "string",
    nullable: false,
    doc: "",
  };
}

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

export function AvroVisualEditor({
  defaultName = "NewEntity",
  referenceTargets = [],
  onContentChange,
  hydrate,
}: VisualEditorProps) {
  const [name, setName] = useState(defaultName);
  const [namespace, setNamespace] = useState("");
  const [doc, setDoc] = useState("");
  const [fields, setFields] = useState<AvroField[]>([newField()]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    onContentChange(serializeAvroSchema(name, namespace, doc, fields));
  }, [name, namespace, doc, fields, onContentChange]);

  useEffect(() => {
    if (!hydrate || hydrate.state.format !== "avro") return;
    setName(hydrate.state.name);
    setNamespace(hydrate.state.namespace);
    setDoc(hydrate.state.doc);
    setFields(hydrate.state.fields.length > 0 ? hydrate.state.fields : [newField()]);
    setExpanded(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- apply only when the nonce changes
  }, [hydrate?.nonce]);

  const update = useCallback((id: string, patch: Partial<AvroField>) => {
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
    <div className="flex flex-col gap-space-4" data-testid="avro-visual-editor">
      {/* Record-level name + namespace + doc */}
      <div className="flex flex-col gap-space-2">
        <div className="grid grid-cols-2 gap-space-2">
          <div>
            <label className="text-caption text-muted-foreground block mb-1">Record name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={`${inputCls} w-full`}
            />
          </div>
          <div>
            <label className="text-caption text-muted-foreground block mb-1">
              Namespace <span className="opacity-60">(optional)</span>
            </label>
            <input
              type="text"
              value={namespace}
              placeholder="com.example"
              onChange={(e) => setNamespace(e.target.value)}
              className={`${inputCls} w-full`}
            />
          </div>
        </div>
        <div>
          <label className="text-caption text-muted-foreground block mb-1">
            Doc <span className="opacity-60">(optional)</span>
          </label>
          <input
            type="text"
            value={doc}
            placeholder="What this record represents"
            onChange={(e) => setDoc(e.target.value)}
            className={`${inputCls} w-full`}
          />
        </div>
      </div>

      {/* Fields */}
      <div className="flex flex-col gap-space-2">
        <span className="text-caption text-muted-foreground uppercase tracking-wider">
          Fields
        </span>

        {fields.map((field) => {
          const isOpen = expanded.has(field.id);
          return (
            <div
              key={field.id}
              className="rounded-lg border border-border p-space-2 flex flex-col gap-space-2"
            >
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
                  placeholder="fieldName"
                  onChange={(e) => update(field.id, { name: e.target.value })}
                  className={`${inputCls} flex-1 text-mono-small`}
                />
                <select
                  value={field.type}
                  onChange={(e) => update(field.id, { type: e.target.value as AvroFieldType })}
                  className={inputCls}
                >
                  {AVRO_FIELD_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <label className="flex items-center gap-1 text-caption text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={field.nullable}
                    onChange={(e) => update(field.id, { nullable: e.target.checked })}
                    className="accent-primary"
                  />
                  nullable
                </label>
                <button
                  onClick={() => setFields((prev) => prev.filter((f) => f.id !== field.id))}
                  className="p-1 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive"
                  title="Remove field"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>

              <input
                type="text"
                value={field.doc}
                placeholder="doc (optional)"
                onChange={(e) => update(field.id, { doc: e.target.value })}
                className={`${inputCls} w-full`}
              />

              {field.type === "reference" && (
                <ReferenceTargetPicker
                  label="references entity"
                  value={field.refTarget ?? ""}
                  targets={referenceTargets}
                  onChange={(refTarget) => update(field.id, { refTarget })}
                />
              )}

              {isOpen && field.type !== "reference" && (
                <div className="flex flex-col gap-space-2 border-t border-border/60 pt-space-2 mt-1">
                  <AdvancedFields field={field} update={update} referenceTargets={referenceTargets} />
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
        Add Field
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Type-aware advanced keyword editor
// ---------------------------------------------------------------------------

function AdvancedFields({
  field,
  update,
  referenceTargets,
}: {
  field: AvroField;
  update: (id: string, patch: Partial<AvroField>) => void;
  referenceTargets: { id?: string; name: string }[];
}) {
  const set = (patch: Partial<AvroField>) => update(field.id, patch);

  return (
    <div className="grid grid-cols-2 gap-space-2 text-caption">
      {/* decimal */}
      {field.type === "decimal" && (
        <>
          <Labeled label="precision">
            <input
              type="number"
              className={`${inputCls} w-full`}
              value={numVal(field.precision)}
              onChange={(e) => set({ precision: parseNum(e.target.value) })}
            />
          </Labeled>
          <Labeled label="scale">
            <input
              type="number"
              className={`${inputCls} w-full`}
              value={numVal(field.scale)}
              onChange={(e) => set({ scale: parseNum(e.target.value) })}
            />
          </Labeled>
        </>
      )}

      {/* fixed / duration */}
      {(field.type === "fixed" || field.type === "duration") && (
        <>
          <Labeled label="fixed type name">
            <input
              className={`${inputCls} w-full`}
              value={field.fixedName ?? ""}
              onChange={(e) => set({ fixedName: e.target.value || undefined })}
            />
          </Labeled>
          {field.type === "fixed" ? (
            <Labeled label="size (bytes)">
              <input
                type="number"
                className={`${inputCls} w-full`}
                value={numVal(field.fixedSize)}
                onChange={(e) => set({ fixedSize: parseNum(e.target.value) })}
              />
            </Labeled>
          ) : (
            <Labeled label="size (bytes)">
              <input className={`${inputCls} w-full opacity-60`} value="12 (fixed by spec)" disabled />
            </Labeled>
          )}
        </>
      )}

      {/* enum */}
      {field.type === "enum" && (
        <>
          <Labeled label="enum type name">
            <input
              className={`${inputCls} w-full`}
              value={field.enumName ?? ""}
              onChange={(e) => set({ enumName: e.target.value || undefined })}
            />
          </Labeled>
          <Labeled label="symbols (comma-separated)">
            <input
              className={`${inputCls} w-full`}
              value={(field.symbols ?? []).join(", ")}
              onChange={(e) =>
                set({
                  symbols: e.target.value.trim()
                    ? e.target.value.split(",").map((v) => v.trim()).filter(Boolean)
                    : undefined,
                })
              }
            />
          </Labeled>
        </>
      )}

      {/* array */}
      {field.type === "array" && (
        <>
          <Labeled label="items type">
            <select
              value={field.itemsType ?? "string"}
              onChange={(e) => set({ itemsType: e.target.value as AvroFieldType })}
              className={`${inputCls} w-full`}
            >
              {AVRO_ELEMENT_TYPES.map((t) => (
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
        </>
      )}

      {/* map */}
      {field.type === "map" && (
        <>
          <Labeled label="values type">
            <select
              value={field.valuesType ?? "string"}
              onChange={(e) => set({ valuesType: e.target.value as AvroFieldType })}
              className={`${inputCls} w-full`}
            >
              {AVRO_ELEMENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </Labeled>
          {field.valuesType === "reference" && (
            <div className="col-span-2">
              <ReferenceTargetPicker
                label="values reference entity"
                value={field.valuesRefTarget ?? ""}
                targets={referenceTargets}
                onChange={(valuesRefTarget) => set({ valuesRefTarget })}
              />
            </div>
          )}
        </>
      )}

      {/* common — every type */}
      <Labeled label="aliases (comma-separated)">
        <input
          className={`${inputCls} w-full`}
          value={(field.aliases ?? []).join(", ")}
          onChange={(e) =>
            set({
              aliases: e.target.value.trim()
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
      <Labeled label="order">
        <select
          value={field.order ?? ""}
          onChange={(e) => set({ order: (e.target.value || undefined) as AvroField["order"] })}
          className={`${inputCls} w-full`}
        >
          <option value="">(default)</option>
          {AVRO_ORDERS.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </Labeled>
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
