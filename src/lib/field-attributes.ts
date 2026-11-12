import { getTypeInfo } from "@/lib/data-types";
import {
  constraintAppliesTo,
  type ConstraintKind,
} from "@/lib/compiler/constraint-targets";
/** Shared field authoring semantics. No database or framework dependencies. */
import type {
  TypeSpecDecorators,
  ValidationConstraints,
} from "@/types/schemas/typespec-decorator.schema";

export const FIELD_ATTRIBUTE_SECTIONS = [
  "Properties",
  "Documentation",
  "Validation",
  "Data Quality",
  "Data Governance",
  "Lifecycle Visibility",
  "Serialization",
  "Storage Hints",
  "Extensions",
  "Schema Evolution",
] as const;
export const LIFECYCLE_PHASES = [
  "Create",
  "Read",
  "Update",
  "Delete",
  "Query",
] as const;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
type DocumentedField = { description?: string | null; decorators?: unknown };
export function fieldDescription(field: DocumentedField): string {
  const docs = record(record(record(field.decorators).typespec).documentation);
  return (
    [field.description, docs.doc, docs.summary].find(
      (v): v is string => typeof v === "string" && Boolean(v.trim()),
    ) ?? ""
  );
}

/** Retire duplicate attributes without losing text. An explicitly supplied description, including empty, wins. */
export function normalizeFieldDocumentation(
  field: DocumentedField,
  description = fieldDescription(field),
) {
  const decorators = { ...record(field.decorators) };
  const typespec = { ...record(decorators.typespec) };
  const documentation = { ...record(typespec.documentation) };
  const previous = Array.isArray(decorators.legacyDocumentation)
    ? [...decorators.legacyDocumentation]
    : [];
  for (const key of ["doc", "summary"] as const) {
    const text = documentation[key];
    if (
      typeof text === "string" &&
      text.trim() &&
      text !== description &&
      !previous.some(
        (entry) => record(entry).source === key && record(entry).text === text,
      )
    ) {
      previous.push({ source: key, text });
    }
    delete documentation[key];
  }
  if (previous.length) decorators.legacyDocumentation = previous;
  if (Object.keys(documentation).length) typespec.documentation = documentation;
  else delete typespec.documentation;
  if (Object.keys(typespec).length || decorators.typespec !== undefined)
    decorators.typespec = typespec;
  return { description, decorators };
}

/** An explicit panel value overrides a legacy imported deprecation flag, including an explicit clear. */
export function fieldDeprecation(decorators: unknown): string | null {
  const root = record(decorators);
  const documentation = record(record(root.typespec).documentation);
  if (Object.hasOwn(documentation, "deprecated"))
    return typeof documentation.deprecated === "string"
      ? documentation.deprecated
      : null;
  return record(root.evolution).deprecated === true ? "deprecated" : null;
}

export function fieldPresence(field: {
  nullable: boolean;
  isKey?: boolean;
  decorators?: unknown;
}) {
  const decorators = record(field.decorators);
  const allowNull =
    !field.isKey && field.nullable && decorators.nullableType === true;
  return {
    optional:
      !field.isKey &&
      field.nullable &&
      !(allowNull && decorators.requiredNullable === true),
    allowNull,
  };
}
export function storeFieldPresence(
  optional: boolean,
  allowNull: boolean,
  original: Record<string, unknown>,
) {
  const decorators = { ...original };
  delete decorators.nullableType;
  delete decorators.requiredNullable;
  if (allowNull) {
    decorators.nullableType = true;
    if (!optional) decorators.requiredNullable = true;
  }
  return { nullable: optional || allowNull, decorators };
}

/** Cross-attribute checks shared by both editors and the server write path. */
export function fieldAttributeErrors(input: {
  type?: string;
  precision?: number | null;
  scale?: number | null;
  fieldNumber?: number | null;
  decorators?: unknown;
}): string[] {
  const errors: string[] = [];
  const ts = record(record(input.decorators).typespec) as TypeSpecDecorators;
  const v: ValidationConstraints = ts.validation ?? {};
  const minExclusive =
    v.minValueExclusive != null &&
    (v.minValue == null || v.minValueExclusive >= v.minValue);
  const maxExclusive =
    v.maxValueExclusive != null &&
    (v.maxValue == null || v.maxValueExclusive <= v.maxValue);
  const numericMin = minExclusive ? v.minValueExclusive : v.minValue;
  const numericMax = maxExclusive ? v.maxValueExclusive : v.maxValue;
  for (const [min, max, label] of [
    [numericMin, numericMax, "Value"],
    [v.minLength, v.maxLength, "Length"],
    [v.minItems, v.maxItems, "Item count"],
  ] as const) {
    if (
      min != null &&
      max != null &&
      (min > max ||
        (label === "Value" && min === max && (minExclusive || maxExclusive)))
    )
      errors.push(
        `${label} minimum must be less than or equal to its maximum; exclusive bounds must leave a nonempty range.`,
      );
  }
  for (const key of [
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
  ] as const) {
    if (v[key] != null && (!Number.isInteger(v[key]) || v[key]! < 0))
      errors.push(`${key} must be a nonnegative whole number.`);
  }
  if (input.type !== "enum" && v.pattern) {
    try {
      new RegExp(v.pattern);
    } catch {
      errors.push("Pattern must be a valid regular expression.");
    }
  }
  if (
    input.precision != null &&
    (!Number.isInteger(input.precision) || input.precision < 1)
  )
    errors.push("Precision must be a positive whole number.");
  if (
    input.scale != null &&
    (!Number.isInteger(input.scale) ||
      input.scale < 0 ||
      (input.precision != null && input.scale > input.precision))
  )
    errors.push(
      "Scale must be a nonnegative whole number no greater than precision.",
    );
  const number = input.fieldNumber;
  if (
    number != null &&
    (!Number.isInteger(number) ||
      number < 1 ||
      number > 536870911 ||
      (number >= 19000 && number <= 19999))
  )
    errors.push(
      "Protobuf field number must be 1–536870911, excluding reserved numbers 19000–19999.",
    );
  const docs = ts.documentation;
  if (docs?.externalDocsUrl) {
    try {
      if (!["https:", "http:"].includes(new URL(docs.externalDocsUrl).protocol))
        throw new Error();
    } catch {
      errors.push(
        "External documentation must use an absolute HTTP or HTTPS URL.",
      );
    }
  }
  if (
    ts.identity?.discriminator &&
    input.type &&
    !["string", "url"].includes(input.type)
  )
    errors.push("An entity discriminator must be a string property.");
  const evolution = ts.versioning;
  if (evolution?.renamedFrom && !evolution.renamedFrom.oldName.trim())
    errors.push("Enter the previous field name for the rename annotation.");
  if (
    evolution?.typeChangedFrom &&
    !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(evolution.typeChangedFrom.oldType)
  )
    errors.push("Previous type must be a valid TypeSpec type name.");
  if (
    evolution?.added &&
    evolution.removed &&
    evolution.added.localeCompare(evolution.removed, undefined, {
      numeric: true,
    }) >= 0
  )
    errors.push("Removed version must be later than added version.");
  return errors;
}

export function evolutionVersions(
  fields: { decorators?: unknown }[],
): string[] {
  const versions = new Set<string>();
  for (const field of fields) {
    const v = record(record(record(field.decorators).typespec).versioning);
    for (const key of [
      "added",
      "removed",
      "madeOptional",
      "madeRequired",
      "renamedFrom",
      "typeChangedFrom",
    ]) {
      const value =
        typeof v[key] === "string" ? v[key] : record(v[key]).version;
      if (typeof value === "string" && value.trim()) versions.add(value);
    }
  }
  return [...versions].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
}

/** Authoring feedback for example/default values; leaves stored values unchanged. */
export function valueConstraintErrors(
  value: unknown,
  fieldType: string,
  validation: ValidationConstraints = {},
): string[] {
  if (value == null) return [];
  const errors: string[] = [];
  if (
    getTypeInfo(fieldType)?.category === "Number" &&
    (typeof value === "number" || typeof value === "string")
  ) {
    const numeric =
      typeof value === "string" && /^[+-]?\d+$/.test(value)
        ? BigInt(value)
        : Number(value);
    if (typeof numeric === "bigint" || Number.isFinite(numeric)) {
      if (validation.minValue != null && numeric < validation.minValue)
        errors.push(`Value must be at least ${validation.minValue}.`);
      if (validation.maxValue != null && numeric > validation.maxValue)
        errors.push(`Value must be at most ${validation.maxValue}.`);
      if (
        validation.minValueExclusive != null &&
        numeric <= validation.minValueExclusive
      )
        errors.push(
          `Value must be greater than ${validation.minValueExclusive}.`,
        );
      if (
        validation.maxValueExclusive != null &&
        numeric >= validation.maxValueExclusive
      )
        errors.push(`Value must be less than ${validation.maxValueExclusive}.`);
    }
  }
  if (["string", "url"].includes(fieldType) && typeof value === "string") {
    const length = Array.from(value).length;
    if (validation.minLength != null && length < validation.minLength)
      errors.push(
        `Value must contain at least ${validation.minLength} characters.`,
      );
    if (validation.maxLength != null && length > validation.maxLength)
      errors.push(
        `Value must contain at most ${validation.maxLength} characters.`,
      );
    if (validation.pattern) {
      try {
        if (!new RegExp(validation.pattern).test(value))
          errors.push("Value does not match the configured pattern.");
      } catch {
        /* Invalid rules are reported by fieldAttributeErrors. */
      }
    }
  }
  if (Array.isArray(value)) {
    if (validation.minItems != null && value.length < validation.minItems)
      errors.push(`Value must contain at least ${validation.minItems} items.`);
    if (validation.maxItems != null && value.length > validation.maxItems)
      errors.push(`Value must contain at most ${validation.maxItems} items.`);
  }
  return errors;
}

/** The TypeSpec decorator each stored validator is written as. The keys are the ValidationConstraints keys. */
export const VALIDATION_DECORATORS: Readonly<Record<ConstraintKind, string>> = {
  minValue: "@minValue",
  maxValue: "@maxValue",
  minValueExclusive: "@minValueExclusive",
  maxValueExclusive: "@maxValueExclusive",
  minLength: "@minLength",
  maxLength: "@maxLength",
  pattern: "@pattern",
  minItems: "@minItems",
  maxItems: "@maxItems",
};

/** Validators TypeSpec accepts for `fieldType` and the emitter writes (the same rule the TypeSpec generator uses). */
export function applicableValidationKeys(fieldType: string): ConstraintKind[] {
  return (Object.keys(VALIDATION_DECORATORS) as ConstraintKind[]).filter((kind) =>
    constraintAppliesTo(fieldType, kind),
  );
}

function storedValidationKeys(validation: ValidationConstraints | null | undefined): ConstraintKind[] {
  const stored = (validation ?? {}) as Record<string, unknown>;
  return (Object.keys(VALIDATION_DECORATORS) as ConstraintKind[]).filter(
    (kind) => stored[kind] != null && stored[kind] !== "",
  );
}

/** Stored validators that apply to `fieldType`. This is what the Validation summary counts. */
export function activeValidationKeys(
  validation: ValidationConstraints | null | undefined,
  fieldType: string,
): ConstraintKind[] {
  const applicable = new Set(applicableValidationKeys(fieldType));
  return storedValidationKeys(validation).filter((kind) => applicable.has(kind));
}

/** Stored validators that do not apply to `fieldType`. They stay in the data but TypeSpec never writes them. */
export function staleValidationKeys(
  validation: ValidationConstraints | null | undefined,
  fieldType: string,
): ConstraintKind[] {
  const applicable = new Set(applicableValidationKeys(fieldType));
  return storedValidationKeys(validation).filter((kind) => !applicable.has(kind));
}

/** One line explaining why no validator applies to `fieldType`. */
export function validationNotApplicableReason(fieldType: string): string {
  const category = getTypeInfo(fieldType)?.category;
  if (fieldType === "enum")
    return "Enum fields have no TypeSpec validators. Their allowed values are the enum values under Properties.";
  if (fieldType === "boolean") return "Boolean fields have no TypeSpec validators.";
  if (fieldType === "bytes")
    return "Bytes fields have no validators here. TypeSpec accepts @pattern on bytes, but this editor does not write it.";
  if (category === "Date & Time")
    return "Date and time bounds are not offered yet. TypeSpec accepts @minValue and @maxValue on these types, but this editor does not write them.";
  if (fieldType === "object")
    return "Object fields have no TypeSpec validators. Constrain their properties instead.";
  if (fieldType === "map") return "Map fields have no TypeSpec validators here.";
  if (fieldType === "reference") return "Reference fields have no validators here.";
  return "No TypeSpec validators apply to this type.";
}

/**
 * The enum symbols a legacy `pattern` holds (`A|B|C`) when it is a symbol list rather than a regular expression. The
 * TypeSpec generator reads them when an enum has no aliases; keep REGEX_CONSTRUCT in sync with typespec-generator.ts.
 */
const LEGACY_ENUM_REGEX_CONSTRUCT = /^\^|\$$|\\[dDwWsSbB]|[[\]()]|\.[*+]|\{\d/;
export function legacyEnumSymbols(pattern: string | null | undefined): string[] {
  if (!pattern || LEGACY_ENUM_REGEX_CONSTRUCT.test(pattern)) return [];
  return pattern.split("|").filter(Boolean);
}
