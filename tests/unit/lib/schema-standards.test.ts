/**
 * Unit tests for Schema Standards Library — Story 11.2
 */
import { describe, it, expect } from "vitest";
import {
  getAllStandards,
  getStandardsBySource,
  findStandardByName,
  searchStandards,
} from "@/lib/schema-standards";
import schemaOrgData from "@/lib/schema-standards/schema-org.json";
import financialData from "@/lib/schema-standards/financial.json";
import healthcareFhirData from "@/lib/schema-standards/healthcare-fhir.json";
import { StandardTemplateSchema } from "@/types/schemas/standards";

const SUPPORTED_TYPES = [
  "string",
  "integer",
  "decimal",
  "boolean",
  "enum",
  "array",
  "map",
  "reference",
  "date",
  "timestamp",
];

describe("Schema Standards Library", () => {
  // ── JSON Validation ──────────────────────────────────────────────────

  describe("JSON standard files validation", () => {
    const allJsonData = [
      { name: "schema-org", data: schemaOrgData },
      { name: "financial", data: financialData },
      { name: "healthcare-fhir", data: healthcareFhirData },
    ];

    for (const { name, data } of allJsonData) {
      describe(`${name}.json`, () => {
        it("is a non-empty array", () => {
          expect(Array.isArray(data)).toBe(true);
          expect(data.length).toBeGreaterThan(0);
        });

        it("each template has required fields", () => {
          for (const template of data) {
            const result = StandardTemplateSchema.safeParse(template);
            expect(
              result.success,
              `Template "${(template as { entityName?: string }).entityName}" failed validation: ${!result.success ? JSON.stringify(result.error.issues) : ""}`
            ).toBe(true);
          }
        });

        it("each field has a valid type from the supported type system", () => {
          for (const template of data) {
            const t = template as { entityName: string; fields: { name: string; type: string }[] };
            for (const field of t.fields) {
              expect(
                SUPPORTED_TYPES.includes(field.type),
                `Field "${field.name}" in "${t.entityName}" has unsupported type "${field.type}"`
              ).toBe(true);
            }
          }
        });
      });
    }
  });

  // ── getAllStandards ──────────────────────────────────────────────────

  describe("getAllStandards", () => {
    it("returns all templates from all sources", () => {
      const all = getAllStandards();
      const totalExpected =
        schemaOrgData.length + financialData.length + healthcareFhirData.length;
      expect(all.length).toBe(totalExpected);
    });

    it("includes templates from each source", () => {
      const all = getAllStandards();
      const sources = new Set(all.map((t) => t.source));
      expect(sources).toContain("schema.org");
      expect(sources).toContain("financial");
      expect(sources).toContain("healthcare-fhir");
    });
  });

  // ── getStandardsBySource ─────────────────────────────────────────────

  describe("getStandardsBySource", () => {
    it("filters by schema.org", () => {
      const results = getStandardsBySource("schema.org");
      expect(results.length).toBe(schemaOrgData.length);
      expect(results.every((t) => t.source === "schema.org")).toBe(true);
    });

    it("filters by financial", () => {
      const results = getStandardsBySource("financial");
      expect(results.length).toBe(financialData.length);
      expect(results.every((t) => t.source === "financial")).toBe(true);
    });

    it("filters by healthcare-fhir", () => {
      const results = getStandardsBySource("healthcare-fhir");
      expect(results.length).toBe(healthcareFhirData.length);
      expect(results.every((t) => t.source === "healthcare-fhir")).toBe(true);
    });
  });

  // ── findStandardByName ───────────────────────────────────────────────

  describe("findStandardByName", () => {
    it("finds by exact name", () => {
      const result = findStandardByName("Person");
      expect(result).toBeDefined();
      expect(result?.entityName).toBe("Person");
      expect(result?.source).toBe("schema.org");
    });

    it("finds case-insensitively", () => {
      const result = findStandardByName("person");
      expect(result).toBeDefined();
      expect(result?.entityName).toBe("Person");
    });

    it("finds case-insensitively (uppercase)", () => {
      const result = findStandardByName("PATIENT");
      expect(result).toBeDefined();
      expect(result?.entityName).toBe("Patient");
    });

    it("returns undefined for non-existent name", () => {
      const result = findStandardByName("NonExistentEntity");
      expect(result).toBeUndefined();
    });
  });

  // ── searchStandards ──────────────────────────────────────────────────

  describe("searchStandards", () => {
    it("returns all standards for empty query", () => {
      const results = searchStandards("");
      expect(results.length).toBe(getAllStandards().length);
    });

    it("finds by entity name substring", () => {
      const results = searchStandards("Person");
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((t) => t.entityName === "Person")).toBe(true);
    });

    it("finds by description substring", () => {
      const results = searchStandards("financial");
      expect(results.length).toBeGreaterThan(0);
    });

    it("is case-insensitive", () => {
      const results = searchStandards("patient");
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((t) => t.entityName === "Patient")).toBe(true);
    });

    it("returns empty for non-matching query", () => {
      const results = searchStandards("xyznonexistent123");
      expect(results.length).toBe(0);
    });
  });
});
