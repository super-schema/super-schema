"use client";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { FieldGroup, FieldDescription } from "@/components/ui/field";
import {
  AttributeControl,
  SELECT_CLASS,
} from "@/components/custom/FieldAttributes/AttributeControl";
import { fieldAttributeErrors } from "@/lib/field-attributes";
import type { ValidationConstraints } from "@/types/schemas/typespec-decorator.schema";

export function ValidationPanel({
  validation: v,
  typeCategory,
  fieldType,
  onChange,
}: {
  validation: ValidationConstraints;
  typeCategory: string;
  fieldType: string;
  onChange: (v: ValidationConstraints) => void;
}) {
  const [sample, setSample] = useState("");
  const [exclusiveMin, setExclusiveMin] = useState(false);
  const [exclusiveMax, setExclusiveMax] = useState(false);
  function update(patch: Partial<ValidationConstraints>) {
    onChange({ ...v, ...patch });
  }
  const numeric = typeCategory === "Number";
  const string = typeCategory === "String" && fieldType !== "enum";
  const array = fieldType === "array";
  const errors = fieldAttributeErrors({
    decorators: { typespec: { validation: v } },
  });
  let match = "";
  if (v.pattern) {
    try {
      const regex = new RegExp(v.pattern);
      if (sample) match = regex.test(sample) ? "Match" : "No match";
    } catch {
      match = "Invalid regular expression";
    }
  }
  if (!numeric && !string && !array)
    return (
      <FieldDescription>
        No payload constraints apply to this type. Enum values are edited in
        Properties.
      </FieldDescription>
    );
  return (
    <FieldGroup>
      <FieldDescription>
        These constraints describe valid payload values. Dataset checks are
        configured under Data Quality.
      </FieldDescription>
      {numeric &&
        (["min", "max"] as const).map((bound) => {
          const key = bound === "min" ? "minValue" : "maxValue";
          const exclusiveKey =
            bound === "min" ? "minValueExclusive" : "maxValueExclusive";
          const exclusive =
            v[exclusiveKey] != null ||
            (v[key] == null && (bound === "min" ? exclusiveMin : exclusiveMax));
          return (
            <fieldset key={bound} className="flex min-w-0 flex-col gap-2">
              <legend className="mb-2 text-sm font-medium">
                {bound === "min" ? "Minimum" : "Maximum"}
              </legend>
              <AttributeControl
                label={bound === "min" ? "Minimum value" : "Maximum value"}
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
      {(string
        ? (["minLength", "maxLength"] as const)
        : array
          ? (["minItems", "maxItems"] as const)
          : []
      ).map((key) => (
        <AttributeControl
          key={key}
          label={
            {
              minLength: "Minimum length",
              maxLength: "Maximum length",
              minItems: "Minimum items",
              maxItems: "Maximum items",
            }[key]
          }
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
      {string && (
        <>
          <AttributeControl
            label="Pattern"
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
        </>
      )}
      {errors.map((error) => (
        <p key={error} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ))}
    </FieldGroup>
  );
}
