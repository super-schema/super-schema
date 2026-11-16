"use client";

import { Input } from "@/components/ui/input";
import { TypePicker } from "@/components/custom/TypePicker";
import { getTypeInfo } from "@/lib/data-types";

import { NativeSelect } from "@/components/ui/native-select";
import { Checkbox } from "@/components/ui/checkbox";
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

const STRING_TYPES = new Set(["string", "url"]);
function isStringType(type: string): boolean {
  return STRING_TYPES.has(type);
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
          <Checkbox
            checked={nullable}
            onChange={(e) => onChange("nullable", e.target.checked)}
            disabled={isReadOnly || isKey}
          />
          Optional
        </label>
        <label className="flex items-center gap-1.5 text-caption text-muted-foreground">
          <Checkbox
            checked={secret}
            onChange={(e) => onChange("secret", e.target.checked)}
            disabled={isReadOnly}
          />
          Secret
        </label>
        <label className="flex items-center gap-1.5 text-caption text-muted-foreground">
          <Checkbox
            checked={isKey}
            onChange={(e) => {
              onChange("isKey", e.target.checked);
              if (e.target.checked) {
                onChange("nullable", false);
              }
            }}
            disabled={isReadOnly}
          />
          Key
        </label>
      </div>

      {/* Format (string types only) + Default value */}
      <div className={`grid gap-space-2 ${isStringType(type) ? "grid-cols-2" : "grid-cols-1"}`}>
        {isStringType(type) && (
          <div>
            <label className="text-caption text-muted-foreground mb-1 block">Format</label>
            <NativeSelect
              value={format}
              onChange={(e) => onChange("format", e.target.value)}
              disabled={isReadOnly}
              className="h-8 w-full"
            >
              {FORMAT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </NativeSelect>
          </div>
        )}
        <div>
          <label className="text-caption text-muted-foreground mb-1 block">Default</label>
          <Input
            value={defaultValue}
            onChange={(e) => onChange("defaultValue", e.target.value)}
            placeholder={getDefaultPlaceholder()}
            className="h-8 font-mono text-body-small"
            disabled={isReadOnly}
          />
        </div>
      </div>
    </div>
  );
}
