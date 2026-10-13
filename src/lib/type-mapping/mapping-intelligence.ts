import { getTypeInfo } from "@/lib/data-types";
import {
  getDefaultMapping,
  getDefaultMappingsForTarget,
} from "@/lib/type-mapping/default-mappings";
import {
  getTargetTypeCatalogEntry,
  type TargetTypeOption,
} from "@/lib/type-mapping/target-type-catalog";

export type MappingRiskSeverity = "safe" | "low" | "medium" | "high" | "critical";

export type MappingRiskCategory =
  | "none"
  | "precision"
  | "range"
  | "temporal"
  | "semantic"
  | "structure"
  | "queryability"
  | "validation"
  | "missing";

export interface MappingRiskProfile {
  category: MappingRiskCategory;
  severity: MappingRiskSeverity;
  label: string;
  description: string;
  exampleBefore?: string;
  exampleAfter?: string;
  possibleProblems: string[];
  mitigations: string[];
}

export interface MappingIntelligenceInput {
  sourceType: string;
  targetFormat: string;
  mappedType?: string | null;
  defaultMappedType?: string | null;
  precision?: number | null;
  scale?: number | null;
  isLossy?: boolean;
  lossDescription?: string | null;
  overrideSource?: "field" | "global" | "per-entity";
  isOverride?: boolean;
  isStale?: boolean;
}

export interface MappingIntelligence {
  source: {
    type: string;
    label: string;
    description: string;
    example?: string;
    precision?: number;
    scale?: number;
  };
  target: {
    format: string;
    displayName: string;
    docsUrl?: string;
    docsSource?: string;
  };
  targetType?: TargetTypeOption;
  mapping: {
    mappedType: string;
    defaultMappedType?: string | null;
    isLossy: boolean;
    lossDescription?: string;
    isOverride: boolean;
    overrideSource?: "field" | "global" | "per-entity";
    isStale: boolean;
  };
  risk: MappingRiskProfile;
}

export interface MappingMatrixField {
  id: string;
  name: string;
  type: string;
  precision?: number | null;
  scale?: number | null;
}

export interface MappingMatrixRow {
  fieldId: string;
  fieldName: string;
  sourceType: string;
  sourceExample?: string;
  cells: Record<string, MappingIntelligence>;
}

export interface MappingHealthSummary {
  total: number;
  safe: number;
  risky: number;
  highRisk: number;
  unmapped: number;
  overrides: number;
  stale: number;
}

interface RiskRule {
  sourceType: string;
  targetFormat: string;
  mappedType?: string;
  risk: MappingRiskProfile;
}

const SAFE_RISK: MappingRiskProfile = {
  category: "none",
  severity: "safe",
  label: "Safe mapping",
  description: "The target type preserves the logical value shape for normal use.",
  possibleProblems: [],
  mitigations: [],
};

const MISSING_RISK: MappingRiskProfile = {
  category: "missing",
  severity: "critical",
  label: "Missing mapping",
  description: "No mapping exists for this logical type and target.",
  possibleProblems: [
    "The emitter may fall back to a broad string-like type or fail generation.",
    "Downstream consumers may receive a weaker schema than intended.",
  ],
  mitigations: [
    "Create a default or field-level mapping before publishing the schema.",
    "Verify generated output before deployment.",
  ],
};

const RISK_RULES: RiskRule[] = [
  ...[
    { targetFormat: "bigquery", mappedType: "INT64" },
    { targetFormat: "avro", mappedType: "long" },
    { targetFormat: "openapi", mappedType: "integer/int64" },
    { targetFormat: "spanner", mappedType: "INT64" },
    { targetFormat: "postgresql", mappedType: "integer" },
  ].map((rule): RiskRule => ({
    sourceType: "integer",
    targetFormat: rule.targetFormat,
    mappedType: rule.mappedType,
    risk: {
      category: "range",
      severity: "high",
      label: "Range risk",
      description: "The logical integer type is arbitrary precision, but the target type has a fixed numeric range.",
      exampleBefore: "999999999999999999999999",
      exampleAfter: `May exceed ${rule.mappedType}`,
      possibleProblems: ["Large valid logical integers can overflow or be rejected by the target system."],
      mitigations: ["Use decimal/numeric or string transport when the range is not bounded to the target integer width."],
    },
  })),
  ...["int8", "int16", "int32"].map((sourceType): RiskRule => ({
    sourceType,
    targetFormat: "spanner",
    mappedType: "INT64",
    risk: {
      category: "validation",
      severity: "low",
      label: "Validation risk",
      description: `Spanner stores ${sourceType} as INT64, so the datastore can accept values outside the logical ${sourceType} range unless validation enforces it.`,
      exampleBefore: sourceType === "int8" ? "-128 … 127" : sourceType === "int16" ? "-32768 … 32767" : "-2147483648 … 2147483647",
      exampleAfter: "INT64 accepts ±9.2 × 10¹⁸",
      possibleProblems: ["Direct writes outside Super Schema validation can store values the logical model would reject."],
      mitigations: ["Keep API/application validation on the logical integer range or add database-side checks where available."],
    },
  })),
  {
    sourceType: "utcDateTime",
    targetFormat: "bigquery",
    mappedType: "DATETIME",
    risk: {
      category: "temporal",
      severity: "medium",
      label: "Temporal risk",
      description: "BigQuery DATETIME stores calendar date/time without instant or timezone semantics.",
      exampleBefore: "2024-05-06T12:20:00Z",
      exampleAfter: "2024-05-06 12:20:00",
      possibleProblems: ["Consumers can interpret the same value in different timezones and shift the instant."],
      mitigations: ["Use TIMESTAMP when the field represents an instant in UTC."],
    },
  },
  {
    sourceType: "utcDateTime",
    targetFormat: "postgresql",
    mappedType: "timestamp",
    risk: {
      category: "temporal",
      severity: "medium",
      label: "Temporal risk",
      description: "PostgreSQL timestamp stores local date/time without instant or timezone semantics.",
      exampleBefore: "2024-05-06T12:20:00Z",
      exampleAfter: "2024-05-06 12:20:00",
      possibleProblems: ["Timezone conversions can shift the intended instant during reads or writes."],
      mitigations: ["Use timestamptz when the field represents an instant in UTC."],
    },
  },
  {
    sourceType: "uint64",
    targetFormat: "bigquery",
    mappedType: "INT64",
    risk: {
      category: "range",
      severity: "high",
      label: "Range risk",
      description: "BigQuery INT64 is signed; uint64 can exceed the signed 64-bit ceiling.",
      exampleBefore: "18446744073709551615",
      exampleAfter: "Cannot fit above 9223372036854775807",
      possibleProblems: [
        "Large identifiers or counters may overflow, fail load jobs, or be clipped by conversion code.",
      ],
      mitigations: [
        "Use STRING when preserving the full unsigned range matters.",
        "Use NUMERIC only when arithmetic is required and consumers handle the format.",
      ],
    },
  },
  {
    sourceType: "uint64",
    targetFormat: "spanner",
    mappedType: "INT64",
    risk: {
      category: "range",
      severity: "high",
      label: "Range risk",
      description: "Spanner INT64 is signed; uint64 can exceed the signed 64-bit ceiling.",
      exampleBefore: "18446744073709551615",
      exampleAfter: "Cannot fit above 9223372036854775807",
      possibleProblems: ["Writes can fail for values above the signed INT64 range."],
      mitigations: ["Use STRING(MAX) for opaque IDs that need the full uint64 range."],
    },
  },
  {
    sourceType: "uint64",
    targetFormat: "avro",
    mappedType: "long",
    risk: {
      category: "range",
      severity: "high",
      label: "Range risk",
      description: "Avro long is signed; uint64 can exceed the signed 64-bit ceiling.",
      exampleBefore: "18446744073709551615",
      exampleAfter: "Cannot fit above 9223372036854775807",
      possibleProblems: ["Consumers can decode an invalid or rounded value."],
      mitigations: ["Use string for opaque unsigned identifiers."],
    },
  },
  {
    sourceType: "uint64",
    targetFormat: "openapi",
    mappedType: "integer/int64",
    risk: {
      category: "range",
      severity: "high",
      label: "Range risk",
      description: "OpenAPI int64 communicates a signed 64-bit range, not the full uint64 range.",
      exampleBefore: "18446744073709551615",
      exampleAfter: "Cannot fit above 9223372036854775807",
      possibleProblems: ["Generated clients can reject valid logical values."],
      mitigations: ["Use string with a numeric pattern for full-range unsigned IDs."],
    },
  },
  {
    sourceType: "decimal",
    targetFormat: "openapi",
    mappedType: "number/double",
    risk: {
      category: "precision",
      severity: "high",
      label: "Precision risk",
      description: "OpenAPI number/double uses float64 and cannot represent every exact decimal.",
      exampleBefore: "123456789012345.6789",
      exampleAfter: "123456789012345.67",
      possibleProblems: [
        "Financial totals, tax values, and balances may drift after serialization.",
        "Equality comparisons can fail after round-trip conversion.",
      ],
      mitigations: [
        "Use a string decimal representation with pattern validation for APIs.",
        "Keep exact numeric target types for datastore schemas that support them.",
      ],
    },
  },
  {
    sourceType: "decimal128",
    targetFormat: "openapi",
    mappedType: "number/double",
    risk: {
      category: "precision",
      severity: "high",
      label: "Precision risk",
      description: "Decimal128 can exceed float64 precision by a wide margin.",
      exampleBefore: "99999999999.99999999",
      exampleAfter: "100000000000",
      possibleProblems: ["High-precision measurements or balances can be rounded."],
      mitigations: ["Use string transport for exact Decimal128 values."],
    },
  },
  {
    sourceType: "decimal",
    targetFormat: "spanner",
    mappedType: "NUMERIC",
    risk: {
      category: "precision",
      severity: "medium",
      label: "Precision risk",
      description: "Spanner NUMERIC has fixed precision and scale rather than arbitrary decimal settings.",
      exampleBefore: "decimal(50,12)",
      exampleAfter: "NUMERIC(38,9)",
      possibleProblems: ["Values outside Spanner NUMERIC limits may fail or require rounding."],
      mitigations: ["Use STRING(MAX) for values that exceed NUMERIC(38,9)."],
    },
  },
  {
    sourceType: "decimal128",
    targetFormat: "spanner",
    mappedType: "NUMERIC",
    risk: {
      category: "precision",
      severity: "high",
      label: "Precision risk",
      description: "Decimal128 can exceed Spanner NUMERIC limits.",
      exampleBefore: "34 significant digits with custom scale",
      exampleAfter: "NUMERIC(38,9)",
      possibleProblems: ["Scale beyond 9 can be rounded or rejected."],
      mitigations: ["Use STRING(MAX) if exact lexical preservation matters."],
    },
  },
  {
    sourceType: "offsetDateTime",
    targetFormat: "bigquery",
    mappedType: "TIMESTAMP",
    risk: {
      category: "temporal",
      severity: "medium",
      label: "Temporal risk",
      description: "BigQuery TIMESTAMP stores an instant, not the original UTC offset.",
      exampleBefore: "2024-05-06T12:20:00-07:00",
      exampleAfter: "2024-05-06T19:20:00Z",
      possibleProblems: ["The original local offset can no longer be reconstructed."],
      mitigations: ["Store the offset or source timezone in a companion field when it has business meaning."],
    },
  },
  {
    sourceType: "offsetDateTime",
    targetFormat: "spanner",
    mappedType: "TIMESTAMP",
    risk: {
      category: "temporal",
      severity: "medium",
      label: "Temporal risk",
      description: "Spanner TIMESTAMP normalizes offsetDateTime values to an instant.",
      exampleBefore: "2024-05-06T12:20:00-07:00",
      exampleAfter: "2024-05-06T19:20:00Z",
      possibleProblems: ["The source offset is lost after normalization."],
      mitigations: ["Persist timezone context separately when required."],
    },
  },
  {
    sourceType: "offsetDateTime",
    targetFormat: "avro",
    mappedType: "long/timestamp-millis",
    risk: {
      category: "temporal",
      severity: "medium",
      label: "Temporal risk",
      description: "Avro timestamp logical types represent UTC instants.",
      exampleBefore: "2024-05-06T12:20:00-07:00",
      exampleAfter: "2024-05-06T19:20:00Z",
      possibleProblems: ["Original offset semantics are unavailable to consumers."],
      mitigations: ["Add a timezone or offset field if the local wall time matters."],
    },
  },
  {
    sourceType: "duration",
    targetFormat: "bigquery",
    mappedType: "STRING",
    risk: {
      category: "queryability",
      severity: "medium",
      label: "Queryability risk",
      description: "Duration is stored as text because the target has no equivalent duration type.",
      exampleBefore: "P1Y2M3DT4H5M",
      exampleAfter: "\"P1Y2M3DT4H5M\"",
      possibleProblems: ["Duration arithmetic and range filters require custom parsing."],
      mitigations: ["Store normalized seconds or component fields if analytics need arithmetic."],
    },
  },
  {
    sourceType: "duration",
    targetFormat: "spanner",
    mappedType: "STRING(MAX)",
    risk: {
      category: "queryability",
      severity: "medium",
      label: "Queryability risk",
      description: "Duration is stored as text because Spanner has no native duration type.",
      exampleBefore: "P1Y2M3DT4H5M",
      exampleAfter: "\"P1Y2M3DT4H5M\"",
      possibleProblems: ["Duration arithmetic is not available without parsing."],
      mitigations: ["Store normalized seconds when querying durations."],
    },
  },
  {
    sourceType: "map",
    targetFormat: "bigquery",
    mappedType: "JSON",
    risk: {
      category: "queryability",
      severity: "medium",
      label: "Queryability risk",
      description: "Map values are stored as JSON; BigQuery can query keys, but not as typed columns.",
      exampleBefore: "{\"a\": 1, \"b\": 2}",
      exampleAfter: "JSON '{\"a\":1,\"b\":2}'",
      possibleProblems: ["Ad-hoc keys are preserved, but typed key/value constraints and column statistics are weaker."],
      mitigations: ["Model stable keys as STRUCT fields or keep the JSON map for dynamic attributes."],
    },
  },
  {
    sourceType: "map",
    targetFormat: "spanner",
    mappedType: "JSON",
    risk: {
      category: "queryability",
      severity: "medium",
      label: "Queryability risk",
      description: "Map is stored as JSON, so individual values are less strongly typed.",
      exampleBefore: "{\"key\": \"value\"}",
      exampleAfter: "JSON",
      possibleProblems: ["Typed key-value access and constraints are weakened."],
      mitigations: ["Promote stable keys to columns if they are queried or constrained."],
    },
  },
  {
    sourceType: "object",
    targetFormat: "spanner",
    mappedType: "JSON",
    risk: {
      category: "queryability",
      severity: "medium",
      label: "Queryability risk",
      description: "Nested objects are stored as JSON rather than typed columns.",
      exampleBefore: "{ name: string, age: int32 }",
      exampleAfter: "JSON",
      possibleProblems: ["Nested field constraints and typed access are weaker."],
      mitigations: ["Flatten important fields or use a separate child entity."],
    },
  },
  ...["bigquery", "avro", "spanner", "postgresql"].map((targetFormat): RiskRule => ({
    sourceType: "reference",
    targetFormat,
    mappedType: targetFormat === "postgresql" ? "uuid" : targetFormat === "spanner" ? "STRING(MAX)" : "string",
    risk: {
      category: "semantic",
      severity: "medium",
      label: "Semantic risk",
      description: "A logical relationship is represented as a scalar identifier.",
      exampleBefore: "Customer → Order",
      exampleAfter: targetFormat === "postgresql" ? "uuid" : "string identifier",
      possibleProblems: ["Relationship cardinality, referential integrity, or identifier format can be lost."],
      mitigations: ["Add explicit foreign-key constraints where the target supports them."],
    },
  })),
];




export function getMappingIntelligence(input: MappingIntelligenceInput): MappingIntelligence {
  const defaultMapping = getDefaultMapping(input.sourceType, input.targetFormat);
  const mappedType = input.mappedType ?? defaultMapping?.mappedType ?? "UNMAPPED";
  const defaultMappingApplies = mappedType === defaultMapping?.mappedType;
  const defaultMappedType = input.defaultMappedType ?? defaultMapping?.mappedType ?? null;
  const isLossy = input.isLossy ?? (defaultMappingApplies ? defaultMapping?.isLossy ?? false : false);
  const lossDescription = input.lossDescription ?? (
    defaultMappingApplies ? defaultMapping?.lossDescription ?? undefined : undefined
  );
  const sourceInfo = getTypeInfo(input.sourceType);
  const targetCatalog = getTargetTypeCatalogEntry(input.targetFormat);
  const targetType = targetCatalog?.options.find((option) => option.value === mappedType);
  const explicitRisk = RISK_RULES.find(
    (rule) =>
      rule.sourceType === input.sourceType &&
      rule.targetFormat === input.targetFormat &&
      (!rule.mappedType || rule.mappedType === mappedType)
  )?.risk;
  const risk = mappedType === "UNMAPPED"
    ? MISSING_RISK
    : explicitRisk ?? (
      isLossy && lossDescription
        ? {
          category: "semantic",
          severity: "medium",
          label: "Data quality risk",
          description: lossDescription,
          possibleProblems: [lossDescription],
          mitigations: [
            "Review the generated target type and add an override if the default is too broad.",
          ],
        }
        : SAFE_RISK
    );

  return {
    source: {
      type: input.sourceType,
      label: sourceInfo?.label ?? input.sourceType,
      description: sourceInfo?.description ?? "Custom logical type",
      example: sourceInfo?.example,
      precision: input.precision ?? undefined,
      scale: input.scale ?? undefined,
    },
    target: {
      format: input.targetFormat,
      displayName: targetCatalog?.displayName ?? input.targetFormat,
      docsUrl: targetCatalog?.docsUrl,
      docsSource: targetCatalog?.docsSource,
    },
    targetType,
    mapping: {
      mappedType,
      defaultMappedType,
      isLossy: isLossy || risk.severity !== "safe",
      lossDescription: lossDescription ?? (risk.severity !== "safe" ? risk.description : undefined),
      isOverride: input.isOverride ?? Boolean(input.overrideSource),
      overrideSource: input.overrideSource,
      isStale: input.isStale ?? false,
    },
    risk,
  };
}

export function getMappingsForTarget(targetFormat: string): MappingIntelligence[] {
  return getDefaultMappingsForTarget(targetFormat).map((mapping) =>
    getMappingIntelligence({
      sourceType: mapping.sourceType,
      targetFormat,
      mappedType: mapping.mappedType,
      isLossy: mapping.isLossy,
      lossDescription: mapping.lossDescription,
    })
  );
}

export function buildMappingMatrixRows(input: {
  fields: MappingMatrixField[];
  targets: string[];
}): MappingMatrixRow[] {
  return input.fields.map((field) => {
    const cells: Record<string, MappingIntelligence> = {};
    for (const target of input.targets) {
      cells[target] = getMappingIntelligence({
        sourceType: field.type,
        targetFormat: target,
        precision: field.precision,
        scale: field.scale,
      });
    }

    return {
      fieldId: field.id,
      fieldName: field.name,
      sourceType: field.type,
      sourceExample: getTypeInfo(field.type)?.example,
      cells,
    };
  });
}

export function summarizeMappingHealth(items: MappingIntelligence[]): MappingHealthSummary {
  let safe = 0;
  let risky = 0;
  let highRisk = 0;
  let unmapped = 0;
  let overrides = 0;
  let stale = 0;

  for (const item of items) {
    if (item.risk.severity === "safe") {
      safe += 1;
    } else {
      risky += 1;
    }
    if (item.risk.severity === "high" || item.risk.severity === "critical") {
      highRisk += 1;
    }
    if (item.risk.category === "missing") {
      unmapped += 1;
    }
    if (item.mapping.isOverride) {
      overrides += 1;
    }
    if (item.mapping.isStale) {
      stale += 1;
    }
  }

  return {
    total: items.length,
    safe,
    risky,
    highRisk,
    unmapped,
    overrides,
    stale,
  };
}
