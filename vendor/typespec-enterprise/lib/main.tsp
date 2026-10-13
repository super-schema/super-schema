import "../dist/index.js";

using TypeSpec.Reflection;

namespace Enterprise;

/**
 * Data classification levels for governance
 */
enum DataClassification {
  Public,
  Internal,
  PII,
  FINANCIAL,
  Confidential,
  Restricted,
}

/**
 * Anonymization strategies for sensitive data
 */
enum AnonymizationStrategy {
  hash,
  tokenize,
  mask,
  none,
}

/**
 * Mark a model or property with a data classification level
 * @param level The classification level
 */
extern dec dataClassification(target: Model | ModelProperty, level: DataClassification);

/**
 * Mark a property as containing PII (Personally Identifiable Information)
 */
extern dec pii(target: ModelProperty);

/**
 * Specify the business owner for a model
 * @param owner The business owner identifier
 */
extern dec businessOwner(target: Model, owner: valueof string);

/**
 * Specify the data steward for a model
 * @param steward The data steward identifier
 */
extern dec steward(target: Model, steward: valueof string);

/**
 * Specify the retention policy for a model or property
 * @param policy The retention policy name or description
 */
extern dec retentionPolicy(target: Model | ModelProperty, policy: valueof string);

/**
 * Specify the anonymization strategy for sensitive data
 * @param strategy The anonymization strategy to use
 */
extern dec anonymization(target: ModelProperty, strategy: AnonymizationStrategy);

/**
 * Specify a data quality rule for a property
 * @param rule The quality rule expression or description
 */
extern dec qualityRule(target: ModelProperty, rule: valueof string);

// Note: no custom "key" decorator here — TypeSpec's own native `@key` from
// TypeSpec.Reflection already does this. A custom Enterprise.key decorator
// used to exist and was removed (2026-10-12): declaring any decorator named
// "key" makes every *unqualified* `@key` in a document importing this
// package ambiguous between TypeSpec's and this package's, breaking the
// extremely common bare `@key id: string;` pattern everywhere. Use
// `isKey`/`getKeyName` from "@typespec/compiler" directly instead.

/**
 * Specify precision for decimal/numeric fields
 * @param precision Total number of digits
 * @param scale Number of digits after decimal point
 */
extern dec precision(target: ModelProperty, precision: valueof int32, scale: valueof int32);

/**
 * Specify source system mapping for data lineage
 * @param system Source system name
 * @param entity Source entity/table name
 * @param field Optional source field name
 * @param transform Optional transformation description
 */
extern dec sourceMapping(target: ModelProperty, system: valueof string, entity: valueof string, field?: valueof string, transform?: valueof string);

// ---------------------------------------------------------------------------
// Avro physical binding (superseding the Prisma EmissionTargetStatus.formatOptions
// approach, 2026-10-12) — Avro-specific wire format options, opaque to the
// logical model, attached directly as decorators.
// ---------------------------------------------------------------------------

/**
 * Avro logical types this package understands; `fixed` requires `@avroFixedSize`,
 * `decimal` reuses the field's own `@precision`.
 */
enum AvroLogicalType {
  decimal,
  date,
  timeMillis,
  timeMicros,
  timestampMillis,
  timestampMicros,
  uuid,
  duration,
  fixed,
}

/**
 * Avro field ordering for sort-key compatibility.
 */
enum AvroFieldOrder {
  ascending,
  descending,
  ignore,
}

/**
 * Override the Avro logical type this field compiles to.
 * @param logicalType The Avro logical type
 */
extern dec avroLogicalType(target: ModelProperty, logicalType: AvroLogicalType);

/**
 * Required when @avroLogicalType is `fixed` — the fixed byte-array size.
 * @param size Size in bytes
 */
extern dec avroFixedSize(target: ModelProperty, size: valueof int32);

/**
 * Avro field order, rarely used — defaults to ascending when unset.
 * @param order The field order
 */
extern dec avroOrder(target: ModelProperty, order: AvroFieldOrder);

/**
 * Override the Avro record-level namespace (otherwise derived from the domain).
 * @param ns Dot-separated Avro namespace (named `ns`, not `namespace` — that's a reserved word)
 */
extern dec avroNamespace(target: Model, ns: valueof string);

/**
 * Avro record-level aliases for schema-evolution compatibility.
 * @param aliases Prior record names this schema is also known as, e.g. #["OldName"]
 */
extern dec avroRecordAliases(target: Model, aliases: valueof string[]);

// ---------------------------------------------------------------------------
// Protobuf physical binding — field numbers and oneof grouping, opaque to the
// logical model. Protobuf emitter itself is a later phase; the decorators
// exist now so field numbers assigned early are never lost.
// ---------------------------------------------------------------------------

/**
 * Permanent Protobuf field number for wire compatibility. Once assigned,
 * should not change — the governance lint rules enforce no duplicates
 * within a model.
 * @param number The field number (1-based, excluding the 19000-19999 reserved range)
 */
extern dec protobufFieldNumber(target: ModelProperty, number: valueof int32);

/**
 * Group fields into a Protobuf `oneof` block. Fields sharing the same
 * group name are emitted as one oneof.
 * @param group The oneof group name
 */
extern dec protobufOneofGroup(target: ModelProperty, group: valueof string);

// ---------------------------------------------------------------------------
// Operational hints — physical-storage suggestions, advisory only.
// ---------------------------------------------------------------------------

/**
 * Mark a property as a candidate for table partitioning.
 */
extern dec partitionHint(target: ModelProperty);

/**
 * Mark a property as a candidate for a database index.
 */
extern dec indexHint(target: ModelProperty);

/**
 * Mark a property as a candidate for clustering/sort-key ordering.
 */
extern dec clusterHint(target: ModelProperty);

// ---------------------------------------------------------------------------
// Evolution — schema lifecycle markers.
// ---------------------------------------------------------------------------

/**
 * Mark a model or property as deprecated. Named `deprecation` (not
 * `deprecated`) to avoid colliding with TypeSpec's own built-in `@deprecated`.
 * @param since Version or date this was deprecated
 * @param replacement Optional name of the replacement model/property
 */
extern dec deprecation(target: Model | ModelProperty, since: valueof string, replacement?: valueof string);
