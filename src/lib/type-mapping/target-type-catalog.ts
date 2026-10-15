export interface TargetTypeOption {
  value: string;
  label: string;
  description: string;
  group: string;
}

export interface TargetTypeCatalogEntry {
  key: string;
  displayName: string;
  docsUrl: string;
  docsSource: string;
  supportsGeneratedOverrides: boolean;
  options: TargetTypeOption[];
}

const BIGQUERY_OPTIONS: TargetTypeOption[] = [
  { value: "STRING", label: "STRING", description: "Variable-length UTF-8 text.", group: "Scalars" },
  { value: "STRING(36)", label: "STRING(36)", description: "Parameterized text for fixed-width identifiers.", group: "Scalars" },
  { value: "STRING(255)", label: "STRING(255)", description: "Parameterized text for bounded fields.", group: "Scalars" },
  { value: "BYTES", label: "BYTES", description: "Binary payload.", group: "Scalars" },
  { value: "BYTES(16)", label: "BYTES(16)", description: "Bounded binary payload.", group: "Scalars" },
  { value: "INT64", label: "INT64", description: "Signed 64-bit integer.", group: "Numeric" },
  { value: "FLOAT64", label: "FLOAT64", description: "Double precision floating point.", group: "Numeric" },
  { value: "NUMERIC", label: "NUMERIC", description: "Exact decimal type.", group: "Numeric" },
  { value: "NUMERIC(19,4)", label: "NUMERIC(19,4)", description: "Parameterized exact decimal type.", group: "Numeric" },
  { value: "BIGNUMERIC", label: "BIGNUMERIC", description: "Extended exact decimal type.", group: "Numeric" },
  { value: "BIGNUMERIC(38,9)", label: "BIGNUMERIC(38,9)", description: "Parameterized extended exact decimal type.", group: "Numeric" },
  { value: "BOOL", label: "BOOL", description: "Boolean flag.", group: "Scalars" },
  { value: "DATE", label: "DATE", description: "Calendar date.", group: "Temporal" },
  { value: "TIME", label: "TIME", description: "Time of day.", group: "Temporal" },
  { value: "DATETIME", label: "DATETIME", description: "Date and time without timezone.", group: "Temporal" },
  { value: "TIMESTAMP", label: "TIMESTAMP", description: "Absolute point in time.", group: "Temporal" },
  { value: "JSON", label: "JSON", description: "Semi-structured JSON value.", group: "Semi-structured" },
  { value: "GEOGRAPHY", label: "GEOGRAPHY", description: "Geospatial value.", group: "Specialized" },
  { value: "INTERVAL", label: "INTERVAL", description: "Temporal duration.", group: "Temporal" },
  { value: "STRUCT", label: "STRUCT", description: "Nested record container.", group: "Complex" },
  { value: "ARRAY<STRING>", label: "ARRAY<STRING>", description: "Repeated text values.", group: "Collections" },
  { value: "ARRAY<INT64>", label: "ARRAY<INT64>", description: "Repeated integer values.", group: "Collections" },
  { value: "ARRAY<NUMERIC>", label: "ARRAY<NUMERIC>", description: "Repeated exact decimal values.", group: "Collections" },
  { value: "ARRAY<TIMESTAMP>", label: "ARRAY<TIMESTAMP>", description: "Repeated timestamps.", group: "Collections" },
  { value: "RANGE<DATE>", label: "RANGE<DATE>", description: "Date range.", group: "Specialized" },
  { value: "RANGE<DATETIME>", label: "RANGE<DATETIME>", description: "Datetime range.", group: "Specialized" },
  { value: "RANGE<TIMESTAMP>", label: "RANGE<TIMESTAMP>", description: "Timestamp range.", group: "Specialized" },
];

const SPANNER_OPTIONS: TargetTypeOption[] = [
  { value: "STRING(MAX)", label: "STRING(MAX)", description: "Unbounded text.", group: "Scalars" },
  { value: "STRING(36)", label: "STRING(36)", description: "Bounded text for identifiers.", group: "Scalars" },
  { value: "STRING(64)", label: "STRING(64)", description: "Bounded text for short codes.", group: "Scalars" },
  { value: "STRING(255)", label: "STRING(255)", description: "Bounded text for common attributes.", group: "Scalars" },
  { value: "BYTES(MAX)", label: "BYTES(MAX)", description: "Unbounded binary payload.", group: "Scalars" },
  { value: "BYTES(16)", label: "BYTES(16)", description: "Fixed-ish binary identifiers.", group: "Scalars" },
  { value: "INT64", label: "INT64", description: "Signed 64-bit integer.", group: "Numeric" },
  { value: "FLOAT32", label: "FLOAT32", description: "Single precision floating point.", group: "Numeric" },
  { value: "FLOAT64", label: "FLOAT64", description: "Double precision floating point.", group: "Numeric" },
  { value: "NUMERIC", label: "NUMERIC", description: "Exact decimal type with 38,9 precision/scale.", group: "Numeric" },
  { value: "BOOL", label: "BOOL", description: "Boolean flag.", group: "Scalars" },
  { value: "DATE", label: "DATE", description: "Calendar date.", group: "Temporal" },
  { value: "TIMESTAMP", label: "TIMESTAMP", description: "Absolute timestamp.", group: "Temporal" },
  { value: "JSON", label: "JSON", description: "Semi-structured JSON document.", group: "Semi-structured" },
  { value: "UUID", label: "UUID", description: "UUID represented as a dedicated type.", group: "Specialized" },
  { value: "ARRAY<STRING(MAX)>", label: "ARRAY<STRING(MAX)>", description: "Repeated text values.", group: "Collections" },
  { value: "ARRAY<INT64>", label: "ARRAY<INT64>", description: "Repeated integer values.", group: "Collections" },
  { value: "ARRAY<NUMERIC>", label: "ARRAY<NUMERIC>", description: "Repeated exact decimal values.", group: "Collections" },
  { value: "ARRAY<TIMESTAMP>", label: "ARRAY<TIMESTAMP>", description: "Repeated timestamps.", group: "Collections" },
  { value: "ARRAY<UUID>", label: "ARRAY<UUID>", description: "Repeated UUID values.", group: "Collections" },
];

const POSTGRESQL_OPTIONS: TargetTypeOption[] = [
  { value: "smallint", label: "smallint", description: "Signed two-byte integer.", group: "Numeric" },
  { value: "integer", label: "integer", description: "Signed four-byte integer.", group: "Numeric" },
  { value: "bigint", label: "bigint", description: "Signed eight-byte integer.", group: "Numeric" },
  { value: "serial", label: "serial", description: "Autoincrementing four-byte integer.", group: "Numeric" },
  { value: "bigserial", label: "bigserial", description: "Autoincrementing eight-byte integer.", group: "Numeric" },
  { value: "numeric", label: "numeric", description: "Exact numeric with selectable precision.", group: "Numeric" },
  { value: "numeric(19,4)", label: "numeric(19,4)", description: "Exact numeric for money-like values.", group: "Numeric" },
  { value: "decimal(19,4)", label: "decimal(19,4)", description: "SQL-standard alias for exact numeric.", group: "Numeric" },
  { value: "real", label: "real", description: "Single precision floating point.", group: "Numeric" },
  { value: "double precision", label: "double precision", description: "Double precision floating point.", group: "Numeric" },
  { value: "money", label: "money", description: "Currency amount.", group: "Numeric" },
  { value: "boolean", label: "boolean", description: "Boolean flag.", group: "Scalars" },
  { value: "char(1)", label: "char(1)", description: "Fixed-length character string.", group: "Text" },
  { value: "varchar(64)", label: "varchar(64)", description: "Bounded variable-length text.", group: "Text" },
  { value: "varchar(255)", label: "varchar(255)", description: "Common bounded text.", group: "Text" },
  { value: "text", label: "text", description: "Unbounded variable-length text.", group: "Text" },
  { value: "bytea", label: "bytea", description: "Binary data.", group: "Scalars" },
  { value: "date", label: "date", description: "Calendar date.", group: "Temporal" },
  { value: "time", label: "time", description: "Time of day without timezone.", group: "Temporal" },
  { value: "timetz", label: "timetz", description: "Time of day with timezone.", group: "Temporal" },
  { value: "timestamp", label: "timestamp", description: "Date and time without timezone.", group: "Temporal" },
  { value: "timestamptz", label: "timestamptz", description: "Date and time with timezone.", group: "Temporal" },
  { value: "interval", label: "interval", description: "Time span.", group: "Temporal" },
  { value: "uuid", label: "uuid", description: "Universally unique identifier.", group: "Specialized" },
  { value: "json", label: "json", description: "Textual JSON value.", group: "Semi-structured" },
  { value: "jsonb", label: "jsonb", description: "Binary JSON document.", group: "Semi-structured" },
  { value: "xml", label: "xml", description: "XML document.", group: "Semi-structured" },
  { value: "inet", label: "inet", description: "IP host address.", group: "Specialized" },
  { value: "cidr", label: "cidr", description: "IP network address.", group: "Specialized" },
  { value: "macaddr", label: "macaddr", description: "MAC address.", group: "Specialized" },
  { value: "text[]", label: "text[]", description: "Array of text values.", group: "Collections" },
  { value: "uuid[]", label: "uuid[]", description: "Array of UUID values.", group: "Collections" },
  { value: "jsonb[]", label: "jsonb[]", description: "Array of JSONB values.", group: "Collections" },
];

const AVRO_OPTIONS: TargetTypeOption[] = [
  { value: "null", label: "null", description: "Null sentinel for unions.", group: "Primitive" },
  { value: "boolean", label: "boolean", description: "Boolean flag.", group: "Primitive" },
  { value: "int", label: "int", description: "32-bit signed integer.", group: "Primitive" },
  { value: "long", label: "long", description: "64-bit signed integer.", group: "Primitive" },
  { value: "float", label: "float", description: "Single precision floating point.", group: "Primitive" },
  { value: "double", label: "double", description: "Double precision floating point.", group: "Primitive" },
  { value: "bytes", label: "bytes", description: "Binary payload.", group: "Primitive" },
  { value: "string", label: "string", description: "Unicode text.", group: "Primitive" },
  { value: "bytes/decimal", label: "bytes/decimal", description: "Exact decimal logical type stored as bytes.", group: "Logical" },
  { value: "int/date", label: "int/date", description: "Calendar date logical type.", group: "Logical" },
  { value: "int/time-millis", label: "int/time-millis", description: "Time logical type with millisecond precision.", group: "Logical" },
  { value: "long/time-micros", label: "long/time-micros", description: "Time logical type with microsecond precision.", group: "Logical" },
  { value: "long/timestamp-millis", label: "long/timestamp-millis", description: "Timestamp logical type with millisecond precision.", group: "Logical" },
  { value: "long/timestamp-micros", label: "long/timestamp-micros", description: "Timestamp logical type with microsecond precision.", group: "Logical" },
  { value: "string/uuid", label: "string/uuid", description: "UUID logical type.", group: "Logical" },
  { value: "fixed/duration", label: "fixed/duration", description: "Duration logical type.", group: "Logical" },
];

const OPENAPI_OPTIONS: TargetTypeOption[] = [
  { value: "string", label: "string", description: "Plain string.", group: "Core" },
  { value: "string/date", label: "string/date", description: "RFC3339 full-date.", group: "String formats" },
  { value: "string/date-time", label: "string/date-time", description: "RFC3339 date-time.", group: "String formats" },
  { value: "string/time", label: "string/time", description: "Time of day.", group: "String formats" },
  { value: "string/duration", label: "string/duration", description: "Duration string.", group: "String formats" },
  { value: "string/byte", label: "string/byte", description: "Base64-encoded octets.", group: "String formats" },
  { value: "string/binary", label: "string/binary", description: "Arbitrary binary payload.", group: "String formats" },
  { value: "string/password", label: "string/password", description: "Password hint for UIs.", group: "String formats" },
  { value: "string/email", label: "string/email", description: "Email string.", group: "String formats" },
  { value: "string/uuid", label: "string/uuid", description: "UUID string.", group: "String formats" },
  { value: "string/uri", label: "string/uri", description: "URI string.", group: "String formats" },
  { value: "number", label: "number", description: "Generic numeric value.", group: "Core" },
  { value: "number/float", label: "number/float", description: "Float format.", group: "Numeric formats" },
  { value: "number/double", label: "number/double", description: "Double format.", group: "Numeric formats" },
  { value: "integer", label: "integer", description: "Generic integer.", group: "Core" },
  { value: "integer/int32", label: "integer/int32", description: "Signed 32-bit integer.", group: "Numeric formats" },
  { value: "integer/int64", label: "integer/int64", description: "Signed 64-bit integer.", group: "Numeric formats" },
  { value: "boolean", label: "boolean", description: "Boolean flag.", group: "Core" },
  { value: "object", label: "object", description: "Structured object.", group: "Core" },
  { value: "object/additionalProperties", label: "object/additionalProperties", description: "Map-like object.", group: "Core" },
  { value: "$ref", label: "$ref", description: "Reference to another schema component.", group: "References" },
];

const JSON_SCHEMA_OPTIONS: TargetTypeOption[] = [
  { value: "string", label: "string", description: "String type.", group: "Core" },
  { value: "string/date", label: "string/date", description: "String with date format.", group: "Formats" },
  { value: "string/date-time", label: "string/date-time", description: "String with date-time format.", group: "Formats" },
  { value: "string/time", label: "string/time", description: "String with time format.", group: "Formats" },
  { value: "string/duration", label: "string/duration", description: "String with duration format.", group: "Formats" },
  { value: "string/email", label: "string/email", description: "String with email format.", group: "Formats" },
  { value: "string/uuid", label: "string/uuid", description: "String with UUID format.", group: "Formats" },
  { value: "string/uri", label: "string/uri", description: "String with URI format.", group: "Formats" },
  { value: "number", label: "number", description: "Any numeric type.", group: "Core" },
  { value: "integer", label: "integer", description: "Integer numeric type.", group: "Core" },
  { value: "boolean", label: "boolean", description: "Boolean flag.", group: "Core" },
  { value: "object", label: "object", description: "Structured object.", group: "Core" },
  { value: "object/additionalProperties", label: "object/additionalProperties", description: "Map-like object.", group: "Core" },
  { value: "array", label: "array", description: "Repeated values.", group: "Core" },
  { value: "null", label: "null", description: "Explicit null value.", group: "Core" },
];

const PROTOBUF_OPTIONS: TargetTypeOption[] = [
  { value: "double", label: "double", description: "Double precision floating point.", group: "Scalars" },
  { value: "float", label: "float", description: "Single precision floating point.", group: "Scalars" },
  { value: "int32", label: "int32", description: "Signed 32-bit integer.", group: "Scalars" },
  { value: "int64", label: "int64", description: "Signed 64-bit integer.", group: "Scalars" },
  { value: "uint32", label: "uint32", description: "Unsigned 32-bit integer.", group: "Scalars" },
  { value: "uint64", label: "uint64", description: "Unsigned 64-bit integer.", group: "Scalars" },
  { value: "sint32", label: "sint32", description: "Signed 32-bit integer with ZigZag encoding.", group: "Scalars" },
  { value: "sint64", label: "sint64", description: "Signed 64-bit integer with ZigZag encoding.", group: "Scalars" },
  { value: "fixed32", label: "fixed32", description: "Always four bytes.", group: "Scalars" },
  { value: "fixed64", label: "fixed64", description: "Always eight bytes.", group: "Scalars" },
  { value: "sfixed32", label: "sfixed32", description: "Signed fixed-width four bytes.", group: "Scalars" },
  { value: "sfixed64", label: "sfixed64", description: "Signed fixed-width eight bytes.", group: "Scalars" },
  { value: "bool", label: "bool", description: "Boolean flag.", group: "Scalars" },
  { value: "string", label: "string", description: "UTF-8 or ASCII text.", group: "Scalars" },
  { value: "bytes", label: "bytes", description: "Arbitrary byte sequence.", group: "Scalars" },
  { value: "enum", label: "enum", description: "Enumerated value set.", group: "Complex" },
  { value: "message", label: "message", description: "Nested message type.", group: "Complex" },
  { value: "map<string, string>", label: "map<string, string>", description: "String-keyed map of strings.", group: "Collections" },
  { value: "map<string, int64>", label: "map<string, int64>", description: "String-keyed map of integers.", group: "Collections" },
  { value: "google.protobuf.Timestamp", label: "google.protobuf.Timestamp", description: "Well-known timestamp type.", group: "Well-known types" },
  { value: "google.protobuf.Duration", label: "google.protobuf.Duration", description: "Well-known duration type.", group: "Well-known types" },
  { value: "google.type.Date", label: "google.type.Date", description: "Calendar date without time zone (googleapis common type).", group: "Well-known types" },
  { value: "google.type.TimeOfDay", label: "google.type.TimeOfDay", description: "Time of day without date or time zone (googleapis common type).", group: "Well-known types" },
  { value: "google.protobuf.Struct", label: "google.protobuf.Struct", description: "Well-known structured value type.", group: "Well-known types" },
  { value: "google.protobuf.Any", label: "google.protobuf.Any", description: "Arbitrary typed payload.", group: "Well-known types" },
  { value: "google.protobuf.StringValue", label: "google.protobuf.StringValue", description: "Optional string wrapper.", group: "Well-known types" },
  { value: "google.protobuf.Int64Value", label: "google.protobuf.Int64Value", description: "Optional int64 wrapper.", group: "Well-known types" },
];

const TARGET_TYPE_CATALOG: Record<string, TargetTypeCatalogEntry> = {
  bigquery: {
    key: "bigquery",
    displayName: "BigQuery DDL",
    docsUrl: "https://cloud.google.com/bigquery/docs/reference/standard-sql/data-types",
    docsSource: "Google Cloud BigQuery GoogleSQL data types",
    supportsGeneratedOverrides: true,
    options: BIGQUERY_OPTIONS,
  },
  spanner: {
    key: "spanner",
    displayName: "Spanner DDL",
    docsUrl: "https://cloud.google.com/spanner/docs/reference/standard-sql/data-types",
    docsSource: "Google Cloud Spanner GoogleSQL data types",
    supportsGeneratedOverrides: true,
    options: SPANNER_OPTIONS,
  },
  postgresql: {
    key: "postgresql",
    displayName: "PostgreSQL DDL",
    docsUrl: "https://www.postgresql.org/docs/current/datatype.html",
    docsSource: "PostgreSQL current Chapter 8 data types",
    supportsGeneratedOverrides: true,
    options: POSTGRESQL_OPTIONS,
  },
  avro: {
    key: "avro",
    displayName: "Avro Schema",
    docsUrl: "https://avro.apache.org/docs/1.11.1/idl-language/",
    docsSource: "Apache Avro IDL primitive and logical types",
    supportsGeneratedOverrides: true,
    options: AVRO_OPTIONS,
  },
  openapi: {
    key: "openapi",
    displayName: "OpenAPI (Super Schema)",
    docsUrl: "https://spec.openapis.org/oas/v3.0.0.html",
    docsSource: "OpenAPI Specification data type formats",
    supportsGeneratedOverrides: true,
    options: OPENAPI_OPTIONS,
  },
  openapi3: {
    key: "openapi3",
    displayName: "OpenAPI 3 (TypeSpec)",
    docsUrl: "https://spec.openapis.org/oas/v3.0.0.html",
    docsSource: "OpenAPI Specification data type formats",
    supportsGeneratedOverrides: false,
    options: OPENAPI_OPTIONS,
  },
  "json-schema": {
    key: "json-schema",
    displayName: "JSON Schema (TypeSpec)",
    docsUrl: "https://json-schema.org/understanding-json-schema/reference/type",
    docsSource: "JSON Schema type reference",
    supportsGeneratedOverrides: false,
    options: JSON_SCHEMA_OPTIONS,
  },
  protobuf: {
    key: "protobuf",
    displayName: "Protobuf (TypeSpec)",
    docsUrl: "https://protobuf.dev/programming-guides/proto3/",
    docsSource: "Protocol Buffers proto3 scalar types",
    supportsGeneratedOverrides: false,
    options: PROTOBUF_OPTIONS,
  },
};

export function getTargetTypeCatalogEntry(target: string): TargetTypeCatalogEntry | undefined {
  return TARGET_TYPE_CATALOG[target];
}

export function getTargetTypeOptions(target: string): TargetTypeOption[] {
  return TARGET_TYPE_CATALOG[target]?.options ?? [];
}

export function getValidTargetTypesFor(target: string): string[] {
  return getTargetTypeOptions(target).map((option) => option.value);
}

export function supportsGeneratedTypeOverrides(target: string): boolean {
  return TARGET_TYPE_CATALOG[target]?.supportsGeneratedOverrides ?? false;
}
