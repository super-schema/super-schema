"use client";

/**
 * Entity reference picker shared by every format's visual editor — JSON
 * Schema's `$ref`, Avro's named-type reference, Protobuf's message reference.
 * Extracted from JsonSchemaVisualEditor so Avro/Protobuf editors reuse it
 * instead of each carrying their own copy.
 */

const inputCls =
  "bg-muted rounded-lg px-space-2 py-1.5 text-body-small text-foreground outline-none border border-border focus:border-primary";

export interface ReferenceTargetPickerProps {
  label: string;
  value: string;
  targets: { id?: string; name: string }[];
  onChange: (value: string) => void;
}

export function ReferenceTargetPicker({
  label,
  value,
  targets,
  onChange,
}: ReferenceTargetPickerProps) {
  return (
    <label className="flex flex-col gap-0.5 text-caption text-muted-foreground">
      <span>{label}</span>
      {targets.length > 0 ? (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={`${inputCls} w-full`}
        >
          <option value="">(select an entity)</option>
          {targets.map((t) => (
            <option key={t.id ?? t.name} value={t.name}>
              {t.name}
            </option>
          ))}
        </select>
      ) : (
        <input
          type="text"
          value={value}
          placeholder="EntityName to reference"
          onChange={(e) => onChange(e.target.value)}
          className={`${inputCls} w-full text-mono-small`}
        />
      )}
    </label>
  );
}
