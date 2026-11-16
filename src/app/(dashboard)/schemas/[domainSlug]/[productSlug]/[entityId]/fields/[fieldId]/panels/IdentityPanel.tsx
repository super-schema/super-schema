"use client";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { FieldGroup, FieldDescription } from "@/components/ui/field";
import { AttributeControl } from "@/components/custom/FieldAttributes/AttributeControl";
import {
  defaultInput,
  storedDefaultText,
} from "@/lib/compiler/typed-value-literal";
import { valueConstraintErrors } from "@/lib/field-attributes";
import type {
  Identity,
  ValidationConstraints,
} from "@/types/schemas/typespec-decorator.schema";

import { NativeSelect } from "@/components/ui/native-select";
import { Checkbox } from "@/components/ui/checkbox";
interface Props {
  validation?: ValidationConstraints;
  identity: Identity;
  fieldType: string;
  isOptional: boolean;
  allowNull?: boolean;
  onIdentityChange: (value: Identity) => void;
  onOptionalChange: (value: boolean) => void;
  onAllowNullChange?: (value: boolean) => void;
}
export function IdentityPanel({
  identity,
  fieldType,
  validation,
  isOptional,
  allowNull = false,
  onIdentityChange,
  onOptionalChange,
  onAllowNullChange,
}: Props) {
  const [typedDefault, setTypedDefault] = useState<{
    stored: unknown;
    text: string;
  } | null>(null);
  const stored = identity.defaultValue ?? null;
  const text =
    typedDefault?.stored === stored
      ? typedDefault.text
      : storedDefaultText(stored, fieldType);
  const check = defaultInput(text, fieldType);
  function update(value: Partial<Identity>) {
    onIdentityChange({ ...identity, ...value });
  }
  const isKey = identity.key === true;
  const formats = ["string", "url"].includes(fieldType)
    ? [
        "uuid",
        "uri",
        "email",
        "password",
        "date-time",
        "date",
        "time",
        "duration",
        "ipv4",
        "ipv6",
        "uri-template",
        "json-pointer",
        "regex",
      ]
    : [];
  return (
    <FieldGroup>
      <fieldset className="flex min-w-0 flex-col gap-3">
        <legend className="mb-2 text-sm font-medium">Presence and value</legend>
        <label className="flex items-start gap-2 text-sm">
          <Checkbox
            checked={!isOptional}
            disabled={isKey}
            onChange={(e) => onOptionalChange(!e.target.checked)}
            className="mt-1"
          />
          <span>
            Required
            <span className="block text-xs text-muted-foreground">
              The property must be present.
              {isKey ? " Key fields are required." : ""}
            </span>
          </span>
        </label>
        {onAllowNullChange && (
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={allowNull}
              disabled={isKey}
              onChange={(e) => onAllowNullChange(e.target.checked)}
              className="mt-1"
            />
            <span>
              Allow null
              <span className="block text-xs text-muted-foreground">
                The value may be null, independently of whether the property is
                required.
              </span>
            </span>
          </label>
        )}
      </fieldset>
      <AttributeControl
        label="Default value"
        help="A schema default is a contract annotation; runtime use depends on the consumer."
        error={
          check.status === "rejected"
            ? `Default value ${check.reason}.`
            : valueConstraintErrors(
                identity.defaultValue,
                fieldType,
                validation,
              ).join(" ") || undefined
        }
      >
        {fieldType === "boolean" ? (
          <NativeSelect
            data-testid="field-default-value"
            value={
              identity.defaultValue == null ? "" : String(identity.defaultValue)
            }
            onChange={(e) =>
              update({
                defaultValue:
                  e.target.value === "" ? null : e.target.value === "true",
              })
            }
          >
            <option value="">No default</option>
            <option value="true">true</option>
            <option value="false">false</option>
          </NativeSelect>
        ) : (
          <Input
            data-testid="field-default-value"
            value={text}
            spellCheck={false}
            placeholder="No default"
            onChange={(e) => {
              const input = defaultInput(e.target.value, fieldType);
              const value =
                input.status === "cleared"
                  ? null
                  : input.status === "value"
                    ? input.value
                    : e.target.value;
              setTypedDefault({ stored: value, text: e.target.value });
              update({ defaultValue: value });
            }}
          />
        )}
      </AttributeControl>
      <label className="flex items-start gap-2 text-sm">
        <Checkbox
          checked={isKey}
          onChange={(e) => {
            if (e.target.checked) {
              onOptionalChange(false);
              onAllowNullChange?.(false);
            }
            update({ key: e.target.checked });
          }}
          className="mt-1"
        />
        <span>
          Key
          <span className="block text-xs text-muted-foreground">
            Identifies an entity instance. Composite keys are configured at
            entity level.
          </span>
        </span>
      </label>
      {formats.length > 0 && (
        <AttributeControl
          label="Format"
          help="A semantic format annotation. Validation support varies by target and consumer."
        >
          <Input
            list="field-string-formats"
            value={identity.format ?? ""}
            onChange={(e) => update({ format: e.target.value || null })}
            placeholder="No format"
            spellCheck={false}
          />
        </AttributeControl>
      )}
      {formats.length > 0 && (
        <datalist id="field-string-formats">
          {formats.map((format) => (
            <option key={format} value={format} />
          ))}
        </datalist>
      )}
      {identity.discriminator && (
        <FieldDescription>
          This field is selected as the entity discriminator. Manage the
          selection under Schema Evolution.
        </FieldDescription>
      )}
    </FieldGroup>
  );
}
