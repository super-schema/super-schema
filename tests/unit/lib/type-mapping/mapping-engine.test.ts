import { describe, it, expect } from "vitest";
import {
  resolveMapping,
  resolveMappingWithPrecision,
  resolveMappingsForFields,
  hasLossyMappings,
  getLossyMappings,
  getFailedMappings,
} from "@/lib/type-mapping/mapping-engine";
import {
  getDefaultPolicies,
  getDefaultMappingsForTarget,
  getDefaultMapping,
  DEFAULT_MAPPINGS,
} from "@/lib/type-mapping/default-mappings";
import type { ScopedMappingPolicy } from "@/lib/type-mapping/types";

// ---------------------------------------------------------------------------
// Helper — get all default policies as ScopedMappingPolicy[]
// ---------------------------------------------------------------------------

const allPolicies = getDefaultPolicies();

// ---------------------------------------------------------------------------
// BigQuery default mappings
// ---------------------------------------------------------------------------

describe("BigQuery default mappings", () => {
  const bqMappings: Array<[string, string]> = [
    ["string", "STRING"],
    ["url", "STRING"],
    ["integer", "INT64"],
    ["int8", "INT64"],
    ["int16", "INT64"],
    ["int32", "INT64"],
    ["int64", "INT64"],
    ["safeint", "INT64"],
    ["uint8", "INT64"],
    ["uint16", "INT64"],
    ["uint32", "INT64"],
    ["numeric", "NUMERIC"],
    ["float", "FLOAT64"],
    ["float32", "FLOAT64"],
    ["float64", "FLOAT64"],
    ["decimal", "NUMERIC"],
    ["decimal128", "BIGNUMERIC"],
    ["boolean", "BOOL"],
    ["bytes", "BYTES"],
    ["plainDate", "DATE"],
    ["plainTime", "TIME"],
    ["utcDateTime", "DATETIME"],
    ["offsetDateTime", "TIMESTAMP"],
    ["unixTimestamp32", "TIMESTAMP"],
    ["enum", "STRING"],
    ["array", "ARRAY"],
    ["map", "STRUCT"],
    ["object", "STRUCT"],
  ];

  it.each(bqMappings)(
    "maps %s → %s",
    (sourceType, expectedType) => {
      const result = resolveMapping(sourceType, "bigquery", allPolicies);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.mappedType).toBe(expectedType);
        expect(result.result.isOverride).toBe(false);
      }
    }
  );
});

// ---------------------------------------------------------------------------
// Avro default mappings
// ---------------------------------------------------------------------------

describe("Avro default mappings", () => {
  const avroMappings: Array<[string, string]> = [
    ["string", "string"],
    ["url", "string"],
    ["integer", "long"],
    ["int8", "int"],
    ["int16", "int"],
    ["int32", "int"],
    ["int64", "long"],
    ["safeint", "long"],
    ["uint8", "int"],
    ["uint16", "int"],
    ["uint32", "long"],
    ["numeric", "bytes/decimal"],
    ["float", "double"],
    ["float32", "float"],
    ["float64", "double"],
    ["decimal", "bytes/decimal"],
    ["decimal128", "bytes/decimal"],
    ["boolean", "boolean"],
    ["bytes", "bytes"],
    ["plainDate", "int/date"],
    ["plainTime", "long/time-micros"],
    ["utcDateTime", "long/timestamp-millis"],
    ["offsetDateTime", "long/timestamp-millis"],
    ["duration", "fixed/duration"],
    ["unixTimestamp32", "long/timestamp-millis"],
    ["enum", "enum"],
    ["array", "array"],
    ["map", "map"],
    ["object", "record"],
  ];

  it.each(avroMappings)(
    "maps %s → %s",
    (sourceType, expectedType) => {
      const result = resolveMapping(sourceType, "avro", allPolicies);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.mappedType).toBe(expectedType);
        expect(result.result.isOverride).toBe(false);
      }
    }
  );
});

// ---------------------------------------------------------------------------
// OpenAPI default mappings
// ---------------------------------------------------------------------------

describe("OpenAPI default mappings", () => {
  const openApiMappings: Array<[string, string]> = [
    ["string", "string"],
    ["url", "string/uri"],
    ["integer", "integer/int64"],
    ["int8", "integer/int32"],
    ["int16", "integer/int32"],
    ["int32", "integer/int32"],
    ["int64", "integer/int64"],
    ["safeint", "integer/int64"],
    ["uint8", "integer/int32"],
    ["uint16", "integer/int32"],
    ["uint32", "integer/int64"],
    ["numeric", "number"],
    ["float", "number/float"],
    ["float32", "number/float"],
    ["float64", "number/double"],
    ["decimal", "number/double"],
    ["decimal128", "number/double"],
    ["boolean", "boolean"],
    ["bytes", "string/byte"],
    ["plainDate", "string/date"],
    ["plainTime", "string/time"],
    ["utcDateTime", "string/date-time"],
    ["offsetDateTime", "string/date-time"],
    ["duration", "string/duration"],
    ["unixTimestamp32", "integer/int32"],
    ["enum", "string+enum"],
    ["array", "array"],
    ["map", "object/additionalProperties"],
    ["object", "object"],
    ["reference", "$ref"],
  ];

  it.each(openApiMappings)(
    "maps %s → %s",
    (sourceType, expectedType) => {
      const result = resolveMapping(sourceType, "openapi", allPolicies);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result.mappedType).toBe(expectedType);
        expect(result.result.isOverride).toBe(false);
      }
    }
  );
});

// ---------------------------------------------------------------------------
// Lossy mapping detection
// ---------------------------------------------------------------------------

describe("Lossy mapping detection", () => {
  it("flags map → STRUCT as lossy in BigQuery", () => {
    const result = resolveMapping("map", "bigquery", allPolicies);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.isLossy).toBe(true);
      expect(result.result.lossDescription).toContain("key ordering");
    }
  });

  it("flags decimal → number/double as lossy in OpenAPI", () => {
    const result = resolveMapping("decimal", "openapi", allPolicies);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.isLossy).toBe(true);
      expect(result.result.lossDescription).toContain("15 significant digits");
    }
  });

  it("flags decimal128 → number/double as lossy in OpenAPI", () => {
    const result = resolveMapping("decimal128", "openapi", allPolicies);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.isLossy).toBe(true);
      expect(result.result.lossDescription).toContain("Decimal128");
    }
  });

  it("flags uint64 → INT64 as lossy in BigQuery", () => {
    const result = resolveMapping("uint64", "bigquery", allPolicies);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.isLossy).toBe(true);
      expect(result.result.lossDescription).toContain("uint64");
    }
  });

  it("flags offsetDateTime → long/timestamp-millis as lossy in Avro", () => {
    const result = resolveMapping("offsetDateTime", "avro", allPolicies);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.isLossy).toBe(true);
      expect(result.result.lossDescription).toContain("offset");
    }
  });

  it("marks string → STRING as non-lossy in BigQuery", () => {
    const result = resolveMapping("string", "bigquery", allPolicies);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.isLossy).toBe(false);
      expect(result.result.lossDescription).toBeUndefined();
    }
  });

  it("marks integer → long as non-lossy in Avro", () => {
    const result = resolveMapping("integer", "avro", allPolicies);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.isLossy).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Override precedence
// ---------------------------------------------------------------------------

describe("Override precedence", () => {
  it("global override takes precedence over default", () => {
    const policiesWithOverride: ScopedMappingPolicy[] = [
      ...allPolicies,
      {
        sourceType: "string",
        targetType: "TEXT",
        targetFormat: "bigquery",
        mappedType: "TEXT",
        isOverride: true,
        isLossy: false,
      },
    ];

    const result = resolveMapping("string", "bigquery", policiesWithOverride);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.mappedType).toBe("TEXT");
      expect(result.result.isOverride).toBe(true);
    }
  });

  it("per-entity override takes precedence over global override", () => {
    const policiesWithOverrides: ScopedMappingPolicy[] = [
      ...allPolicies,
      {
        sourceType: "string",
        targetType: "TEXT",
        targetFormat: "bigquery",
        mappedType: "TEXT",
        isOverride: true,
        isLossy: false,
      },
      {
        sourceType: "string",
        targetType: "VARCHAR",
        targetFormat: "bigquery",
        mappedType: "VARCHAR",
        isOverride: true,
        isLossy: false,
        entityId: "entity-1",
      },
    ];

    const result = resolveMapping(
      "string",
      "bigquery",
      policiesWithOverrides,
      "entity-1"
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.mappedType).toBe("VARCHAR");
      expect(result.result.isOverride).toBe(true);
    }
  });

  it("falls back to global override when no per-entity override matches", () => {
    const policiesWithOverrides: ScopedMappingPolicy[] = [
      ...allPolicies,
      {
        sourceType: "string",
        targetType: "TEXT",
        targetFormat: "bigquery",
        mappedType: "TEXT",
        isOverride: true,
        isLossy: false,
      },
      {
        sourceType: "string",
        targetType: "VARCHAR",
        targetFormat: "bigquery",
        mappedType: "VARCHAR",
        isOverride: true,
        isLossy: false,
        entityId: "entity-1",
      },
    ];

    // Different entity ID — should fall back to global override
    const result = resolveMapping(
      "string",
      "bigquery",
      policiesWithOverrides,
      "entity-2"
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.mappedType).toBe("TEXT");
      expect(result.result.isOverride).toBe(true);
    }
  });

  it("override can mark a non-lossy mapping as lossy", () => {
    const policiesWithOverride: ScopedMappingPolicy[] = [
      ...allPolicies,
      {
        sourceType: "string",
        targetType: "BYTES",
        targetFormat: "bigquery",
        mappedType: "BYTES",
        isOverride: true,
        isLossy: true,
        lossDescription: "Encoding may lose Unicode normalization",
      },
    ];

    const result = resolveMapping("string", "bigquery", policiesWithOverride);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.isLossy).toBe(true);
      expect(result.result.lossDescription).toContain("Unicode");
    }
  });
});

// ---------------------------------------------------------------------------
// Missing mapping — error with suggestedFix
// ---------------------------------------------------------------------------

describe("Missing mapping error", () => {
  it("returns error with suggestedFix for unknown source type", () => {
    const result = resolveMapping("unknownType", "bigquery", allPolicies);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("MAPPING_NOT_FOUND");
      expect(result.error.suggestedFix).toBeDefined();
      expect(result.error.sourceType).toBe("unknownType");
      expect(result.error.targetFormat).toBe("bigquery");
    }
  });

  it("returns error with suggestedFix for unknown target format", () => {
    const result = resolveMapping("string", "snowflake", allPolicies);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("MAPPING_NOT_FOUND");
      expect(result.error.suggestedFix).toContain("snowflake");
    }
  });

  it("returns error when policies array is empty", () => {
    const result = resolveMapping("string", "bigquery", []);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("MAPPING_NOT_FOUND");
    }
  });
});

// ---------------------------------------------------------------------------
// Decimal precision/scale interpolation
// ---------------------------------------------------------------------------

describe("Decimal precision/scale interpolation", () => {
  it("interpolates NUMERIC(p,s) for BigQuery decimal", () => {
    const result = resolveMappingWithPrecision(
      "decimal",
      "bigquery",
      allPolicies,
      10,
      2
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.mappedType).toBe("NUMERIC(10,2)");
    }
  });

  it("interpolates BIGNUMERIC(p,s) for BigQuery decimal128", () => {
    const result = resolveMappingWithPrecision(
      "decimal128",
      "bigquery",
      allPolicies,
      38,
      10
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.mappedType).toBe("BIGNUMERIC(38,10)");
    }
  });

  it("does not interpolate for Avro (precision is in schema metadata)", () => {
    const result = resolveMappingWithPrecision(
      "decimal",
      "avro",
      allPolicies,
      10,
      2
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.mappedType).toBe("bytes/decimal");
    }
  });

  it("does not interpolate for OpenAPI", () => {
    const result = resolveMappingWithPrecision(
      "decimal",
      "openapi",
      allPolicies,
      10,
      2
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.mappedType).toBe("number/double");
    }
  });

  it("returns base type when no precision/scale provided", () => {
    const result = resolveMappingWithPrecision(
      "decimal",
      "bigquery",
      allPolicies
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result.mappedType).toBe("NUMERIC");
    }
  });
});

// ---------------------------------------------------------------------------
// Batch resolution
// ---------------------------------------------------------------------------

describe("Batch resolution", () => {
  it("resolves mappings for multiple fields", () => {
    const fields = [
      { name: "id", type: "string" },
      { name: "amount", type: "decimal", precision: 10, scale: 2 },
      { name: "isActive", type: "boolean" },
      { name: "tags", type: "array" },
    ];

    const results = resolveMappingsForFields(fields, "bigquery", allPolicies);

    expect(results).toHaveLength(4);
    expect(results[0].fieldName).toBe("id");
    expect(results[0].result.success).toBe(true);
    if (results[0].result.success) {
      expect(results[0].result.result.mappedType).toBe("STRING");
    }
    expect(results[1].fieldName).toBe("amount");
    if (results[1].result.success) {
      expect(results[1].result.result.mappedType).toBe("NUMERIC(10,2)");
    }
  });

  it("detects lossy mappings in batch", () => {
    const fields = [
      { name: "name", type: "string" },
      { name: "metadata", type: "map" },
      { name: "score", type: "decimal" },
    ];

    const results = resolveMappingsForFields(fields, "bigquery", allPolicies);
    expect(hasLossyMappings(results)).toBe(true);

    const lossy = getLossyMappings(results);
    expect(lossy).toHaveLength(1);
    expect(lossy[0].fieldName).toBe("metadata");
  });

  it("detects failed mappings in batch", () => {
    const fields = [
      { name: "name", type: "string" },
      { name: "custom", type: "unknownType" },
    ];

    const results = resolveMappingsForFields(fields, "bigquery", allPolicies);
    const failed = getFailedMappings(results);
    expect(failed).toHaveLength(1);
    expect(failed[0].fieldName).toBe("custom");
  });
});

// ---------------------------------------------------------------------------
// Default mappings data integrity
// ---------------------------------------------------------------------------

describe("Default mappings data integrity", () => {
  it("has mappings for all three target formats", () => {
    const bq = getDefaultMappingsForTarget("bigquery");
    const avro = getDefaultMappingsForTarget("avro");
    const openapi = getDefaultMappingsForTarget("openapi");

    expect(bq.length).toBeGreaterThan(0);
    expect(avro.length).toBeGreaterThan(0);
    expect(openapi.length).toBeGreaterThan(0);
  });

  it("has no duplicate entries per source+target combination", () => {
    const seen = new Set<string>();
    for (const entry of DEFAULT_MAPPINGS) {
      const key = `${entry.sourceType}:${entry.targetFormat}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it("getDefaultMapping returns correct entry", () => {
    const entry = getDefaultMapping("string", "bigquery");
    expect(entry).toBeDefined();
    expect(entry!.mappedType).toBe("STRING");
    expect(entry!.isLossy).toBe(false);
  });

  it("getDefaultMapping returns undefined for unknown combination", () => {
    const entry = getDefaultMapping("string", "snowflake");
    expect(entry).toBeUndefined();
  });

  it("every lossy mapping has a lossDescription", () => {
    const lossy = DEFAULT_MAPPINGS.filter((m) => m.isLossy);
    for (const m of lossy) {
      expect(m.lossDescription).toBeDefined();
      expect(m.lossDescription!.length).toBeGreaterThan(0);
    }
  });

  it("getDefaultPolicies returns ScopedMappingPolicy objects", () => {
    const policies = getDefaultPolicies();
    expect(policies.length).toBe(DEFAULT_MAPPINGS.length);
    for (const p of policies) {
      expect(p.isOverride).toBe(false);
      expect(p.sourceType).toBeDefined();
      expect(p.targetFormat).toBeDefined();
      expect(p.mappedType).toBeDefined();
    }
  });
});
