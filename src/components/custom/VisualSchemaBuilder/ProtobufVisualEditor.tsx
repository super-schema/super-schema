"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { VisualEditorProps } from "./types";
import {
  type ProtoField,
  type ProtoFieldShape,
  type ProtoFieldType,
  PROTO_FIELD_TYPES,
  PROTO_MAP_KEY_TYPES,
  nextFieldNumber,
  serializeProtobufSchema,
} from "./protobuf-serialize";
import { ReferenceTargetPicker } from "./ReferenceTargetPicker";

const TYPE_OPTIONS: ProtoFieldShape[] = [...PROTO_FIELD_TYPES, "map"];

function newField(existing: ProtoField[]): ProtoField {
  return {
    id: crypto.randomUUID(),
    name: "",
    type: "string",
    fieldNumber: nextFieldNumber(existing),
    repeated: false,
    doc: "",
  };
}

const inputCls =
  "bg-muted rounded-lg px-space-2 py-1.5 text-body-small text-foreground outline-none border border-border focus:border-primary";

export function ProtobufVisualEditor({
  defaultName = "NewEntity",
  referenceTargets = [],
  onContentChange,
}: VisualEditorProps) {
  const [name, setName] = useState(defaultName);
  const [packageName, setPackageName] = useState("");
  const [fields, setFields] = useState<ProtoField[]>([newField([])]);

  useEffect(() => {
    onContentChange(serializeProtobufSchema(name, packageName, fields));
  }, [name, packageName, fields, onContentChange]);

  const update = useCallback((id: string, patch: Partial<ProtoField>) => {
    setFields((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }, []);

  return (
    <div className="flex flex-col gap-space-4" data-testid="protobuf-visual-editor">
      {/* Message-level name + package */}
      <div className="grid grid-cols-2 gap-space-2">
        <div>
          <label className="text-caption text-muted-foreground block mb-1">Message name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={`${inputCls} w-full`}
          />
        </div>
        <div>
          <label className="text-caption text-muted-foreground block mb-1">
            Package <span className="opacity-60">(optional)</span>
          </label>
          <input
            type="text"
            value={packageName}
            placeholder="com.example"
            onChange={(e) => setPackageName(e.target.value)}
            className={`${inputCls} w-full`}
          />
        </div>
      </div>

      {/* Fields */}
      <div className="flex flex-col gap-space-2">
        <span className="text-caption text-muted-foreground uppercase tracking-wider">
          Fields
        </span>

        {fields.map((field) => (
          <div
            key={field.id}
            className="rounded-lg border border-border p-space-2 flex flex-col gap-space-2"
          >
            {/* Row 1: name · type · repeated · field number · delete */}
            <div className="flex items-center gap-space-2">
              <input
                type="text"
                value={field.name}
                placeholder="field_name"
                onChange={(e) => update(field.id, { name: e.target.value })}
                className={`${inputCls} flex-1 text-mono-small`}
              />
              <select
                value={field.type}
                onChange={(e) => update(field.id, { type: e.target.value as ProtoFieldShape })}
                className={inputCls}
              >
                {TYPE_OPTIONS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <label
                className={`flex items-center gap-1 text-caption text-muted-foreground ${
                  field.type === "map" ? "opacity-30" : ""
                }`}
              >
                <input
                  type="checkbox"
                  checked={field.type !== "map" && field.repeated}
                  disabled={field.type === "map"}
                  onChange={(e) => update(field.id, { repeated: e.target.checked })}
                  className="accent-primary"
                />
                repeated
              </label>
              <label className="flex items-center gap-1 text-caption text-muted-foreground">
                =
                <input
                  type="number"
                  min={1}
                  value={field.fieldNumber}
                  onChange={(e) =>
                    update(field.id, { fieldNumber: Math.max(1, parseInt(e.target.value, 10) || 1) })
                  }
                  className={`${inputCls} w-16`}
                  title="Field number (wire-format identity — keep stable once used)"
                />
              </label>
              <button
                onClick={() => setFields((prev) => prev.filter((f) => f.id !== field.id))}
                className="p-1 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive"
                title="Remove field"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Row 2: doc/comment */}
            <input
              type="text"
              value={field.doc}
              placeholder="comment (optional)"
              onChange={(e) => update(field.id, { doc: e.target.value })}
              className={`${inputCls} w-full`}
            />

            {/* Row 3: reference target, or map key/value config */}
            {field.type === "reference" && (
              <ReferenceTargetPicker
                label="references message"
                value={field.refTarget ?? ""}
                targets={referenceTargets}
                onChange={(refTarget) => update(field.id, { refTarget })}
              />
            )}
            {field.type === "map" && (
              <div className="grid grid-cols-2 gap-space-2 text-caption">
                <label className="flex flex-col gap-0.5 text-muted-foreground">
                  <span>key type</span>
                  <select
                    value={field.mapKeyType ?? "string"}
                    onChange={(e) =>
                      update(field.id, { mapKeyType: e.target.value as ProtoFieldType })
                    }
                    className={`${inputCls} w-full`}
                  >
                    {PROTO_MAP_KEY_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-0.5 text-muted-foreground">
                  <span>value type</span>
                  <select
                    value={field.mapValueType ?? "string"}
                    onChange={(e) =>
                      update(field.id, { mapValueType: e.target.value as ProtoFieldType })
                    }
                    className={`${inputCls} w-full`}
                  >
                    {PROTO_FIELD_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </label>
                {field.mapValueType === "reference" && (
                  <div className="col-span-2">
                    <ReferenceTargetPicker
                      label="value references message"
                      value={field.mapValueRefTarget ?? ""}
                      targets={referenceTargets}
                      onChange={(mapValueRefTarget) => update(field.id, { mapValueRefTarget })}
                    />
                  </div>
                )}
              </div>
            )}

            {/* Row 4: oneof group */}
            <input
              type="text"
              value={field.oneofGroup ?? ""}
              placeholder="oneof group (optional — groups fields into a `oneof`)"
              onChange={(e) => update(field.id, { oneofGroup: e.target.value || undefined })}
              className={`${inputCls} w-full text-mono-small`}
            />
          </div>
        ))}
      </div>

      <button
        onClick={() => setFields((prev) => [...prev, newField(prev)])}
        className="flex items-center gap-space-1 self-start px-space-3 py-1.5 rounded-lg text-body-small bg-muted hover:bg-accent text-foreground"
      >
        <Plus className="w-4 h-4" />
        Add Field
      </button>
    </div>
  );
}
