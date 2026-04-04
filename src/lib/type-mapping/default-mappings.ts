/**
 * Default type mapping policies — static TypeScript configuration.
 *
 * These define how each LogicalType maps to platform-specific types
 * for BigQuery, Avro, and OpenAPI targets.
 *
 * No Prisma dependency — pure data.
 */

import type { DefaultMappingEntry, ScopedMappingPolicy } from "./types";

// ---------------------------------------------------------------------------
// BigQuery default mappings
// ---------------------------------------------------------------------------

const BIGQUERY_MAPPINGS: DefaultMappingEntry[] = [
  { sourceType: "string", targetFormat: "bigquery", mappedType: "STRING", isLossy: false },
  { sourceType: "url", targetFormat: "bigquery", mappedType: "STRING", isLossy: false },
  { sourceType: "integer", targetFormat: "bigquery", mappedType: "INT64", isLossy: false },
  { sourceType: "int8", targetFormat: "bigquery", mappedType: "INT64", isLossy: false },
  { sourceType: "int16", targetFormat: "bigquery", mappedType: "INT64", isLossy: false },
  { sourceType: "int32", targetFormat: "bigquery", mappedType: "INT64", isLossy: false },
  { sourceType: "int64", targetFormat: "bigquery", mappedType: "INT64", isLossy: false },
  { sourceType: "safeint", targetFormat: "bigquery", mappedType: "INT64", isLossy: false },
  { sourceType: "uint8", targetFormat: "bigquery", mappedType: "INT64", isLossy: false },
  { sourceType: "uint16", targetFormat: "bigquery", mappedType: "INT64", isLossy: false },
  { sourceType: "uint32", targetFormat: "bigquery", mappedType: "INT64", isLossy: false },
  { sourceType: "uint64", targetFormat: "bigquery", mappedType: "INT64", isLossy: true, lossDescription: "uint64 values above 2^63-1 cannot be represented in signed INT64" },
  { sourceType: "numeric", targetFormat: "bigquery", mappedType: "NUMERIC", isLossy: false },
  { sourceType: "float", targetFormat: "bigquery", mappedType: "FLOAT64", isLossy: false },
  { sourceType: "float32", targetFormat: "bigquery", mappedType: "FLOAT64", isLossy: false },
  { sourceType: "float64", targetFormat: "bigquery", mappedType: "FLOAT64", isLossy: false },
  { sourceType: "decimal", targetFormat: "bigquery", mappedType: "NUMERIC", isLossy: false },
  { sourceType: "decimal128", targetFormat: "bigquery", mappedType: "BIGNUMERIC", isLossy: false },
  { sourceType: "boolean", targetFormat: "bigquery", mappedType: "BOOL", isLossy: false },
  { sourceType: "bytes", targetFormat: "bigquery", mappedType: "BYTES", isLossy: false },
  { sourceType: "plainDate", targetFormat: "bigquery", mappedType: "DATE", isLossy: false },
  { sourceType: "plainTime", targetFormat: "bigquery", mappedType: "TIME", isLossy: false },
  { sourceType: "utcDateTime", targetFormat: "bigquery", mappedType: "DATETIME", isLossy: false },
  { sourceType: "offsetDateTime", targetFormat: "bigquery", mappedType: "TIMESTAMP", isLossy: true, lossDescription: "UTC offset information is normalized to UTC — original offset value is lost" },
  { sourceType: "duration", targetFormat: "bigquery", mappedType: "STRING", isLossy: true, lossDescription: "Duration stored as ISO 8601 string — no native duration arithmetic support" },
  { sourceType: "unixTimestamp32", targetFormat: "bigquery", mappedType: "TIMESTAMP", isLossy: false },
  { sourceType: "enum", targetFormat: "bigquery", mappedType: "STRING", isLossy: false },
  { sourceType: "array", targetFormat: "bigquery", mappedType: "ARRAY", isLossy: false },
  { sourceType: "map", targetFormat: "bigquery", mappedType: "STRUCT", isLossy: true, lossDescription: "Nested key ordering not preserved" },
  { sourceType: "object", targetFormat: "bigquery", mappedType: "STRUCT", isLossy: false },
  { sourceType: "reference", targetFormat: "bigquery", mappedType: "STRING", isLossy: true, lossDescription: "Reference resolved to foreign key string — relationship semantics lost" },
];

// ---------------------------------------------------------------------------
// Avro default mappings
// ---------------------------------------------------------------------------

const AVRO_MAPPINGS: DefaultMappingEntry[] = [
  { sourceType: "string", targetFormat: "avro", mappedType: "string", isLossy: false },
  { sourceType: "url", targetFormat: "avro", mappedType: "string", isLossy: false },
  { sourceType: "integer", targetFormat: "avro", mappedType: "long", isLossy: false },
  { sourceType: "int8", targetFormat: "avro", mappedType: "int", isLossy: false },
  { sourceType: "int16", targetFormat: "avro", mappedType: "int", isLossy: false },
  { sourceType: "int32", targetFormat: "avro", mappedType: "int", isLossy: false },
  { sourceType: "int64", targetFormat: "avro", mappedType: "long", isLossy: false },
  { sourceType: "safeint", targetFormat: "avro", mappedType: "long", isLossy: false },
  { sourceType: "uint8", targetFormat: "avro", mappedType: "int", isLossy: false },
  { sourceType: "uint16", targetFormat: "avro", mappedType: "int", isLossy: false },
  { sourceType: "uint32", targetFormat: "avro", mappedType: "long", isLossy: false },
  { sourceType: "uint64", targetFormat: "avro", mappedType: "long", isLossy: true, lossDescription: "uint64 values above 2^63-1 cannot be represented in signed long" },
  { sourceType: "numeric", targetFormat: "avro", mappedType: "bytes/decimal", isLossy: false },
  { sourceType: "float", targetFormat: "avro", mappedType: "double", isLossy: false },
  { sourceType: "float32", targetFormat: "avro", mappedType: "float", isLossy: false },
  { sourceType: "float64", targetFormat: "avro", mappedType: "double", isLossy: false },
  { sourceType: "decimal", targetFormat: "avro", mappedType: "bytes/decimal", isLossy: false },
  { sourceType: "decimal128", targetFormat: "avro", mappedType: "bytes/decimal", isLossy: false },
  { sourceType: "boolean", targetFormat: "avro", mappedType: "boolean", isLossy: false },
  { sourceType: "bytes", targetFormat: "avro", mappedType: "bytes", isLossy: false },
  { sourceType: "plainDate", targetFormat: "avro", mappedType: "int/date", isLossy: false },
  { sourceType: "plainTime", targetFormat: "avro", mappedType: "long/time-micros", isLossy: false },
  { sourceType: "utcDateTime", targetFormat: "avro", mappedType: "long/timestamp-millis", isLossy: false },
  { sourceType: "offsetDateTime", targetFormat: "avro", mappedType: "long/timestamp-millis", isLossy: true, lossDescription: "UTC offset information is lost — Avro timestamps are always UTC" },
  { sourceType: "duration", targetFormat: "avro", mappedType: "fixed/duration", isLossy: false },
  { sourceType: "unixTimestamp32", targetFormat: "avro", mappedType: "long/timestamp-millis", isLossy: false },
  { sourceType: "enum", targetFormat: "avro", mappedType: "enum", isLossy: false },
  { sourceType: "array", targetFormat: "avro", mappedType: "array", isLossy: false },
  { sourceType: "map", targetFormat: "avro", mappedType: "map", isLossy: false },
  { sourceType: "object", targetFormat: "avro", mappedType: "record", isLossy: false },
  { sourceType: "reference", targetFormat: "avro", mappedType: "string", isLossy: true, lossDescription: "Reference resolved to foreign key string — relationship semantics lost" },
];

// ---------------------------------------------------------------------------
// OpenAPI default mappings
// ---------------------------------------------------------------------------

const OPENAPI_MAPPINGS: DefaultMappingEntry[] = [
  { sourceType: "string", targetFormat: "openapi", mappedType: "string", isLossy: false },
  { sourceType: "url", targetFormat: "openapi", mappedType: "string/uri", isLossy: false },
  { sourceType: "integer", targetFormat: "openapi", mappedType: "integer/int64", isLossy: false },
  { sourceType: "int8", targetFormat: "openapi", mappedType: "integer/int32", isLossy: false },
  { sourceType: "int16", targetFormat: "openapi", mappedType: "integer/int32", isLossy: false },
  { sourceType: "int32", targetFormat: "openapi", mappedType: "integer/int32", isLossy: false },
  { sourceType: "int64", targetFormat: "openapi", mappedType: "integer/int64", isLossy: false },
  { sourceType: "safeint", targetFormat: "openapi", mappedType: "integer/int64", isLossy: false },
  { sourceType: "uint8", targetFormat: "openapi", mappedType: "integer/int32", isLossy: false },
  { sourceType: "uint16", targetFormat: "openapi", mappedType: "integer/int32", isLossy: false },
  { sourceType: "uint32", targetFormat: "openapi", mappedType: "integer/int64", isLossy: false },
  { sourceType: "uint64", targetFormat: "openapi", mappedType: "integer/int64", isLossy: true, lossDescription: "uint64 values above 2^63-1 cannot be represented in int64 format" },
  { sourceType: "numeric", targetFormat: "openapi", mappedType: "number", isLossy: false },
  { sourceType: "float", targetFormat: "openapi", mappedType: "number/float", isLossy: false },
  { sourceType: "float32", targetFormat: "openapi", mappedType: "number/float", isLossy: false },
  { sourceType: "float64", targetFormat: "openapi", mappedType: "number/double", isLossy: false },
  { sourceType: "decimal", targetFormat: "openapi", mappedType: "number/double", isLossy: true, lossDescription: "Decimal precision reduced to float64 — values beyond 15 significant digits will be rounded" },
  { sourceType: "decimal128", targetFormat: "openapi", mappedType: "number/double", isLossy: true, lossDescription: "Decimal128 precision reduced to float64 — values beyond 15 significant digits will be rounded" },
  { sourceType: "boolean", targetFormat: "openapi", mappedType: "boolean", isLossy: false },
  { sourceType: "bytes", targetFormat: "openapi", mappedType: "string/byte", isLossy: false },
  { sourceType: "plainDate", targetFormat: "openapi", mappedType: "string/date", isLossy: false },
  { sourceType: "plainTime", targetFormat: "openapi", mappedType: "string/time", isLossy: false },
  { sourceType: "utcDateTime", targetFormat: "openapi", mappedType: "string/date-time", isLossy: false },
  { sourceType: "offsetDateTime", targetFormat: "openapi", mappedType: "string/date-time", isLossy: false },
  { sourceType: "duration", targetFormat: "openapi", mappedType: "string/duration", isLossy: false },
  { sourceType: "unixTimestamp32", targetFormat: "openapi", mappedType: "integer/int32", isLossy: false },
  { sourceType: "enum", targetFormat: "openapi", mappedType: "string+enum", isLossy: false },
  { sourceType: "array", targetFormat: "openapi", mappedType: "array", isLossy: false },
  { sourceType: "map", targetFormat: "openapi", mappedType: "object/additionalProperties", isLossy: false },
  { sourceType: "object", targetFormat: "openapi", mappedType: "object", isLossy: false },
  { sourceType: "reference", targetFormat: "openapi", mappedType: "$ref", isLossy: false },
];

// ---------------------------------------------------------------------------
// Combined default mappings
// ---------------------------------------------------------------------------

export const DEFAULT_MAPPINGS: DefaultMappingEntry[] = [
  ...BIGQUERY_MAPPINGS,
  ...AVRO_MAPPINGS,
  ...OPENAPI_MAPPINGS,
];

// ---------------------------------------------------------------------------
// Convert default entries to ScopedMappingPolicy for use with resolveMapping
// ---------------------------------------------------------------------------

export function getDefaultPolicies(): ScopedMappingPolicy[] {
  return DEFAULT_MAPPINGS.map((entry) => ({
    sourceType: entry.sourceType,
    targetType: entry.mappedType,
    targetFormat: entry.targetFormat,
    mappedType: entry.mappedType,
    isOverride: false,
    isLossy: entry.isLossy,
    lossDescription: entry.lossDescription,
  }));
}

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

/**
 * Get all default mappings for a specific target format.
 */
export function getDefaultMappingsForTarget(
  targetFormat: string
): DefaultMappingEntry[] {
  return DEFAULT_MAPPINGS.filter((m) => m.targetFormat === targetFormat);
}

/**
 * Get a specific default mapping by source type and target format.
 */
export function getDefaultMapping(
  sourceType: string,
  targetFormat: string
): DefaultMappingEntry | undefined {
  return DEFAULT_MAPPINGS.find(
    (m) => m.sourceType === sourceType && m.targetFormat === targetFormat
  );
}
