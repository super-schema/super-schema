/**
 * Shared types for the schema import pipeline.
 *
 * These types are used by all importers (Avro, BigQuery DDL, Protobuf)
 * and by the drift detection engine (Story 9.2).
 */

// ---------------------------------------------------------------------------
// Import format enum
// ---------------------------------------------------------------------------

export type ImportFormat = "avro" | "bigquery-ddl" | "protobuf";

// ---------------------------------------------------------------------------
// Confidence levels for type mappings
// ---------------------------------------------------------------------------

export type ImportConfidence = "high" | "medium" | "low";

// ---------------------------------------------------------------------------
// A single parsed field from an imported schema
// ---------------------------------------------------------------------------

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
}

// ---------------------------------------------------------------------------
// A parsed entity (the result of importing a schema file)
// ---------------------------------------------------------------------------

export interface ParsedEntity {
  /** Entity name extracted from the schema */
  name: string;
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
