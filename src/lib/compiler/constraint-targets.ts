/**
 * Which validators the real TypeSpec compiler accepts on a field of a given logical type (checked against the compiler):
 * `@minLength` / `@maxLength` / `@pattern` only on `string` and what extends it (url); `@minValue*` / `@maxValue*` only on a numeric
 * scalar; `@minItems` / `@maxItems` only on an array. Anything else is a decorator-wrong-target error.
 *
 * The generator withholds a validator that does not apply (the stored decorators keep it), and the importer reports it.
 */
import { getTypeInfo } from "@/lib/data-types";

export type ConstraintKind =
  | "minLength" | "maxLength" | "pattern"
  | "minValue" | "maxValue" | "minValueExclusive" | "maxValueExclusive"
  | "minItems" | "maxItems";

/** Logical types that are not scalars: no string or numeric validator applies to them. */
const NON_SCALAR = new Set(["array", "map", "object", "reference", "union", "enum", "model", "Record"]);

function derivesFrom(type: string, root: string): boolean | undefined {
  let info = getTypeInfo(type);
  if (!info) return undefined;
  for (let hops = 0; info && hops < 16; hops++) {
    if (info.id === root) return true;
    info = info.parent ? getTypeInfo(info.parent) : undefined;
  }
  return false;
}

/** True when `kind` is valid on a field of logical `type`. A type the catalog does not know (a custom scalar) is not second-guessed. */
export function constraintAppliesTo(type: string, kind: ConstraintKind): boolean {
  if (kind === "minItems" || kind === "maxItems") return type === "array";
  if (NON_SCALAR.has(type)) return false;
  const root = kind === "minLength" || kind === "maxLength" || kind === "pattern" ? "string" : "numeric";
  return derivesFrom(type, root) ?? true;
}
