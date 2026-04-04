/**
 * Type mapping types — shared across the mapping engine and service layer.
 *
 * MappingPolicy is re-exported from the IR model for convenience.
 */

import type { LogicalType, MappingPolicy } from "@/types/super-schema-model";

// Re-export for consumer convenience
export type { LogicalType, MappingPolicy };

// ---------------------------------------------------------------------------
// Supported target formats
// ---------------------------------------------------------------------------

export type TargetFormat = "bigquery" | "avro" | "openapi";

export const TARGET_FORMATS: TargetFormat[] = ["bigquery", "avro", "openapi"];

// ---------------------------------------------------------------------------
// Mapping result — returned by resolveMapping()
// ---------------------------------------------------------------------------

export interface MappingResult {
  mappedType: string;
  isLossy: boolean;
  lossDescription?: string;
  isOverride: boolean;
  overrideSource?: "global" | "per-entity";
}

// ---------------------------------------------------------------------------
// Valid target types per format — for override autocomplete
// ---------------------------------------------------------------------------

export const VALID_TARGET_TYPES: Record<string, string[]> = {
  bigquery: [
    "STRING", "INT64", "FLOAT64", "NUMERIC", "BIGNUMERIC", "BOOL",
    "DATE", "TIME", "DATETIME", "TIMESTAMP", "BYTES", "ARRAY",
    "STRUCT", "GEOGRAPHY", "JSON",
  ],
  avro: [
    "null", "boolean", "int", "long", "float", "double", "bytes",
    "string", "enum", "array", "map", "fixed", "record",
    "bytes/decimal", "int/date", "long/time-micros",
    "long/timestamp-millis", "fixed/duration",
  ],
  openapi: [
    "string", "number", "integer", "boolean", "array", "object",
    "string/uri", "string/byte", "string/date", "string/time",
    "string/date-time", "string/duration", "string+enum",
    "number/float", "number/double", "integer/int32", "integer/int64",
    "object/additionalProperties", "$ref",
  ],
};

// ---------------------------------------------------------------------------
// Mapping error — returned when no mapping exists
// ---------------------------------------------------------------------------

export interface MappingError {
  code: "MAPPING_NOT_FOUND";
  message: string;
  suggestedFix: string;
  sourceType: string;
  targetFormat: string;
}

// ---------------------------------------------------------------------------
// Default mapping entry — static config shape
// ---------------------------------------------------------------------------

export interface DefaultMappingEntry {
  sourceType: string;
  targetFormat: TargetFormat;
  mappedType: string;
  isLossy: boolean;
  lossDescription?: string;
}

// ---------------------------------------------------------------------------
// Create override input — for the service layer
// ---------------------------------------------------------------------------

export interface CreateOverrideInput {
  sourceType: string;
  targetFormat: string;
  mappedType: string;
  isLossy: boolean;
  lossDescription?: string;
  entityId?: string; // per-entity override scope
  justification?: string; // required for overrides
}

// ---------------------------------------------------------------------------
// Mapping policy with scope — extends MappingPolicy for override chain
// ---------------------------------------------------------------------------

export interface ScopedMappingPolicy extends MappingPolicy {
  id?: string;
  entityId?: string; // undefined = global, set = per-entity
  isLossy: boolean;
  lossDescription?: string;
  justification?: string;
  acknowledged?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}
