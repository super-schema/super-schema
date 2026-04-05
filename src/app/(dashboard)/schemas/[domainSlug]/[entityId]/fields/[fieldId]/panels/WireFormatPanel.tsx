"use client";

import { useState } from "react";
import { Plus, X, Info } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { WireFormat } from "@/types/schemas/typespec-decorator.schema";

const ENCODE_OPTIONS: Record<string, { label: string; subTypes?: string[] }[]> = {
  utcDateTime: [
    { label: "rfc3339" },
    { label: "rfc7231" },
    { label: "unixTimestamp", subTypes: ["int32", "int64", "float64"] },
  ],
  offsetDateTime: [
    { label: "rfc3339" },
    { label: "rfc7231" },
    { label: "unixTimestamp", subTypes: ["int32", "int64", "float64"] },
  ],
  duration: [
    { label: "ISO8601" },
    { label: "seconds", subTypes: ["int32", "float64"] },
  ],
  int64: [{ label: "string" }],
  decimal: [{ label: "string" }],
  decimal128: [{ label: "string" }],
  bytes: [{ label: "base64" }, { label: "base64url" }, { label: "hex" }],
};

const HTTP_BINDINGS = [
  { value: "none", label: "None", hasName: false },
  { value: "header", label: "@header", hasName: true },
  { value: "query", label: "@query", hasName: true },
  { value: "path", label: "@path", hasName: true },
  { value: "cookie", label: "@cookie", hasName: false },
  { value: "body", label: "@body", hasName: false },
  { value: "bodyRoot", label: "@bodyRoot", hasName: false },
  { value: "bodyIgnore", label: "@bodyIgnore", hasName: false },
  { value: "statusCode", label: "@statusCode", hasName: false },
] as const;

interface WireFormatPanelProps {
  wireFormat: WireFormat;
  fieldType: string;
  typeCategory: string;
  fieldNumber?: number | null;
  onFieldNumberChange?: (fieldNumber: number | null) => void;
  onChange: (wireFormat: WireFormat) => void;
}

export function WireFormatPanel({
  wireFormat,
  fieldType,
  typeCategory,
  fieldNumber,
  onFieldNumberChange,
  onChange,
}: WireFormatPanelProps) {
  const [httpExpanded, setHttpExpanded] = useState(false);
  const [newEncodedKey, setNewEncodedKey] = useState("");
  const [newEncodedVal, setNewEncodedVal] = useState("");

  function update(partial: Partial<WireFormat>) {
    onChange({ ...wireFormat, ...partial });
  }

  const encodeOptions = ENCODE_OPTIONS[fieldType] ?? [];
  const selectedEncode = encodeOptions.find(
    (o) => o.label === wireFormat.encode
  );

  return (
    <div className="space-y-space-4 pb-space-2">
      {/* Field Number (Protobuf) */}
      {onFieldNumberChange && (
        <div>
          <label className="text-caption text-muted-foreground mb-1 flex items-center gap-1">
            Field Number
            <span
              className="text-muted-foreground/50 cursor-help"
              title="Permanent field number for Protobuf wire compatibility -- once assigned, should not change"
            >
              <Info className="w-3 h-3 inline" />
            </span>
          </label>
          <Input
            type="number"
            value={fieldNumber ?? ""}
            onChange={(e) =>
              onFieldNumberChange(e.target.value ? parseInt(e.target.value, 10) : null)
            }
            placeholder="Assign field number..."
            className="h-7 text-body-small font-mono w-32"
          />
          <span className="text-[10px] text-muted-foreground/50 mt-0.5 block">
            Auto-assigned. Edit only for Protobuf wire compatibility.
          </span>
        </div>
      )}

      {/* @encode */}
      {encodeOptions.length > 0 && (
        <div>
          <label className="text-caption text-muted-foreground mb-1 block">
            @encode
          </label>
          <div className="flex items-center gap-2">
            <select
              value={wireFormat.encode ?? ""}
              onChange={(e) =>
                update({
                  encode: e.target.value || null,
                  encodeSubType: null,
                })
              }
              className="h-7 rounded border border-border bg-background px-2 text-body-small text-foreground w-48"
            >
              <option value="">None</option>
              {encodeOptions.map((opt) => (
                <option key={opt.label} value={opt.label}>
                  {opt.label}
                </option>
              ))}
            </select>
            {selectedEncode?.subTypes && (
              <select
                value={wireFormat.encodeSubType ?? ""}
                onChange={(e) =>
                  update({ encodeSubType: e.target.value || null })
                }
                className="h-7 rounded border border-border bg-background px-2 text-body-small text-foreground w-32"
              >
                <option value="">Type…</option>
                {selectedEncode.subTypes.map((st) => (
                  <option key={st} value={st}>
                    {st}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
      )}

      {/* @encodedName key-value editor */}
      <div>
        <label className="text-caption text-muted-foreground mb-1 block">
          @encodedName (content-type → name)
        </label>
        <div className="space-y-1">
          {Object.entries(wireFormat.encodedNames ?? {}).map(([key, val]) => (
            <div key={key} className="flex items-center gap-2">
              <span className="text-caption font-mono text-muted-foreground truncate w-40">
                {key}
              </span>
              <span className="text-caption text-muted-foreground/50">→</span>
              <span className="text-caption font-mono text-foreground">
                {val}
              </span>
              <button
                onClick={() => {
                  const next = { ...(wireFormat.encodedNames ?? {}) };
                  delete next[key];
                  update({ encodedNames: next });
                }}
                className="p-0.5 text-muted-foreground hover:text-destructive"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <Input
              value={newEncodedKey}
              onChange={(e) => setNewEncodedKey(e.target.value)}
              placeholder="application/json"
              className="h-6 text-caption w-40 font-mono"
            />
            <span className="text-caption text-muted-foreground/50">→</span>
            <Input
              value={newEncodedVal}
              onChange={(e) => setNewEncodedVal(e.target.value)}
              placeholder="encoded_name"
              className="h-6 text-caption w-32 font-mono"
            />
            <Button
              size="icon-xs"
              variant="ghost"
              disabled={!newEncodedKey.trim() || !newEncodedVal.trim()}
              onClick={() => {
                update({
                  encodedNames: {
                    ...(wireFormat.encodedNames ?? {}),
                    [newEncodedKey.trim()]: newEncodedVal.trim(),
                  },
                });
                setNewEncodedKey("");
                setNewEncodedVal("");
              }}
            >
              <Plus className="w-3 h-3" />
            </Button>
          </div>
        </div>
      </div>

      {/* HTTP Parameter Binding */}
      <div className="border-t border-border/50 pt-space-3">
        <button
          onClick={() => setHttpExpanded(!httpExpanded)}
          className="text-body-small font-medium text-muted-foreground hover:text-foreground transition-colors"
        >
          HTTP Parameter Binding{" "}
          <span className="text-[10px] text-muted-foreground/50">
            {httpExpanded ? "▼" : "▶"} (applies only in HTTP operations)
          </span>
        </button>

        {httpExpanded && (
          <div className="mt-space-2 space-y-space-2">
            <div className="flex flex-wrap gap-space-3">
              {HTTP_BINDINGS.map((binding) => (
                <label
                  key={binding.value}
                  className="flex items-center gap-1.5 text-caption text-muted-foreground cursor-pointer"
                >
                  <input
                    type="radio"
                    name="httpBinding"
                    value={binding.value}
                    checked={
                      (wireFormat.httpBinding ?? "none") === binding.value
                    }
                    onChange={() =>
                      update({
                        httpBinding:
                          binding.value === "none" ? null : (binding.value as WireFormat["httpBinding"]),
                        httpBindingName:
                          binding.hasName
                            ? wireFormat.httpBindingName
                            : null,
                      })
                    }
                    className="accent-primary"
                  />
                  {binding.label}
                </label>
              ))}
            </div>

            {/* Name override for header/query/path */}
            {wireFormat.httpBinding &&
              ["header", "query", "path"].includes(wireFormat.httpBinding) && (
                <div>
                  <label className="text-caption text-muted-foreground mb-1 block">
                    Name override
                  </label>
                  <Input
                    value={wireFormat.httpBindingName ?? ""}
                    onChange={(e) =>
                      update({
                        httpBindingName: e.target.value || null,
                      })
                    }
                    placeholder="Use field name"
                    className="h-6 text-caption w-48 font-mono"
                  />
                </div>
              )}
          </div>
        )}
      </div>
    </div>
  );
}
