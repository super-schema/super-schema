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
  | "json-schema";

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
  extensions?: Record<string, string>;
  /** Whether @secret was applied */
  secret?: boolean;
  /** Discriminator field name */
  discriminator?: string;
  /** Target entity name for a reference field (from a JSON Schema $ref) */
  referencedEntityName?: string;
  /** Array element logical type (e.g. "string", or "reference" for an array of refs) */
  arrayElementType?: string;
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

export interface BulkImportResult {
  parsed: ParsedEntity[];
  errors: { filename: string; error: string }[];
  warnings: string[];
}

export interface BulkConfirmResult {
  created: { id: string; name: string }[];
  failed: { entityName: string; error: string }[];
}
