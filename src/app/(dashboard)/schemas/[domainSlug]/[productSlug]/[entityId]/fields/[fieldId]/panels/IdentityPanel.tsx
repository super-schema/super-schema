"use client";

import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import type { Identity } from "@/types/schemas/typespec-decorator.schema";

const STRING_FORMATS = [
  "uuid",
  "uri",
  "email",
  "password",
  "date-time",
  "date",
  "time",
  "duration",
  "ip-address",
  "ip-v4-address",
  "ip-v6-address",
  "uri-template",
  "json-pointer",
  "relative-json-pointer",
  "regex",
];

const INTEGER_FORMATS = [
  "int8",
  "int16",
  "int32",
  "int64",
  "uint8",
  "uint16",
  "uint32",
  "uint64",
  "safeint",
];

function getFormatsForType(fieldType: string): string[] {
  const stringTypes = ["string", "url"];
  const integerTypes = [
    "integer",
    "int8",
    "int16",
    "int32",
    "int64",
    "safeint",
    "uint8",
    "uint16",
    "uint32",
    "uint64",
  ];

  if (stringTypes.includes(fieldType)) return STRING_FORMATS;
  if (integerTypes.includes(fieldType)) return INTEGER_FORMATS;
  return [];
}

interface IdentityPanelProps {
  identity: Identity;
  fieldType: string;
  isOptional: boolean;
  onIdentityChange: (identity: Identity) => void;
  onOptionalChange: (optional: boolean) => void;
}

export function IdentityPanel({
  identity,
  fieldType,
  isOptional,
  onIdentityChange,
  onOptionalChange,
}: IdentityPanelProps) {
  function update(partial: Partial<Identity>) {
    onIdentityChange({ ...identity, ...partial });
  }

  const formats = getFormatsForType(fieldType);
  const isKey = identity.key ?? false;
  const isDiscriminator = identity.discriminator ?? false;
  const isSecret = identity.secret ?? false;

  return (
    <div className="space-y-space-4 pb-space-2">
      {/* Optionality toggle */}
      <div className="flex items-center gap-space-4">
        <label className="flex items-center gap-2 text-body-small text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={isOptional}
            onChange={(e) => onOptionalChange(e.target.checked)}
            className="accent-primary"
            disabled={isKey}
          />
          Optional (?)
          {isKey && (
            <span className="text-[10px] text-muted-foreground/50">
              (key fields are required)
            </span>
          )}
        </label>
      </div>

      {/* Default Value */}
      <div>
        <label className="text-caption text-muted-foreground mb-1 block">
          Default Value
        </label>
        {fieldType === "boolean" ? (
          <label className="flex items-center gap-2 text-body-small cursor-pointer">
            <input
              type="checkbox"
              checked={!!identity.defaultValue}
              onChange={(e) => update({ defaultValue: e.target.checked })}
              className="accent-primary"
            />
            {identity.defaultValue ? "true" : "false"}
          </label>
        ) : (
          <Input
            value={
              identity.defaultValue != null
                ? String(identity.defaultValue)
                : ""
            }
            onChange={(e) => {
              const val = e.target.value;
              if (val === "") {
                update({ defaultValue: null });
              } else if (
                [
                  "integer",
                  "int8",
                  "int16",
                  "int32",
                  "int64",
                  "float",
                  "float32",
                  "float64",
                  "decimal",
                  "decimal128",
                  "numeric",
                  "safeint",
                  "uint8",
                  "uint16",
                  "uint32",
                  "uint64",
                ].includes(fieldType)
              ) {
                const num = Number(val);
                update({ defaultValue: isNaN(num) ? val : num });
              } else {
                update({ defaultValue: val });
              }
            }}
            placeholder="No default"
            className="h-7 text-body-small font-mono w-48"
          />
        )}
      </div>

      {/* @key and @discriminator — mutually exclusive */}
      <div className="flex items-center gap-space-6">
        <label className="flex items-center gap-2 text-body-small text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={isKey}
            onChange={(e) => {
              const checked = e.target.checked;
              const updates: Partial<Identity> = { key: checked };
              if (checked) {
                updates.discriminator = false;
                onOptionalChange(false);
              }
              update(updates);
            }}
            className="accent-primary"
            disabled={isDiscriminator}
          />
          @key
          {isDiscriminator && (
            <span className="text-[10px] text-muted-foreground/50">
              Cannot be both key and discriminator
            </span>
          )}
        </label>

        <label className="flex items-center gap-2 text-body-small text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={isDiscriminator}
            onChange={(e) => {
              const checked = e.target.checked;
              const updates: Partial<Identity> = { discriminator: checked };
              if (checked) {
                updates.key = false;
              }
              update(updates);
            }}
            className="accent-primary"
            disabled={isKey}
          />
          @discriminator
          {isKey && (
            <span className="text-[10px] text-muted-foreground/50">
              Cannot be both key and discriminator
            </span>
          )}
        </label>

        {(isKey || isDiscriminator) && (
          <Badge variant="outline" className="text-[10px]">
            mutex
          </Badge>
        )}
      </div>

      {/* @secret */}
      <label className="flex items-center gap-2 text-body-small text-muted-foreground cursor-pointer">
        <input
          type="checkbox"
          checked={isSecret}
          onChange={(e) => update({ secret: e.target.checked })}
          className="accent-primary"
        />
        @secret — marks field value as sensitive
      </label>

      {/* @format dropdown */}
      {formats.length > 0 && (
        <div>
          <label className="text-caption text-muted-foreground mb-1 block">
            @format
          </label>
          <select
            value={identity.format ?? ""}
            onChange={(e) =>
              update({ format: e.target.value || null })
            }
            className="h-7 rounded border border-border bg-background px-2 text-body-small text-foreground w-48"
          >
            <option value="">None</option>
            {formats.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
