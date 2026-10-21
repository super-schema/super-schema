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
  /** Whether the field is nullable */
  nullable: boolean;
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
  /** Format-binding facts kept under `decorators.governance` (same keys the TypeSpec governance path stores) */
  governance?: ParsedFieldGovernance;
}

export interface ParsedFieldGovernance {
  /** Protobuf `oneof` group this field belongs to */
  protobufOneofGroup?: string;
  /** Avro `fixed` byte size */
  avroFixedSize?: number;
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
  /** Source format identifier */
  sourceFormat: ImportFormat;
  /** Original schema content (stored for drift detection) */
  originalContent: string;
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
}

/** A named scalar defined by the imported document (persisted as a CustomScalar), e.g. Avro `fixed`. */
export interface ParsedScalar {
  name: string;
  baseType: string;
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
