"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import type { ValidationConstraints } from "@/types/schemas/typespec-decorator.schema";

interface ValidationPanelProps {
  validation: ValidationConstraints;
  typeCategory: string;
  fieldType: string;
  onChange: (validation: ValidationConstraints) => void;
}

export function ValidationPanel({
  validation,
  typeCategory,
  fieldType,
  onChange,
}: ValidationPanelProps) {
  const [patternSample, setPatternSample] = useState("");

  function update(partial: Partial<ValidationConstraints>) {
    onChange({ ...validation, ...partial });
  }

  function parseNum(val: string): number | null {
    if (val === "") return null;
    const n = Number(val);
    return isNaN(n) ? null : n;
  }

  function parseIntVal(val: string): number | null {
    if (val === "") return null;
    const n = Number(val);
    return isNaN(n) ? null : Math.floor(n);
  }

  const isNumeric = typeCategory === "Number";
  const isString = typeCategory === "String";
  const isArray = typeCategory === "Structured" && fieldType === "array";
  const hasConstraints = isNumeric || isString || isArray;

  if (!hasConstraints) {
    return (
      <div className="py-space-2 text-body-small text-muted-foreground/60 italic">
        No validation constraints available for {fieldType} type.
      </div>
    );
  }

  // Pattern regex test
  const patternMatch = (() => {
    if (!validation.pattern || !patternSample) return null;
    try {
      const re = new RegExp(validation.pattern);
      return re.test(patternSample);
    } catch {
      return null;
    }
  })();

  return (
    <div className="space-y-space-4 pb-space-2">
      {/* Numeric constraints */}
      {isNumeric && (
        <>
          <div className="grid grid-cols-2 gap-space-4">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-caption text-muted-foreground">
                  Min Value
                </label>
                <label className="flex items-center gap-1 text-[10px] text-muted-foreground/70">
                  <input
                    type="checkbox"
                    checked={
                      validation.minValueExclusive != null &&
                      validation.minValue == null
                    }
                    onChange={(e) => {
                      if (e.target.checked) {
                        update({
                          minValueExclusive: validation.minValue ?? null,
                          minValue: null,
                        });
                      } else {
                        update({
                          minValue: validation.minValueExclusive ?? null,
                          minValueExclusive: null,
                        });
                      }
                    }}
                    className="accent-primary"
                  />
                  Exclusive
                </label>
              </div>
              <Input
                type="number"
                value={
                  (validation.minValueExclusive != null
                    ? validation.minValueExclusive
                    : validation.minValue) ?? ""
                }
                onChange={(e) => {
                  const val = parseNum(e.target.value);
                  if (
                    validation.minValueExclusive != null &&
                    validation.minValue == null
                  ) {
                    update({ minValueExclusive: val });
                  } else {
                    update({ minValue: val });
                  }
                }}
                className="h-7 text-body-small"
                placeholder="No minimum"
              />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-caption text-muted-foreground">
                  Max Value
                </label>
                <label className="flex items-center gap-1 text-[10px] text-muted-foreground/70">
                  <input
                    type="checkbox"
                    checked={
                      validation.maxValueExclusive != null &&
                      validation.maxValue == null
                    }
                    onChange={(e) => {
                      if (e.target.checked) {
                        update({
                          maxValueExclusive: validation.maxValue ?? null,
                          maxValue: null,
                        });
                      } else {
                        update({
                          maxValue: validation.maxValueExclusive ?? null,
                          maxValueExclusive: null,
                        });
                      }
                    }}
                    className="accent-primary"
                  />
                  Exclusive
                </label>
              </div>
              <Input
                type="number"
                value={
                  (validation.maxValueExclusive != null
                    ? validation.maxValueExclusive
                    : validation.maxValue) ?? ""
                }
                onChange={(e) => {
                  const val = parseNum(e.target.value);
                  if (
                    validation.maxValueExclusive != null &&
                    validation.maxValue == null
                  ) {
                    update({ maxValueExclusive: val });
                  } else {
                    update({ maxValue: val });
                  }
                }}
                className="h-7 text-body-small"
                placeholder="No maximum"
              />
            </div>
          </div>
        </>
      )}

      {/* String constraints */}
      {isString && (
        <>
          <div className="grid grid-cols-2 gap-space-4">
            <div>
              <label className="text-caption text-muted-foreground mb-1 block">
                @minLength
              </label>
              <Input
                type="number"
                value={validation.minLength ?? ""}
                onChange={(e) => update({ minLength: parseIntVal(e.target.value) })}
                className="h-7 text-body-small"
                placeholder="No minimum"
                min={0}
              />
            </div>
            <div>
              <label className="text-caption text-muted-foreground mb-1 block">
                @maxLength
              </label>
              <Input
                type="number"
                value={validation.maxLength ?? ""}
                onChange={(e) => update({ maxLength: parseIntVal(e.target.value) })}
                className="h-7 text-body-small"
                placeholder="No maximum"
                min={0}
              />
            </div>
          </div>

          {/* Pattern regex */}
          <div>
            <label className="text-caption text-muted-foreground mb-1 block">
              @pattern (regex)
            </label>
            <Input
              value={validation.pattern ?? ""}
              onChange={(e) =>
                update({ pattern: e.target.value || null })
              }
              className="h-7 text-body-small font-mono"
              placeholder="e.g. ^[A-Z]{2}-[0-9]+$"
            />
            {validation.pattern && (
              <div className="mt-1 flex items-center gap-2">
                <Input
                  value={patternSample}
                  onChange={(e) => setPatternSample(e.target.value)}
                  className="h-6 text-caption w-48"
                  placeholder="Test string…"
                />
                {patternSample && (
                  <span
                    className={`text-[10px] font-medium ${
                      patternMatch === null
                        ? "text-muted-foreground"
                        : patternMatch
                          ? "text-success"
                          : "text-destructive"
                    }`}
                  >
                    {patternMatch === null
                      ? "Invalid regex"
                      : patternMatch
                        ? "Match"
                        : "No match"}
                  </span>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {/* Array constraints */}
      {isArray && (
        <div className="grid grid-cols-2 gap-space-4">
          <div>
            <label className="text-caption text-muted-foreground mb-1 block">
              @minItems
            </label>
            <Input
              type="number"
              value={validation.minItems ?? ""}
              onChange={(e) => update({ minItems: parseIntVal(e.target.value) })}
              className="h-7 text-body-small"
              placeholder="No minimum"
              min={0}
            />
          </div>
          <div>
            <label className="text-caption text-muted-foreground mb-1 block">
              @maxItems
            </label>
            <Input
              type="number"
              value={validation.maxItems ?? ""}
              onChange={(e) => update({ maxItems: parseIntVal(e.target.value) })}
              className="h-7 text-body-small"
              placeholder="No maximum"
              min={0}
            />
          </div>
        </div>
      )}
    </div>
  );
}
