"use client";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  FieldGroup,
  FieldDescription,
  FieldError,
} from "@/components/ui/field";
import { AttributeControl } from "@/components/custom/FieldAttributes/AttributeControl";
import type { WireFormat } from "@/types/schemas/typespec-decorator.schema";
import { NativeSelect } from "@/components/ui/native-select";
const ENCODINGS: Record<string, string[]> = {
  utcDateTime: ["rfc3339", "rfc7231", "unixTimestamp"],
  offsetDateTime: ["rfc3339", "rfc7231", "unixTimestamp"],
  duration: ["ISO8601", "seconds"],
  int64: ["string"],
  decimal: ["string"],
  decimal128: ["string"],
  bytes: ["base64", "base64url"],
};
export function WireFormatPanel({
  wireFormat: w,
  fieldType,
  fieldNumber,
  onFieldNumberChange,
  onChange,
}: {
  wireFormat: WireFormat;
  fieldType: string;
  typeCategory?: string;
  fieldNumber?: number | null;
  onFieldNumberChange?: (n: number | null) => void;
  onChange: (v: WireFormat) => void;
}) {
  const [media, setMedia] = useState("application/json");
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  function update(patch: Partial<WireFormat>) {
    onChange({ ...w, ...patch });
  }
  const encodings = ENCODINGS[fieldType] ?? [];
  const subtype = w.encode === "unixTimestamp" || w.encode === "seconds";
  return (
    <FieldGroup>
      <FieldDescription>
        Serialization describes the wire representation. Support depends on the
        chosen schema target and its consumers.
      </FieldDescription>
      {encodings.length > 0 && (
        <AttributeControl label="Encoding">
          <NativeSelect
            value={w.encode ?? ""}
            onChange={(e) =>
              update({
                encode: e.target.value || null,
                encodeSubType: ["unixTimestamp", "seconds"].includes(
                  e.target.value,
                )
                  ? "int64"
                  : null,
              })
            }
          >
            <option value="">Type default</option>
            {encodings.map((encoding) => (
              <option key={encoding}>{encoding}</option>
            ))}
            {w.encode && !encodings.includes(w.encode) && (
              <option>{w.encode}</option>
            )}
          </NativeSelect>
        </AttributeControl>
      )}
      {subtype && (
        <AttributeControl label="Encoded numeric type">
          <NativeSelect
            value={w.encodeSubType ?? "int64"}
            onChange={(e) => update({ encodeSubType: e.target.value })}
          >
            {["int32", "int64", "float64"].map((type) => (
              <option key={type}>{type}</option>
            ))}
          </NativeSelect>
        </AttributeControl>
      )}
      {w.encode && (
        <code className="break-all text-xs">
          Representation: {w.encode}
          {w.encodeSubType ? ` (${w.encodeSubType})` : ""}
        </code>
      )}
      {!encodings.length && w.encode && (
        <FieldDescription>
          Stored encoding {w.encode} is preserved but may not apply to{" "}
          {fieldType}. Change the type or clear incompatible metadata before
          generation.
        </FieldDescription>
      )}
      {!encodings.length && w.encode && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => update({ encode: null, encodeSubType: null })}
        >
          Clear incompatible encoding
        </Button>
      )}
      {Object.entries(w.encodedNames ?? {}).map(([key, value]) => (
        <div key={key} className="flex min-w-0 flex-wrap items-center gap-2">
          <code className="min-w-0 flex-1 break-all text-xs">
            {key} → {value}
          </code>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={`Edit encoded name ${key}`}
            onClick={() => {
              setEditing(key);
              setMedia(key);
              setName(value);
            }}
          >
            Edit
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={`Remove encoded name ${key}`}
            onClick={() => {
              const next = { ...w.encodedNames };
              delete next[key];
              update({ encodedNames: next });
            }}
          >
            Remove
          </Button>
        </div>
      ))}
      <AttributeControl label="Encoded name media type">
        <Input
          value={media}
          spellCheck={false}
          onChange={(e) => setMedia(e.target.value)}
          placeholder="application/json"
        />
      </AttributeControl>
      <AttributeControl label="Encoded field name">
        <Input
          value={name}
          spellCheck={false}
          onChange={(e) => setName(e.target.value)}
        />
      </AttributeControl>
      {error && <FieldError>{error}</FieldError>}
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={!media.trim() || !name.trim()}
        onClick={() => {
          const key = media.trim();
          if (!/^[^\s/]+\/[^\s/]+$/.test(key)) {
            setError("Enter a media type such as application/json.");
            return;
          }
          if (key !== editing && Object.hasOwn(w.encodedNames ?? {}, key)) {
            setError("This media type already has a name. Edit that entry.");
            return;
          }
          const names = { ...w.encodedNames };
          if (editing) delete names[editing];
          names[key] = name.trim();
          update({ encodedNames: names });
          setName("");
          setEditing(null);
          setError(null);
        }}
      >
        {editing ? "Update encoded name" : "Add encoded name"}
      </Button>
      <FieldDescription>
        HTTP parameter placement is configured on API operations. A reusable
        field can be used in different operation contexts.
      </FieldDescription>
      {w.httpBinding && w.httpBinding !== "none" && (
        <FieldDescription>
          Preserved legacy HTTP binding: {w.httpBinding}
          {w.httpBindingName ? ` (${w.httpBindingName})` : ""}. It is not
          applied to standalone model schemas.
        </FieldDescription>
      )}
      {onFieldNumberChange && (
        <AttributeControl
          label="Protobuf field number"
          help="Permanent wire identifier. Renumbering or reusing a published field number can break compatibility. Valid range: 1–536870911, excluding 19000–19999."
        >
          <Input
            type="number"
            min={1}
            max={536870911}
            step={1}
            value={fieldNumber ?? ""}
            onChange={(e) =>
              onFieldNumberChange(
                e.target.value === "" ? null : Number(e.target.value),
              )
            }
          />
        </AttributeControl>
      )}
    </FieldGroup>
  );
}
