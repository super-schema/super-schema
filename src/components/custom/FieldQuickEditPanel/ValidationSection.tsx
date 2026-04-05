"use client";

import { Input } from "@/components/ui/input";
import { getTypeInfo } from "@/lib/data-types";

interface ValidationValues {
  minValue?: number | null;
  maxValue?: number | null;
  minLength?: number | null;
  maxLength?: number | null;
  pattern?: string | null;
  minItems?: number | null;
  maxItems?: number | null;
}

interface ValidationSectionProps {
  type: string;
  values: ValidationValues;
  isReadOnly?: boolean;
  onChange: (field: string, value: unknown) => void;
}

function parseNum(val: string): number | null {
  if (!val.trim()) return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

export function ValidationSection({
  type,
  values,
  isReadOnly = false,
  onChange,
}: ValidationSectionProps) {
  const typeInfo = getTypeInfo(type);
  const category = typeInfo?.category ?? "String";

  // Numeric types
  if (category === "Number") {
    return (
      <div className="space-y-space-3">
        <div className="grid grid-cols-2 gap-space-2">
          <div>
            <label className="text-caption text-muted-foreground mb-1 block">Min Value</label>
            <Input
              type="number"
              value={values.minValue ?? ""}
              onChange={(e) => onChange("minValue", parseNum(e.target.value))}
              placeholder="--"
              className="h-8 text-body-small font-mono"
              disabled={isReadOnly}
            />
          </div>
          <div>
            <label className="text-caption text-muted-foreground mb-1 block">Max Value</label>
            <Input
              type="number"
              value={values.maxValue ?? ""}
              onChange={(e) => onChange("maxValue", parseNum(e.target.value))}
              placeholder="--"
              className="h-8 text-body-small font-mono"
              disabled={isReadOnly}
            />
          </div>
        </div>
      </div>
    );
  }

  // String types
  if (category === "String") {
    return (
      <div className="space-y-space-3">
        <div className="grid grid-cols-2 gap-space-2">
          <div>
            <label className="text-caption text-muted-foreground mb-1 block">Min Length</label>
            <Input
              type="number"
              value={values.minLength ?? ""}
              onChange={(e) => onChange("minLength", parseNum(e.target.value))}
              placeholder="--"
              className="h-8 text-body-small font-mono"
              disabled={isReadOnly}
            />
          </div>
          <div>
            <label className="text-caption text-muted-foreground mb-1 block">Max Length</label>
            <Input
              type="number"
              value={values.maxLength ?? ""}
              onChange={(e) => onChange("maxLength", parseNum(e.target.value))}
              placeholder="--"
              className="h-8 text-body-small font-mono"
              disabled={isReadOnly}
            />
          </div>
        </div>
        <div>
          <label className="text-caption text-muted-foreground mb-1 block">Pattern (Regex)</label>
          <Input
            value={values.pattern ?? ""}
            onChange={(e) => onChange("pattern", e.target.value || null)}
            placeholder="^[a-zA-Z]+$"
            className="h-8 text-body-small font-mono"
            disabled={isReadOnly}
          />
        </div>
      </div>
    );
  }

  // Array / Structured
  if (type === "array") {
    return (
      <div className="space-y-space-3">
        <div className="grid grid-cols-2 gap-space-2">
          <div>
            <label className="text-caption text-muted-foreground mb-1 block">Min Items</label>
            <Input
              type="number"
              value={values.minItems ?? ""}
              onChange={(e) => onChange("minItems", parseNum(e.target.value))}
              placeholder="--"
              className="h-8 text-body-small font-mono"
              disabled={isReadOnly}
            />
          </div>
          <div>
            <label className="text-caption text-muted-foreground mb-1 block">Max Items</label>
            <Input
              type="number"
              value={values.maxItems ?? ""}
              onChange={(e) => onChange("maxItems", parseNum(e.target.value))}
              placeholder="--"
              className="h-8 text-body-small font-mono"
              disabled={isReadOnly}
            />
          </div>
        </div>
      </div>
    );
  }

  // Default: no validation controls available for this type
  return (
    <p className="text-caption text-muted-foreground/60 italic">
      No validation rules applicable for type &ldquo;{type}&rdquo;.
    </p>
  );
}
