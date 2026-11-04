/**
 * Shared custom scalars (pure).
 *
 * A scalar is a domain-level asset (`CustomScalar`): a base type plus the validation a schema put on it. A field that uses one has the scalar's
 * type, format and constraints COPIED onto it (so every renderer keeps working with no knowledge of scalars) and `decorators.scalarName` records
 * the link: editing the scalar re-applies it to every field that carries that name (`applyScalarToField`).
 */
import type { ParsedFieldConstraint, ParsedScalar } from "./types";

/** The validators a scalar can carry besides `pattern` (a column of its own). */
export const SCALAR_CONSTRAINT_KEYS = ["minLength", "maxLength", "minValue", "maxValue", "minValueExclusive", "maxValueExclusive"] as const;
export type ScalarConstraintKey = (typeof SCALAR_CONSTRAINT_KEYS)[number];
export type ScalarConstraints = Partial<Record<ScalarConstraintKey, number>>;

/** What a scalar row stores. */
export interface ScalarFacts {
  baseType: string;
  logicalType?: string | null;
  format?: string | null;
  pattern?: string | null;
  constraints?: unknown;
}

/** The columns a parsed scalar is stored in. */
export function scalarRowFromParsed(s: ParsedScalar & { pattern?: string }): {
  name: string;
  baseType: string;
  logicalType: string | null;
  format: string | null;
  pattern: string | null;
  constraints: ScalarConstraints | null;
  description: string;
} {
  const constraints: ScalarConstraints = {};
  let pattern: string | null = s.pattern ?? null;
  for (const c of s.constraints ?? []) {
    if (c.type === "pattern") pattern = String(c.value);
    else if ((SCALAR_CONSTRAINT_KEYS as readonly string[]).includes(c.type) && typeof c.value === "number") constraints[c.type as ScalarConstraintKey] = c.value;
  }
  if (s.minValueExclusive !== undefined) constraints.minValueExclusive = s.minValueExclusive;
  if (s.maxValueExclusive !== undefined) constraints.maxValueExclusive = s.maxValueExclusive;
  return {
    name: s.name,
    baseType: s.baseType,
    logicalType: s.logicalType ?? null,
    format: s.format ?? null,
    pattern,
    constraints: Object.keys(constraints).length > 0 ? constraints : null,
    description: s.description ?? "",
  };
}

/** The constraints column as numbers only (it comes from stored JSON). */
export function readScalarConstraints(value: unknown): ScalarConstraints {
  const out: ScalarConstraints = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const key of SCALAR_CONSTRAINT_KEYS) {
    const v = (value as Record<string, unknown>)[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
  }
  return out;
}

/** The scalar's validators as a field's `typespec.validation` entries. */
export function scalarValidation(facts: ScalarFacts): Record<string, number | string> {
  const out: Record<string, number | string> = { ...readScalarConstraints(facts.constraints) };
  if (facts.pattern) out.pattern = facts.pattern;
  return out;
}

/** Logical type a field using the scalar gets. */
export function scalarFieldType(facts: ScalarFacts): string {
  return facts.logicalType || facts.baseType;
}

/** Constraint list in the importer's shape (for a ParsedScalar built from a stored row). */
export function scalarConstraintList(facts: ScalarFacts): ParsedFieldConstraint[] {
  return Object.entries(scalarValidation(facts)).map(([type, value]) => ({ type, value }));
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * The field once it uses `scalar` (pure): its type, `typespec.identity.format` and `typespec.validation` come from the scalar, every other
 * decorator stays. An array of scalars takes the element type only. Validators the scalar does not carry are removed from the field's
 * validation (the scalar is the single source), so editing the scalar to drop a bound drops it everywhere.
 */
export function applyScalarToField(
  field: { type: string; decorators?: Json },
  name: string,
  scalar: ScalarFacts,
  isElement: boolean,
): { type: string; decorators: Json } {
  const decorators: Json = { ...(field.decorators ?? {}), scalarName: name };
  const logical = scalarFieldType(scalar);
  if (isElement) return { type: field.type, decorators: { ...decorators, arrayElementType: logical } };
  const typespec: Json = isObject(decorators.typespec) ? { ...decorators.typespec } : {};
  const identity: Json = isObject(typespec.identity) ? { ...typespec.identity } : {};
  if (scalar.format) identity.format = scalar.format;
  else delete identity.format;
  if (Object.keys(identity).length > 0) typespec.identity = identity;
  else delete typespec.identity;
  const validation: Json = isObject(typespec.validation) ? { ...typespec.validation } : {};
  for (const key of [...SCALAR_CONSTRAINT_KEYS, "pattern"]) delete validation[key];
  Object.assign(validation, scalarValidation(scalar));
  if (Object.keys(validation).length > 0) typespec.validation = validation;
  else delete typespec.validation;
  if (Object.keys(typespec).length > 0) decorators.typespec = typespec;
  else delete decorators.typespec;
  return { type: logical, decorators };
}
