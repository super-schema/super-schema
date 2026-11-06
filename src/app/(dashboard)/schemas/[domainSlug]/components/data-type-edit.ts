/**
 * The edit forms of shared scalars and enums (pure): what the form shows for a stored asset, and the update a filled-in form sends.
 * Kept out of the component so the rules (which bounds apply to which base type, number parsing, min <= max) are unit tested.
 */
import { constraintAppliesTo } from "@/lib/compiler/constraint-targets";
import { SCALAR_CONSTRAINT_KEYS, type ScalarConstraintKey, type ScalarConstraints } from "@/lib/importers/scalar-asset";

/** Base types a scalar can extend from the form (the stored one is always offered too, see `baseTypeOptions`). */
export const SCALAR_BASE_TYPES = [
  "string", "url", "int32", "int64", "safeint", "float32", "float64", "decimal", "boolean",
  "utcDateTime", "offsetDateTime", "plainDate", "plainTime", "duration", "bytes",
] as const;

export const CONSTRAINT_LABELS: Record<ScalarConstraintKey, string> = {
  minLength: "Min length",
  maxLength: "Max length",
  minValue: "Minimum",
  maxValue: "Maximum",
  minValueExclusive: "Minimum (exclusive)",
  maxValueExclusive: "Maximum (exclusive)",
};

export interface ScalarFormValue {
  description: string;
  baseType: string;
  format: string;
  pattern: string;
  /** Raw text of each bound input ("" = none). */
  bounds: Record<ScalarConstraintKey, string>;
}

export interface ScalarSource {
  description: string;
  baseType: string;
  logicalType?: string | null;
  format: string | null;
  pattern: string | null;
  constraints?: ScalarConstraints;
}

export function baseTypeOptions(current: string): string[] {
  return (SCALAR_BASE_TYPES as readonly string[]).includes(current) ? [...SCALAR_BASE_TYPES] : [current, ...SCALAR_BASE_TYPES];
}

/** The type the bounds are judged against: the logical type a field using the scalar gets (the base type when it was changed). */
function judgedType(form: ScalarFormValue, source: ScalarSource): string {
  return form.baseType === source.baseType && source.logicalType ? source.logicalType : form.baseType;
}

/** Whether a bound (or `pattern`) can be written for the scalar's type; the form disables the ones that cannot. */
export function boundApplies(form: ScalarFormValue, source: ScalarSource, key: ScalarConstraintKey | "pattern"): boolean {
  return constraintAppliesTo(judgedType(form, source), key);
}

export function scalarFormFrom(source: ScalarSource): ScalarFormValue {
  const bounds = Object.fromEntries(SCALAR_CONSTRAINT_KEYS.map((k) => [k, source.constraints?.[k] === undefined ? "" : String(source.constraints[k])])) as Record<ScalarConstraintKey, string>;
  return { description: source.description, baseType: source.baseType, format: source.format ?? "", pattern: source.pattern ?? "", bounds };
}

export type ScalarUpdate = {
  description: string;
  baseType: string;
  logicalType: string | null;
  format: string | null;
  pattern: string | null;
  constraints: ScalarConstraints | null;
};

/**
 * The update a filled-in scalar form sends, or the first problem with it. A bound that does not apply to the type is dropped (the form
 * disables it, so this only happens after the base type was changed); the logical type is kept while the base type is.
 */
export function scalarUpdateFrom(form: ScalarFormValue, source: ScalarSource): { ok: true; update: ScalarUpdate } | { ok: false; error: string } {
  const constraints: ScalarConstraints = {};
  for (const key of SCALAR_CONSTRAINT_KEYS) {
    const raw = form.bounds[key].trim();
    if (raw === "" || !boundApplies(form, source, key)) continue;
    const value = Number(raw);
    if (!Number.isFinite(value)) return { ok: false, error: `${CONSTRAINT_LABELS[key]} must be a number` };
    if ((key === "minLength" || key === "maxLength") && (!Number.isInteger(value) || value < 0)) {
      return { ok: false, error: `${CONSTRAINT_LABELS[key]} must be a whole number of 0 or more` };
    }
    constraints[key] = value;
  }
  const pairs: Array<[ScalarConstraintKey, ScalarConstraintKey]> = [["minLength", "maxLength"], ["minValue", "maxValue"], ["minValueExclusive", "maxValueExclusive"]];
  for (const [lo, hi] of pairs) {
    if (constraints[lo] !== undefined && constraints[hi] !== undefined && constraints[lo]! > constraints[hi]!) {
      return { ok: false, error: `${CONSTRAINT_LABELS[lo]} is greater than ${CONSTRAINT_LABELS[hi].toLowerCase()}` };
    }
  }
  const pattern = form.pattern.trim();
  if (pattern !== "") {
    if (!boundApplies(form, source, "pattern")) return { ok: false, error: `A pattern cannot be set on ${form.baseType}` };
    try {
      new RegExp(pattern);
    } catch {
      return { ok: false, error: "Pattern is not a valid regular expression" };
    }
  }
  return {
    ok: true,
    update: {
      description: form.description.trim(),
      baseType: form.baseType,
      logicalType: form.baseType === source.baseType ? (source.logicalType ?? null) : null,
      format: form.format.trim() || null,
      pattern: pattern || null,
      constraints: Object.keys(constraints).length > 0 ? constraints : null,
    },
  };
}

/** The enum update of its edit form: the description and one description per symbol (blank ones dropped; none at all = null). */
export function enumUpdateFrom(
  values: readonly string[],
  form: { description: string; valueDescriptions: Record<string, string> },
): { description: string; valueDescriptions: Record<string, string> | null } {
  const kept: Record<string, string> = {};
  for (const symbol of values) {
    const text = form.valueDescriptions[symbol]?.trim();
    if (text) kept[symbol] = text;
  }
  return { description: form.description.trim(), valueDescriptions: Object.keys(kept).length > 0 ? kept : null };
}

/** "Saved" toast text, naming the fields that followed the edit. */
export function savedMessage(kind: "Enum" | "Scalar", name: string, updatedFields: number | undefined): string {
  const n = updatedFields ?? 0;
  return n > 0 ? `${kind} "${name}" saved · ${n} field${n === 1 ? "" : "s"} updated` : `${kind} "${name}" saved`;
}
