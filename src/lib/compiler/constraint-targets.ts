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

/** The range of the fixed-width integer scalars (BigInt, so the 64-bit limits are exact). */
const span = (min: string, max: string): readonly [bigint, bigint] => [BigInt(min), BigInt(max)];
const INTEGER_RANGES: Readonly<Record<string, readonly [bigint, bigint]>> = {
  int8: span("-128", "127"), int16: span("-32768", "32767"), int32: span("-2147483648", "2147483647"),
  int64: span("-9223372036854775808", "9223372036854775807"),
  uint8: span("0", "255"), uint16: span("0", "65535"), uint32: span("0", "4294967295"), uint64: span("0", "18446744073709551615"),
  safeint: span("-9007199254740991", "9007199254740991"),
};

export type BoundKind = "min" | "max" | "minExclusive" | "maxExclusive";

/**
 * The numeric bound as the decorator should carry it for a field of `type`, or null when it should not be written.
 *
 * On an integer type the compiler rejects a fractional bound (`@maxValue(10.5)` on int32: "not assignable"), so a fractional bound is
 * moved to the integer that means the same (`<= 10.5` is `<= 10`, `> 10.5` is `> 10`). On a fixed-width integer a bound OUTSIDE the
 * range says nothing the type does not already say and breaks the compile too: JSON has no 64-bit integers, so
 * `"maximum": 9223372036854775807` is read as the double 2^63, written `@maxValue(9223372036854776000)`, and rejected for int64. A bound
 * exactly at the limit, tighter than the type, or on a type without an integer rule is kept as is.
 */
export function boundFor(type: string, kind: BoundKind, bound: number): number | null {
  const range = INTEGER_RANGES[type];
  if (!Number.isFinite(bound) || (!range && type !== "integer")) return bound;
  const whole = Number.isInteger(bound)
    ? bound
    : kind === "max" ? Math.floor(bound) : kind === "min" ? Math.ceil(bound) : kind === "maxExclusive" ? Math.ceil(bound) : Math.floor(bound);
  if (!range) return whole;
  // Judge the decimal text the decorator will carry (2^63 prints as 9223372036854776000, which is beyond int64), not the double itself.
  const printed = String(whole);
  const value = /^-?\d+$/.test(printed) ? BigInt(printed) : BigInt(Math.trunc(whole));
  // Outside the range in EITHER direction is dropped: an upper bound below the minimum and a lower bound above the maximum (hostile
  // input) are just as unassignable to the type as one beyond the far end.
  return value > range[1] || value < range[0] ? null : whole;
}

const BOUND_KIND_OF: Readonly<Record<string, BoundKind>> = {
  minValue: "min", maxValue: "max", minValueExclusive: "minExclusive", maxValueExclusive: "maxExclusive",
};

/**
 * True when the generator writes NO decorator for this stored validator on a field of `type` (the validator does not apply to the
 * type, or the bound is outside the integer range). The value is still stored; the TypeSpec text just cannot show it.
 */
export function isConstraintWithheld(type: string, kind: ConstraintKind, value: unknown): boolean {
  if (!constraintAppliesTo(type, kind)) return true;
  const boundKind = BOUND_KIND_OF[kind];
  return boundKind !== undefined && typeof value === "number" && boundFor(type, boundKind, value) === null;
}

/** True when `kind` is valid on a field of logical `type`. A type the catalog does not know (a custom scalar) is not second-guessed. */
export function constraintAppliesTo(type: string, kind: ConstraintKind): boolean {
  if (kind === "minItems" || kind === "maxItems") return type === "array";
  if (NON_SCALAR.has(type)) return false;
  const root = kind === "minLength" || kind === "maxLength" || kind === "pattern" ? "string" : "numeric";
  return derivesFrom(type, root) ?? true;
}
