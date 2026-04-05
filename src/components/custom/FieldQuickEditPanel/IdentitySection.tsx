"use client";

import { Input } from "@/components/ui/input";
import { TypePicker } from "@/components/custom/TypePicker";
import { getTypeInfo } from "@/lib/data-types";

interface IdentitySectionProps {
  name: string;
  type: string;
  nullable: boolean;
  isKey: boolean;
  secret: boolean;
  format: string;
  defaultValue: string;
  isReadOnly?: boolean;
  onChange: (field: string, value: unknown) => void;
}

const FORMAT_OPTIONS = [
  { value: "", label: "None" },
  { value: "uuid", label: "uuid" },
  { value: "email", label: "email" },
  { value: "uri", label: "uri" },
  { value: "date-time", label: "date-time" },
  { value: "ipv4", label: "ipv4" },
  { value: "ipv6", label: "ipv6" },
];

export function IdentitySection({
  name,
  type,
  nullable,
  isKey,
  secret,
  format,
  defaultValue,
  isReadOnly = false,
  onChange,
}: IdentitySectionProps) {
  const typeInfo = getTypeInfo(type);
  const category = typeInfo?.category ?? "String";

  function getDefaultPlaceholder(): string {
    switch (category) {
      case "Number":
        return "0";
      case "Boolean":
        return "true / false";
      case "String":
        return '""';
      default:
        return "";
    }
  }

  return (
    <div className="space-y-space-3">
      {/* Name */}
      <div>
        <label className="text-caption text-muted-foreground mb-1 block">Name</label>
        <Input
          value={name}
          onChange={(e) => onChange("name", e.target.value)}
          className="h-8 font-mono text-body-small"
          disabled={isReadOnly}
        />
      </div>

      {/* Type */}
      <div>
        <label className="text-caption text-muted-foreground mb-1 block">Type</label>
        <TypePicker
          value={type}
          onChange={(t) => onChange("type", t)}
        />
      </div>

      {/* Checkboxes row */}
      <div className="flex items-center gap-space-4 flex-wrap">
        <label className="flex items-center gap-1.5 text-caption text-muted-foreground">
          <input
            type="checkbox"
            checked={nullable}
            onChange={(e) => onChange("nullable", e.target.checked)}
            className="accent-primary"
            disabled={isReadOnly || isKey}
          />
          Optional
        </label>
        <label className="flex items-center gap-1.5 text-caption text-muted-foreground">
          <input
            type="checkbox"
            checked={secret}
            onChange={(e) => onChange("secret", e.target.checked)}
            className="accent-primary"
            disabled={isReadOnly}
          />
          Secret
        </label>
        <label className="flex items-center gap-1.5 text-caption text-muted-foreground">
          <input
            type="checkbox"
            checked={isKey}
            onChange={(e) => {
              onChange("isKey", e.target.checked);
              if (e.target.checked) {
                onChange("nullable", false);
              }
            }}
            className="accent-primary"
            disabled={isReadOnly}
          />
          Key
        </label>
      </div>

      {/* Format */}
      <div>
        <label className="text-caption text-muted-foreground mb-1 block">Format</label>
        <select
          value={format}
          onChange={(e) => onChange("format", e.target.value)}
          disabled={isReadOnly}
          className="h-8 w-full rounded-lg border border-border bg-popover px-2 text-body-small text-foreground disabled:opacity-50"
        >
          {FORMAT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      {/* Default value */}
      <div>
        <label className="text-caption text-muted-foreground mb-1 block">Default Value</label>
        <Input
          value={defaultValue}
          onChange={(e) => onChange("defaultValue", e.target.value)}
          placeholder={getDefaultPlaceholder()}
          className="h-8 font-mono text-body-small"
          disabled={isReadOnly}
        />
      </div>
    </div>
  );
}
