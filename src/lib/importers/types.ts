/**
 * Shared types for the schema import pipeline.
 *
 * These types are used by all importers (Avro, BigQuery DDL, Protobuf)
 * and by the drift detection engine (Story 9.2).
 */

// ---------------------------------------------------------------------------
// Import format enum
// ---------------------------------------------------------------------------

export type ImportFormat =
  | "avro"
  | "bigquery-ddl"
  | "protobuf"
  | "typespec"
  | "json-schema"
  | "openapi";

// ---------------------------------------------------------------------------
// Confidence levels for type mappings
// ---------------------------------------------------------------------------

export type ImportConfidence = "high" | "medium" | "low";

// ---------------------------------------------------------------------------
// A single parsed field from an imported schema
// ---------------------------------------------------------------------------

export interface ParsedFieldConstraint {
  type: string;
  value: number | string;
}

export interface ParsedField {
  /** Field name as it appears in the source schema */
  name: string;
  /** Mapped logical type (from SuperSchemaModel LogicalType) */
  type: string;
  /** Whether the field is nullable: its column may be NULL / the property may be absent (optional) or hold null (see `nullableType`) */
  nullable: boolean;
  /**
   * The VALUE may be null (JSON Schema `type: [T, "null"]` / `anyOf` with `{ type: "null" }`, TypeSpec `T | null`), as opposed to the
   * property being optional (absent). Always together with `nullable: true`; written as `T | null` in the TypeSpec text.
   */
  nullableType?: boolean;
  /** The property must be present although its value may be null (`required` + a null type): `a: T | null`, no `?`. Only with `nullableType`. */
  requiredNullable?: boolean;
  /** Description extracted from the source schema */
  description?: string;
  /** Protobuf field number (preserved for proto imports) */
  fieldNumber?: number;
  /** Confidence in the type mapping */
  confidence: ImportConfidence;
  /** The original type string from the source format */
  originalType: string;
  /** Whether this field is a key field (TypeSpec @key) */
  isKey?: boolean;
  /** Classification level (e.g. PII, SENSITIVE, INTERNAL) */
  classification?: string;
  /** Format hint (e.g. email, uri, uuid) */
  format?: string;
  /** Whether the field is deprecated */
  deprecated?: boolean;
  /** Deprecation message */
  deprecatedMessage?: string;
  /** Declared precision of a decimal (BigQuery `NUMERIC(12, 2)`, Avro `decimal`): the digits in all. Absent when the source declares none. */
  precision?: number;
  /** Declared scale of a decimal: the digits after the point (0 when the source gives a precision alone). */
  scale?: number;
  /** Validation constraints (minLength, maxLength, etc.) */
  constraints?: ParsedFieldConstraint[];
  /** Summary text (@summary decorator) */
  summary?: string;
  /** Visibility phases (Lifecycle.Read, Lifecycle.Create, etc.) */
  visibility?: string[];
  /** Wire format encoding (@encode) */
  encode?: string;
  /** Wire format encoding sub-type (@encode second arg) */
  encodeSubType?: string;
  /** Exclusive min/max bounds */
  minValueExclusive?: number;
  maxValueExclusive?: number;
  /** Extension key-value pairs (@extension) */
  extensions?: Record<string, unknown>;
  /** Whether @secret was applied */
  secret?: boolean;
  /** Discriminator field name */
  discriminator?: string;
  /** Target entity name for a reference field (from a JSON Schema $ref) */
  referencedEntityName?: string;
  /** Array element logical type (e.g. "string", or "reference" for an array of refs) */
  arrayElementType?: string;
  /** Map key logical type (`map` fields) */
  mapKeyType?: string;
  /** Map value logical type (`map` fields; "reference" + referencedEntityName for a map of entities) */
  mapValueType?: string;
  /** Shared enum this `enum` field uses (an imported `ParsedEnum` name) */
  enumName?: string;
  /** Enum symbols of an `enum` field */
  enumValues?: string[];
  /** Union this `union` field (or the element of an array of unions) uses — an imported `ParsedUnion` name */
  unionName?: string;
  /** Member type names of that union, kept on the field so it stays valid when the union itself is not declared */
  unionMembers?: string[];
  /**
   * Set when the field points at a `$ref` target that could not be loaded (URL import): the field keeps a low-confidence
   * reference by best-effort name. `ref` is the raw `$ref`, `resolvedUri` its absolute URI when computable.
   */
  danglingRef?: { ref: string; resolvedUri?: string; reason: string; /** True when the reference is the ITEM type of an array field. */ element?: true };
  /** Format-binding facts kept under `decorators.governance` (same keys the TypeSpec governance path stores) */
  governance?: ParsedFieldGovernance;
  /**
   * Standard schema keywords present on this field's source node that the importer recognizes but does NOT map to
   * anything in the IR (JSON Schema: `not`, `if`, `multipleOf`, ...). Vendor / unknown keys are not listed here —
   * they are kept in `extensions`.
   */
  ignoredKeywords?: string[];
}

/** Entity name the JSON Schema importer falls back to when the document gives no `title` / `$id` to name it by. */
export const IMPORTED_ENTITY_FALLBACK_NAME = "ImportedEntity";

export interface ParsedFieldGovernance {
  /** Protobuf `oneof` group this field belongs to */
  protobufOneofGroup?: string;
  /** Avro `fixed` byte size */
  avroFixedSize?: number;
  /** Raw data class from the vendor classification block (before the value map; `classification` holds the mapped level) */
  dataClass?: string;
  /** Data category from the vendor classification block, kept next to the class */
  dataCategory?: string;
}

// ---------------------------------------------------------------------------
// A parsed entity (the result of importing a schema file)
// ---------------------------------------------------------------------------

export interface ParsedEntity {
  /** Entity name extracted from the schema */
  name: string;
  /** Entity description (e.g. from TypeSpec @doc on model) */
  description?: string;
  /** Parsed fields */
  fields: ParsedField[];
  /** Vendor / unknown keys kept verbatim (parsed JSON values, never stringified) */
  extensions?: Record<string, unknown>;
  /** Parent entity name (inheritance), mirrors TypeSpecImportModel.extends */
  extends?: string;
  /** The source marks the entity deprecated (JSON Schema `deprecated: true` on its node); persisted as the entity's deprecation metadata. */
  deprecated?: boolean;
  /** Standard schema keywords on the entity's source node that were recognized but not mapped (see `ParsedField.ignoredKeywords`) */
  ignoredKeywords?: string[];
  /** Source format identifier */
  sourceFormat: ImportFormat;
  /** Original schema content (stored for drift detection) */
  originalContent: string;
  /** What the importer says about what it read, beyond its confidence notes (a declaration it did not keep): shown in the review's warnings. */
  importWarnings?: string[];
}

// ---------------------------------------------------------------------------
// Import result types
// ---------------------------------------------------------------------------

export interface ImportResult {
  parsedEntity: ParsedEntity;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Multi-entity import result (format-neutral)
//
// One schema document can define several assets: every Protobuf message
// (incl. nested), every Avro named record/enum/fixed, every JSON Schema
// `$defs` entry. Importers return all of them here; fields point at each
// other by name (`referencedEntityName`, `enumName`).
// ---------------------------------------------------------------------------

/** A named enum defined by the imported document (persisted as a SharedEnum). */
export interface ParsedEnum {
  name: string;
  values: string[];
  description?: string;
  /**
   * Keys of the source definition besides its symbols (JSON Schema: `x-enum-varnames`, `x-enum-descriptions`, `default`, `title`, ...), kept
   * verbatim. A shared enum row has no place for them, so the importer also puts them on every field that uses the enum, where they persist.
   */
  extensions?: Record<string, unknown>;
  /** The source definition is deprecated (also set on the fields that use it). */
  deprecated?: boolean;
  /** Standard schema keywords on the definition that were recognized but not mapped (see `ParsedField.ignoredKeywords`). */
  ignoredKeywords?: string[];
}

/** A named scalar defined by the imported document (persisted as a CustomScalar), e.g. Avro `fixed`. */
export interface ParsedScalar {
  name: string;
  baseType: string;
  description?: string;
}

/** A named union defined by the imported document (persisted as a UnionType); same shape as the TypeSpec importer's. */
export interface ParsedUnion {
  name: string;
  memberTypes: string[];
  description?: string;
}

export interface MultiEntityImportResult {
  sourceFormat: ImportFormat;
  /** Entities in document order. */
  entities: ParsedEntity[];
  /**
   * The document's own root entity, when the format has one (the Avro root
   * record, a JSON Schema root object). Otherwise the root is inferred — see
   * `pickRootEntity` in multi-asset.ts.
   */
  rootEntityName?: string;
  enums: ParsedEnum[];
  scalars: ParsedScalar[];
  /** Unions (JSON Schema `oneOf` / `anyOf` of named refs). Absent for formats that have none. */
  unions?: ParsedUnion[];
  /** Package / namespace declared by the document, if any */
  namespace?: string;
  warnings: string[];
}

export interface BulkImportResult {
  parsed: ParsedEntity[];
  errors: { filename: string; error: string }[];
  warnings: string[];
}

export interface BulkConfirmResult {
  created: { id: string; name: string }[];
  failed: { entityName: string; error: string }[];
}
