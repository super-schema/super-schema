import { describe, expect, it } from "vitest";
import {
  buildMappingMatrixRows,
  getMappingIntelligence,
} from "@/lib/type-mapping/mapping-intelligence";

describe("mapping-intelligence", () => {
  it("centralizes logical, target, example, and risk metadata for UI consumers", () => {
    const info = getMappingIntelligence({
      sourceType: "decimal",
      targetFormat: "openapi",
    });

    expect(info.source.label).toBe("decimal");
    expect(info.source.example).toContain("19.99");
    expect(info.target.displayName).toBe("OpenAPI (Super Schema)");
    expect(info.mapping.mappedType).toBe("number/double");
    expect(info.risk.category).toBe("precision");
    expect(info.risk.severity).toBe("high");
    expect(info.risk.exampleBefore).toContain("123456789012345.6789");
    expect(info.risk.possibleProblems).toEqual(
      expect.arrayContaining([expect.stringContaining("Financial")])
    );
  });

  it("treats safe override target types as safe", () => {
    const info = getMappingIntelligence({
      sourceType: "decimal",
      targetFormat: "openapi",
      mappedType: "string",
      defaultMappedType: "number/double",
      isOverride: true,
      overrideSource: "field",
    });

    expect(info.mapping.mappedType).toBe("string");
    expect(info.risk.severity).toBe("safe");
    expect(info.mapping.isLossy).toBe(false);
  });

  it("distinguishes safe mappings from risky range mappings", () => {
    const safe = getMappingIntelligence({
      sourceType: "string",
      targetFormat: "bigquery",
    });
    const risky = getMappingIntelligence({
      sourceType: "uint64",
      targetFormat: "bigquery",
    });

    expect(safe.risk.severity).toBe("safe");
    expect(safe.mapping.isLossy).toBe(false);
    expect(risky.risk.category).toBe("range");
    expect(risky.mapping.isLossy).toBe(true);
    expect(risky.risk.exampleBefore).toContain("18446744073709551615");
  });

  it("explains value-preserving Spanner int32 widening as validation risk", () => {
    const info = getMappingIntelligence({
      sourceType: "int32",
      targetFormat: "spanner",
    });

    expect(info.mapping.mappedType).toBe("INT64");
    expect(info.risk.category).toBe("validation");
    expect(info.risk.severity).toBe("low");
    expect(info.risk.description).toContain("outside the logical int32 range");
  });

  it("surfaces range and temporal risks for broad logical types", () => {
    const integer = getMappingIntelligence({
      sourceType: "integer",
      targetFormat: "postgresql",
    });
    const utcDateTime = getMappingIntelligence({
      sourceType: "utcDateTime",
      targetFormat: "bigquery",
    });

    expect(integer.risk.category).toBe("range");
    expect(integer.risk.description).toContain("arbitrary precision");
    expect(utcDateTime.risk.category).toBe("temporal");
    expect(utcDateTime.risk.description).toContain("instant");
  });

  it("builds a cross-target matrix from the same source of truth", () => {
    const rows = buildMappingMatrixRows({
      fields: [
        { id: "amount", name: "amount", type: "decimal", precision: 19, scale: 4 },
        { id: "externalId", name: "externalId", type: "uint64" },
      ],
      targets: ["bigquery", "openapi", "postgresql"],
    });

    expect(rows).toHaveLength(2);
    expect(rows[0].cells.openapi.mapping.mappedType).toBe("number/double");
    expect(rows[0].cells.openapi.risk.severity).toBe("high");
    expect(rows[1].cells.bigquery.risk.category).toBe("range");
    expect(rows[1].cells.postgresql.risk.severity).toBe("safe");
  });
});
