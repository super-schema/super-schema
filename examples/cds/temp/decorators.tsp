// ================================================================================================
// CUSTOM DECORATOR DECLARATIONS — PayPal CDS Extensions
// ================================================================================================
//
// These decorators capture PayPal-specific metadata from the Spanner DDL comments
// that have no direct mapping to standard TypeSpec built-in decorators.
//
// Implementation: Each decorator requires a corresponding JS implementation
// in the emitter to extract and use these metadata values.
// ================================================================================================

namespace PayPal.CustomerDataStore.Decorators;

// ── Data Classification ──────────────────────────────────────────────────────

/** InfoSec data classification level (Class 1 = most sensitive, Class 5 = least) */
extern dec infosecClass(target: unknown, classification: valueof string);

/** Marks a field or model as containing Personally Identifiable Information */
extern dec pii(target: unknown);

/** Marks a field or model as containing Payment Card Industry data */
extern dec pci(target: unknown);

/** Marks a field or model as containing Sensitive Personal Information */
extern dec spi(target: unknown);

/** Marks a field or model as a Critical Data Element per PayPal data governance */
extern dec cde(target: unknown);

// ── Encryption ───────────────────────────────────────────────────────────────

/** Declares application-layer encryption requirements for a field */
extern dec encrypted(target: unknown, keyRef: valueof string, algorithm: valueof string);

// ── Domain Ownership & Access Control ────────────────────────────────────────

/** Declares the owning domain team for write operations on this field */
extern dec ownedBy(target: unknown, team: valueof string);

/**
 * Declares OAuth scope requirements for field access.
 * readScopes: scopes required for reading this field
 * writeScopes: scopes required for writing this field (optional for read-only fields)
 */
extern dec accessScopes(
  target: unknown,
  readScopes: valueof string[],
  writeScopes?: valueof string[]
);

// ── Spanner-Specific ─────────────────────────────────────────────────────────

/**
 * Declares this model as interleaved within a parent table in Cloud Spanner.
 * Provides co-location of parent and child rows for optimal read performance.
 */
extern dec interleaveInParent(
  target: unknown,
  parentModel: valueof string,
  onDelete: valueof "CASCADE" | "NO_ACTION"
);

/** Marks a timestamp field as using Spanner commit timestamps */
extern dec commitTimestamp(target: unknown);

/** Marks a field as a Spanner placement key for geo-partitioning */
extern dec placementKey(target: unknown);

/** Marks a field as a Spanner generated/computed column */
extern dec computed(target: unknown, expression: valueof string);

/**
 * Declares a secondary index on the model.
 * Used to document Spanner index definitions alongside the model.
 */
extern dec spannerIndex(
  target: unknown,
  name: valueof string,
  columns: valueof string[],
  options?: valueof SpannerIndexOptions
);

model SpannerIndexOptions {
  unique?: boolean;
  nullFiltered?: boolean;
  description?: string;
}

// ── Schema Governance ────────────────────────────────────────────────────────

/** Links a field to an external JSON Schema definition in the schema registry */
extern dec schemaRef(target: unknown, ref: valueof string);

/** Declares data quality rules that must be enforced on this field */
extern dec dqRules(target: unknown, rules: valueof string[]);

// ── Table-Level Metadata ─────────────────────────────────────────────────────

/** Spanner table category classification */
extern dec tableCategory(target: unknown, category: valueof "TRANSACTIONAL" | "ANALYTICAL" | "METADATA");

/** Accountability metadata for the table */
extern dec accountability(target: unknown, ticketNumber: valueof string, owningDl: valueof string, agileTeam: valueof string);

/** Capacity planning estimates */
extern dec capacity(target: unknown, avgRowLenBytes: valueof int32);

/** Data provenance metadata */
extern dec dataProvenance(target: unknown, sourceSystem: valueof string, ingestionMethod: valueof string);

/** Data residency and geo-partitioning metadata */
extern dec dataResidency(
  target: unknown,
  geoPartitioned: valueof boolean,
  residencyRegions?: valueof string[]
);

/** Delete pattern used for the table */
extern dec deletePattern(target: unknown, pattern: valueof "HARD_DELETE" | "SOFT_DELETE");

// ── API Resource Metadata ────────────────────────────────────────────────────

/** Declares the REST resource path and configuration for a model */
extern dec apiResource(target: unknown, config: valueof ApiResourceConfig);

model ApiResourceConfig {
  basePath: string;
  singularName: string;
  pluralName: string;
  operations: string[];
  resourceScope?: string;
  defaultPageSize?: int32;
  parentEntity?: string;
  parentPathParam?: string;
}

/** Declares a named fieldset (projection) for the model */
extern dec fieldset(target: unknown, name: valueof string, description: valueof string, fields: valueof string[]);
