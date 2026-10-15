/**
 * Default type mapping policies — static TypeScript configuration.
 *
 * These define how each LogicalType maps to platform-specific types
 * for BigQuery, Avro, OpenAPI, Spanner, PostgreSQL and Protobuf targets.
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
  { sourceType: "map", targetFormat: "bigquery", mappedType: "JSON", isLossy: true, lossDescription: "Map stored as JSON — no typed key-value access" },
  { sourceType: "object", targetFormat: "bigquery", mappedType: "STRUCT", isLossy: false },
  { sourceType: "reference", targetFormat: "bigquery", mappedType: "STRING", isLossy: true, lossDescription: "Reference resolved to foreign key string — relationship semantics lost" },
];

// ---------------------------------------------------------------------------
// Avro default mappings
// ---------------------------------------------------------------------------

const AVRO_DECIMAL_LOSS =
  "The Avro emitter currently publishes decimal(precision 38, scale 0) whatever the field's precision/scale — a decimal(12,2) loses its fractional digits (a limitation of the Avro emitter in the separate typespec repo)";

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
  // The typespec-cli Avro emitter (@superschema/typespec-avro, a separate repo) hardcodes `decimal(precision 38, scale 0)`
  // for numeric / decimal / decimal128 and does not read the field's precision / scale — so `decimal(12,2)` is published as
  // `decimal(38,0)` and fractional digits are lost. Marked lossy until the emitter carries @precision / @scale.
  { sourceType: "numeric", targetFormat: "avro", mappedType: "bytes/decimal", isLossy: true, lossDescription: AVRO_DECIMAL_LOSS },
  { sourceType: "float", targetFormat: "avro", mappedType: "double", isLossy: false },
  { sourceType: "float32", targetFormat: "avro", mappedType: "float", isLossy: false },
  { sourceType: "float64", targetFormat: "avro", mappedType: "double", isLossy: false },
  { sourceType: "decimal", targetFormat: "avro", mappedType: "bytes/decimal", isLossy: true, lossDescription: AVRO_DECIMAL_LOSS },
  { sourceType: "decimal128", targetFormat: "avro", mappedType: "bytes/decimal", isLossy: true, lossDescription: AVRO_DECIMAL_LOSS },
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
// Spanner default mappings
// ---------------------------------------------------------------------------

const SPANNER_MAPPINGS: DefaultMappingEntry[] = [
  { sourceType: "string", targetFormat: "spanner", mappedType: "STRING(MAX)", isLossy: false },
  { sourceType: "url", targetFormat: "spanner", mappedType: "STRING(MAX)", isLossy: false },
  { sourceType: "integer", targetFormat: "spanner", mappedType: "INT64", isLossy: false },
  { sourceType: "int8", targetFormat: "spanner", mappedType: "INT64", isLossy: false },
  { sourceType: "int16", targetFormat: "spanner", mappedType: "INT64", isLossy: false },
  { sourceType: "int32", targetFormat: "spanner", mappedType: "INT64", isLossy: false },
  { sourceType: "int64", targetFormat: "spanner", mappedType: "INT64", isLossy: false },
  { sourceType: "safeint", targetFormat: "spanner", mappedType: "INT64", isLossy: false },
  { sourceType: "uint8", targetFormat: "spanner", mappedType: "INT64", isLossy: false },
  { sourceType: "uint16", targetFormat: "spanner", mappedType: "INT64", isLossy: false },
  { sourceType: "uint32", targetFormat: "spanner", mappedType: "INT64", isLossy: false },
  { sourceType: "uint64", targetFormat: "spanner", mappedType: "INT64", isLossy: true, lossDescription: "uint64 values above 2^63-1 cannot be represented in signed INT64" },
  { sourceType: "numeric", targetFormat: "spanner", mappedType: "NUMERIC", isLossy: false },
  { sourceType: "float", targetFormat: "spanner", mappedType: "FLOAT64", isLossy: false },
  { sourceType: "float32", targetFormat: "spanner", mappedType: "FLOAT64", isLossy: true, lossDescription: "float32 widened to FLOAT64 — Spanner only supports 64-bit floats" },
  { sourceType: "float64", targetFormat: "spanner", mappedType: "FLOAT64", isLossy: false },
  { sourceType: "decimal", targetFormat: "spanner", mappedType: "NUMERIC", isLossy: true, lossDescription: "Spanner NUMERIC has fixed precision 38,9 — custom precision/scale not supported" },
  { sourceType: "decimal128", targetFormat: "spanner", mappedType: "NUMERIC", isLossy: true, lossDescription: "decimal128 reduced to NUMERIC (38,9) — values beyond 38 digits will be truncated" },
  { sourceType: "boolean", targetFormat: "spanner", mappedType: "BOOL", isLossy: false },
  { sourceType: "bytes", targetFormat: "spanner", mappedType: "BYTES(MAX)", isLossy: false },
  { sourceType: "plainDate", targetFormat: "spanner", mappedType: "DATE", isLossy: false },
  { sourceType: "plainTime", targetFormat: "spanner", mappedType: "STRING(MAX)", isLossy: true, lossDescription: "No native TIME type in Spanner — stored as ISO 8601 string" },
  { sourceType: "utcDateTime", targetFormat: "spanner", mappedType: "TIMESTAMP", isLossy: false },
  { sourceType: "offsetDateTime", targetFormat: "spanner", mappedType: "TIMESTAMP", isLossy: true, lossDescription: "UTC offset information is normalized to UTC — original offset value is lost" },
  { sourceType: "duration", targetFormat: "spanner", mappedType: "STRING(MAX)", isLossy: true, lossDescription: "No native duration type in Spanner — stored as ISO 8601 string" },
  { sourceType: "unixTimestamp32", targetFormat: "spanner", mappedType: "INT64", isLossy: false },
  { sourceType: "enum", targetFormat: "spanner", mappedType: "STRING(MAX)", isLossy: false },
  { sourceType: "array", targetFormat: "spanner", mappedType: "ARRAY", isLossy: false },
  { sourceType: "map", targetFormat: "spanner", mappedType: "JSON", isLossy: true, lossDescription: "Map stored as JSON — no typed key-value access" },
  { sourceType: "object", targetFormat: "spanner", mappedType: "JSON", isLossy: true, lossDescription: "Nested object stored as JSON — no typed field access" },
  { sourceType: "reference", targetFormat: "spanner", mappedType: "STRING(MAX)", isLossy: true, lossDescription: "Reference resolved to foreign key string — relationship semantics lost" },
];

// ---------------------------------------------------------------------------
// PostgreSQL default mappings
// ---------------------------------------------------------------------------

const POSTGRESQL_MAPPINGS: DefaultMappingEntry[] = [
  { sourceType: "string", targetFormat: "postgresql", mappedType: "text", isLossy: false },
  { sourceType: "url", targetFormat: "postgresql", mappedType: "text", isLossy: false },
  { sourceType: "integer", targetFormat: "postgresql", mappedType: "integer", isLossy: false },
  { sourceType: "int8", targetFormat: "postgresql", mappedType: "smallint", isLossy: false },
  { sourceType: "int16", targetFormat: "postgresql", mappedType: "smallint", isLossy: false },
  { sourceType: "int32", targetFormat: "postgresql", mappedType: "integer", isLossy: false },
  { sourceType: "int64", targetFormat: "postgresql", mappedType: "bigint", isLossy: false },
  { sourceType: "safeint", targetFormat: "postgresql", mappedType: "bigint", isLossy: false },
  { sourceType: "uint8", targetFormat: "postgresql", mappedType: "smallint", isLossy: false },
  { sourceType: "uint16", targetFormat: "postgresql", mappedType: "integer", isLossy: false },
  { sourceType: "uint32", targetFormat: "postgresql", mappedType: "bigint", isLossy: false },
  { sourceType: "uint64", targetFormat: "postgresql", mappedType: "numeric(20,0)", isLossy: false },
  { sourceType: "numeric", targetFormat: "postgresql", mappedType: "numeric", isLossy: false },
  { sourceType: "float", targetFormat: "postgresql", mappedType: "double precision", isLossy: false },
  { sourceType: "float32", targetFormat: "postgresql", mappedType: "real", isLossy: false },
  { sourceType: "float64", targetFormat: "postgresql", mappedType: "double precision", isLossy: false },
  { sourceType: "decimal", targetFormat: "postgresql", mappedType: "numeric", isLossy: false },
  { sourceType: "decimal128", targetFormat: "postgresql", mappedType: "numeric", isLossy: false },
  { sourceType: "boolean", targetFormat: "postgresql", mappedType: "boolean", isLossy: false },
  { sourceType: "bytes", targetFormat: "postgresql", mappedType: "bytea", isLossy: false },
  { sourceType: "plainDate", targetFormat: "postgresql", mappedType: "date", isLossy: false },
  { sourceType: "plainTime", targetFormat: "postgresql", mappedType: "time", isLossy: false },
  { sourceType: "utcDateTime", targetFormat: "postgresql", mappedType: "timestamp", isLossy: false },
  { sourceType: "offsetDateTime", targetFormat: "postgresql", mappedType: "timestamptz", isLossy: false },
  { sourceType: "duration", targetFormat: "postgresql", mappedType: "interval", isLossy: false },
  { sourceType: "unixTimestamp32", targetFormat: "postgresql", mappedType: "integer", isLossy: false },
  { sourceType: "enum", targetFormat: "postgresql", mappedType: "text", isLossy: false },
  { sourceType: "array", targetFormat: "postgresql", mappedType: "text[]", isLossy: false },
  { sourceType: "map", targetFormat: "postgresql", mappedType: "jsonb", isLossy: false },
  { sourceType: "object", targetFormat: "postgresql", mappedType: "jsonb", isLossy: false },
  { sourceType: "reference", targetFormat: "postgresql", mappedType: "uuid", isLossy: true, lossDescription: "Reference defaults to UUID storage — verify downstream identifier format if references are not UUID-based" },
];

// ---------------------------------------------------------------------------
// Protobuf (proto3) default mappings
//
// Mirrors what the official @typespec/protobuf emitter actually produces after
// the protobuf-target source projection
// (src/lib/typespec-official/protobuf-source.ts) — pinned by
// tests/integration/protobuf-all-types.test.ts, which asserts every scalar's
// emitted proto type equals the mappedType below.
// ---------------------------------------------------------------------------

const PROTOBUF_MAPPINGS: DefaultMappingEntry[] = [
  { sourceType: "string", targetFormat: "protobuf", mappedType: "string", isLossy: false },
  { sourceType: "url", targetFormat: "protobuf", mappedType: "string", isLossy: false },
  { sourceType: "integer", targetFormat: "protobuf", mappedType: "int64", isLossy: false },
  { sourceType: "int8", targetFormat: "protobuf", mappedType: "int32", isLossy: false },
  { sourceType: "int16", targetFormat: "protobuf", mappedType: "int32", isLossy: false },
  { sourceType: "int32", targetFormat: "protobuf", mappedType: "int32", isLossy: false },
  { sourceType: "int64", targetFormat: "protobuf", mappedType: "int64", isLossy: false },
  { sourceType: "safeint", targetFormat: "protobuf", mappedType: "int64", isLossy: false },
  { sourceType: "uint8", targetFormat: "protobuf", mappedType: "uint32", isLossy: false },
  { sourceType: "uint16", targetFormat: "protobuf", mappedType: "uint32", isLossy: false },
  { sourceType: "uint32", targetFormat: "protobuf", mappedType: "uint32", isLossy: false },
  { sourceType: "uint64", targetFormat: "protobuf", mappedType: "uint64", isLossy: false },
  { sourceType: "numeric", targetFormat: "protobuf", mappedType: "string", isLossy: true, lossDescription: "proto3 has no arbitrary-precision numeric type — value is carried as decimal text in a string; consumers must parse it and no numeric range is enforced" },
  { sourceType: "float", targetFormat: "protobuf", mappedType: "double", isLossy: false },
  { sourceType: "float32", targetFormat: "protobuf", mappedType: "float", isLossy: false },
  { sourceType: "float64", targetFormat: "protobuf", mappedType: "double", isLossy: false },
  { sourceType: "decimal", targetFormat: "protobuf", mappedType: "string", isLossy: true, lossDescription: "proto3 has no decimal type — exact decimal is carried as decimal text in a string (same encoding as google.type.Decimal); precision/scale are not enforced by the schema" },
  { sourceType: "decimal128", targetFormat: "protobuf", mappedType: "string", isLossy: true, lossDescription: "proto3 has no decimal type — decimal128 is carried as decimal text in a string (same encoding as google.type.Decimal); precision/scale are not enforced by the schema" },
  { sourceType: "boolean", targetFormat: "protobuf", mappedType: "bool", isLossy: false },
  { sourceType: "bytes", targetFormat: "protobuf", mappedType: "bytes", isLossy: false },
  { sourceType: "plainDate", targetFormat: "protobuf", mappedType: "google.type.Date", isLossy: false },
  { sourceType: "plainTime", targetFormat: "protobuf", mappedType: "google.type.TimeOfDay", isLossy: false },
  { sourceType: "utcDateTime", targetFormat: "protobuf", mappedType: "google.protobuf.Timestamp", isLossy: false },
  { sourceType: "offsetDateTime", targetFormat: "protobuf", mappedType: "google.protobuf.Timestamp", isLossy: true, lossDescription: "UTC offset information is lost — google.protobuf.Timestamp is an absolute UTC instant" },
  { sourceType: "duration", targetFormat: "protobuf", mappedType: "google.protobuf.Duration", isLossy: true, lossDescription: "google.protobuf.Duration is an exact seconds+nanos span — calendar components of an ISO 8601 duration (years, months, days) have no fixed length and must be normalized to seconds" },
  { sourceType: "unixTimestamp32", targetFormat: "protobuf", mappedType: "google.protobuf.Timestamp", isLossy: false },
  // isLossy: true on the next two rows is what makes the mapping UI surface
  // the note (mapping-intelligence only shows a lossDescription when isLossy).
  { sourceType: "enum", targetFormat: "protobuf", mappedType: "enum", isLossy: true, lossDescription: "Proto enum ordinals are positional: a <ENUM>_UNSPECIFIED = 0 sentinel is added and members are numbered 1..n in their current order, with no persisted numbers. Inserting, removing or reordering a member renumbers later members — a wire-breaking change for existing consumers (Buf breaking / Schema Registry compatibility). Only append new members at the end." },
  { sourceType: "array", targetFormat: "protobuf", mappedType: "repeated", isLossy: false },
  { sourceType: "map", targetFormat: "protobuf", mappedType: "map", isLossy: false },
  { sourceType: "object", targetFormat: "protobuf", mappedType: "google.protobuf.Struct", isLossy: true, lossDescription: "Nested object emitted as dynamic google.protobuf.Struct — nested field types are not preserved" },
  { sourceType: "reference", targetFormat: "protobuf", mappedType: "message", isLossy: true, lossDescription: "Cross-entity references are not emitted yet: the referenced entity's message is not in the same compile unit, so protobuf emission fails with \"Unknown identifier\" (multi-model emission gap). The intended mapping is a reference to the referenced entity's message." },
];

// ---------------------------------------------------------------------------
// Combined default mappings
// ---------------------------------------------------------------------------

export const DEFAULT_MAPPINGS: DefaultMappingEntry[] = [
  ...BIGQUERY_MAPPINGS,
  ...AVRO_MAPPINGS,
  ...OPENAPI_MAPPINGS,
  ...SPANNER_MAPPINGS,
  ...POSTGRESQL_MAPPINGS,
  ...PROTOBUF_MAPPINGS,
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
