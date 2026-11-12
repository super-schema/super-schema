"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FieldGroup, FieldDescription } from "@/components/ui/field";
import {
  AttributeControl,
  SELECT_CLASS,
} from "@/components/custom/FieldAttributes/AttributeControl";
import { isConstraintWithheld } from "@/lib/compiler/constraint-targets";
import {
  VALIDATION_DECORATORS,
  applicableValidationKeys,
  fieldAttributeErrors,
  staleValidationKeys,
  validationNotApplicableReason,
} from "@/lib/field-attributes";
import type { ValidationConstraints } from "@/types/schemas/typespec-decorator.schema";

/**
 * Payload constraints TypeSpec allows for the field's logical type, and that the emitter writes. Which controls appear is
 * decided by the same rule the generator uses (constraintAppliesTo), so the panel, the summary and the TypeSpec agree.
 */
export function ValidationPanel({
  validation: v,
  fieldType,
  enumSymbolsInPattern = false,
  onChange,
}: {
  validation: ValidationConstraints;
  fieldType: string;
  /** True when an enum's values are still read from a legacy `pattern` (no aliases yet). Clearing it would drop the values. */
  enumSymbolsInPattern?: boolean;
  onChange: (v: ValidationConstraints) => void;
}) {
  const [sample, setSample] = useState("");
  const [exclusiveMin, setExclusiveMin] = useState(false);
  const [exclusiveMax, setExclusiveMax] = useState(false);
  function update(patch: Partial<ValidationConstraints>) {
    onChange({ ...v, ...patch });
  }
  const applicable = applicableValidationKeys(fieldType);
  const numeric = applicable.includes("minValue");
  const string = applicable.includes("minLength");
  const array = applicable.includes("minItems");
  const stale = staleValidationKeys(v, fieldType).filter(
    (key) => !(enumSymbolsInPattern && key === "pattern"),
  );
  const errors = fieldAttributeErrors({
    type: fieldType,
    decorators: { typespec: { validation: v } },
  });
  let match = "";
  if (string && v.pattern) {
    try {
      const regex = new RegExp(v.pattern);
      if (sample) match = regex.test(sample) ? "Matches the pattern" : "Does not match the pattern";
    } catch {
      match = "Invalid regular expression";
    }
  }
  if (applicable.length === 0)
    return (
      <FieldGroup>
        <FieldDescription>{validationNotApplicableReason(fieldType)}</FieldDescription>
        {stale.map((key) => (
          <StaleValue
            key={key}
            storedKey={key}
            value={v[key]}
            fieldType={fieldType}
            onClear={() => update({ [key]: null })}
          />
        ))}
        {enumSymbolsInPattern && (
          <FieldDescription>
            Enum values are still stored in the legacy pattern. Editing them under Properties saves them as enum values and removes the pattern.
          </FieldDescription>
        )}
      </FieldGroup>
    );
  return (
    <FieldGroup>
      <FieldDescription>
        These constraints describe valid payload values. Each control shows the
        TypeSpec decorator it is written as. Dataset checks are configured under
        Data Quality.
      </FieldDescription>
      {numeric &&
        (["min", "max"] as const).map((bound) => {
          const key = bound === "min" ? "minValue" : "maxValue";
          const exclusiveKey =
            bound === "min" ? "minValueExclusive" : "maxValueExclusive";
          const exclusive =
            v[exclusiveKey] != null ||
            (v[key] == null && (bound === "min" ? exclusiveMin : exclusiveMax));
          const stored = v[exclusive ? exclusiveKey : key];
          const withheld =
            stored != null &&
            isConstraintWithheld(fieldType, exclusive ? exclusiveKey : key, stored);
          return (
            <fieldset key={bound} className="flex min-w-0 flex-col gap-2">
              <legend className="mb-2 text-sm font-medium">
                {bound === "min" ? "Minimum" : "Maximum"}
              </legend>
              <AttributeControl
                label={bound === "min" ? "Minimum value" : "Maximum value"}
                hint={VALIDATION_DECORATORS[exclusive ? exclusiveKey : key]}
                help={
                  withheld
                    ? `Stored, but not written to TypeSpec: the bound is outside the range of ${fieldType}.`
                    : undefined
                }
              >
                <Input
                  type="number"
                  step="any"
                  value={v[exclusiveKey] ?? v[key] ?? ""}
                  onChange={(e) =>
                    update({
                      [exclusive ? exclusiveKey : key]:
                        e.target.value === "" ? null : Number(e.target.value),
                      [exclusive ? key : exclusiveKey]: null,
                    })
                  }
                />
              </AttributeControl>
              <AttributeControl
                label={
                  bound === "min" ? "Minimum boundary" : "Maximum boundary"
                }
                help={
                  exclusive
                    ? "Exclusive: the value itself is not allowed."
                    : "Inclusive: the value itself is allowed."
                }
              >
                <select
                  className={SELECT_CLASS}
                  value={exclusive ? "exclusive" : "inclusive"}
                  onChange={(e) => {
                    const next = e.target.value === "exclusive";
                    (bound === "min" ? setExclusiveMin : setExclusiveMax)(next);
                    update({
                      [next ? exclusiveKey : key]:
                        v[key] ?? v[exclusiveKey] ?? null,
                      [next ? key : exclusiveKey]: null,
                    });
                  }}
                >
                  <option value="inclusive">Inclusive</option>
                  <option value="exclusive">Exclusive</option>
                </select>
              </AttributeControl>
            </fieldset>
          );
        })}
      {array && (
        <>
          <FieldDescription>
            Limits the number of items in the array. Constraints on individual
            items are not expressed here.
          </FieldDescription>
          {(["minItems", "maxItems"] as const).map((key) => (
            <AttributeControl
              key={key}
              label={key === "minItems" ? "Minimum items" : "Maximum items"}
              hint={VALIDATION_DECORATORS[key]}
            >
              <Input
                type="number"
                min={0}
                step={1}
                value={v[key] ?? ""}
                onChange={(e) =>
                  update({
                    [key]: e.target.value === "" ? null : Number(e.target.value),
                  })
                }
              />
            </AttributeControl>
          ))}
        </>
      )}
      {string && (
        <>
          {(["minLength", "maxLength"] as const).map((key) => (
            <AttributeControl
              key={key}
              label={key === "minLength" ? "Minimum length" : "Maximum length"}
              hint={VALIDATION_DECORATORS[key]}
            >
              <Input
                type="number"
                min={0}
                step={1}
                value={v[key] ?? ""}
                onChange={(e) =>
                  update({
                    [key]: e.target.value === "" ? null : Number(e.target.value),
                  })
                }
              />
            </AttributeControl>
          ))}
          <AttributeControl
            label="Pattern"
            hint="@pattern"
            help="Regular expression. Test uses the browser’s JavaScript regex engine; downstream validators can differ."
          >
            <Input
              value={v.pattern ?? ""}
              spellCheck={false}
              onChange={(e) => update({ pattern: e.target.value || null })}
            />
          </AttributeControl>
          {v.pattern && (
            <AttributeControl label="Pattern test value">
              <Input
                value={sample}
                onChange={(e) => setSample(e.target.value)}
              />
            </AttributeControl>
          )}
          {match && (
            <p role="status" className="text-xs">
              {match}
            </p>
          )}
          {fieldType === "string" || fieldType === "url" ? (
            <FieldDescription>
              The format (@format) is set under Properties.
            </FieldDescription>
          ) : null}
        </>
      )}
      {stale.map((key) => (
        <StaleValue
          key={key}
          storedKey={key}
          value={v[key]}
          fieldType={fieldType}
          onClear={() => update({ [key]: null })}
        />
      ))}
      {errors.map((error) => (
        <p key={error} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ))}
    </FieldGroup>
  );
}

/** A stored validator that TypeSpec never writes for this type. It is shown so it can be cleared, not silently kept. */
function StaleValue({
  storedKey,
  value,
  fieldType,
  onClear,
}: {
  storedKey: keyof ValidationConstraints;
  value: ValidationConstraints[keyof ValidationConstraints];
  fieldType: string;
  onClear: () => void;
}) {
  const decorator = VALIDATION_DECORATORS[storedKey as keyof typeof VALIDATION_DECORATORS];
  return (
    <div className="flex min-w-0 items-start justify-between gap-2 rounded-md border border-border p-2 text-xs">
      <p className="min-w-0 break-words text-muted-foreground">
        Stored <code className="font-mono">{decorator}</code>{" "}
        <span className="font-mono text-foreground">{String(value)}</span> does
        not apply to {fieldType} fields, so TypeSpec does not write it.
      </p>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-label={`Clear stored ${decorator} value`}
        onClick={onClear}
      >
        Clear
      </Button>
    </div>
  );
}
