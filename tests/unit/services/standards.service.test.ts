/**
 * Unit tests for Standards Service — Story 11.2
 */
import { describe, it, expect } from "vitest";
import {
  getStandardTemplates,
  getStandardTemplate,
  reviewAgainstStandard,
  suggestFieldsFromStandard,
} from "@/services/standards.service";

describe("Standards Service", () => {
  // ── getStandardTemplates ─────────────────────────────────────────────

  describe("getStandardTemplates", () => {
    it("returns all templates without filters", () => {
      const result = getStandardTemplates();
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.length).toBeGreaterThan(0);
      }
    });

    it("filters by source", () => {
      const result = getStandardTemplates({ source: "financial" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.every((t) => t.source === "financial")).toBe(true);
      }
    });

    it("filters by query", () => {
      const result = getStandardTemplates({ query: "Person" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.some((t) => t.entityName === "Person")).toBe(true);
      }
    });

    it("results are sorted by source and entity name", () => {
      const result = getStandardTemplates();
      expect(result.success).toBe(true);
      if (result.success && result.data.length > 1) {
        for (let i = 1; i < result.data.length; i++) {
          const prev = result.data[i - 1];
          const curr = result.data[i];
          if (prev.source === curr.source) {
            expect(
              prev.entityName.localeCompare(curr.entityName)
            ).toBeLessThanOrEqual(0);
          }
        }
      }
    });
  });

  // ── getStandardTemplate ──────────────────────────────────────────────

  describe("getStandardTemplate", () => {
    it("finds a specific template", () => {
      const result = getStandardTemplate("schema.org", "Person");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.entityName).toBe("Person");
        expect(result.data.source).toBe("schema.org");
      }
    });

    it("returns error for non-existent template", () => {
      const result = getStandardTemplate("schema.org", "NonExistent");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });
  });

  // ── reviewAgainstStandard ────────────────────────────────────────────

  describe("reviewAgainstStandard", () => {
    it("correctly identifies matching fields", () => {
      const entityFields = [
        { name: "givenName", type: "string" },
        { name: "email", type: "string" },
        { name: "customField", type: "string" },
      ];

      const result = reviewAgainstStandard(entityFields, "schema.org", "Person");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.matching.length).toBe(2);
        expect(result.data.matching.some((f) => f.name === "givenName")).toBe(
          true
        );
        expect(result.data.matching.some((f) => f.name === "email")).toBe(true);
      }
    });

    it("correctly identifies missing fields", () => {
      const entityFields = [{ name: "givenName", type: "string" }];

      const result = reviewAgainstStandard(entityFields, "schema.org", "Person");
      expect(result.success).toBe(true);
      if (result.success) {
        // Person has 12 fields, we have 1 match, so 11 missing
        expect(result.data.missing.length).toBe(11);
        expect(result.data.missing.some((f) => f.name === "email")).toBe(true);
      }
    });

    it("correctly identifies extra fields", () => {
      const entityFields = [
        { name: "givenName", type: "string" },
        { name: "customField", type: "integer" },
        { name: "anotherExtra", type: "boolean" },
      ];

      const result = reviewAgainstStandard(entityFields, "schema.org", "Person");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.extra.length).toBe(2);
        expect(result.data.extra.some((f) => f.name === "customField")).toBe(
          true
        );
      }
    });

    it("calculates match percentage correctly", () => {
      // Person has 12 fields. Supply all 12.
      const entityFields = [
        { name: "givenName", type: "string" },
        { name: "familyName", type: "string" },
        { name: "email", type: "string" },
        { name: "telephone", type: "string" },
        { name: "birthDate", type: "date" },
        { name: "address", type: "string" },
        { name: "gender", type: "string" },
        { name: "nationality", type: "string" },
        { name: "jobTitle", type: "string" },
        { name: "worksFor", type: "reference" },
        { name: "url", type: "string" },
        { name: "image", type: "string" },
      ];

      const result = reviewAgainstStandard(entityFields, "schema.org", "Person");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.matchPercentage).toBe(100);
      }
    });

    it("returns 0% match for no matching fields", () => {
      const entityFields = [
        { name: "x", type: "string" },
        { name: "y", type: "integer" },
      ];

      const result = reviewAgainstStandard(entityFields, "schema.org", "Person");
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.matchPercentage).toBe(0);
      }
    });

    it("returns error for non-existent standard", () => {
      const result = reviewAgainstStandard(
        [{ name: "x", type: "string" }],
        "nonexistent",
        "Nothing"
      );
      expect(result.success).toBe(false);
    });
  });

  // ── suggestFieldsFromStandard ────────────────────────────────────────

  describe("suggestFieldsFromStandard", () => {
    it("returns fields for matching entity name", () => {
      const result = suggestFieldsFromStandard("Person", []);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.length).toBeGreaterThan(0);
      }
    });

    it("excludes fields that already exist", () => {
      const result = suggestFieldsFromStandard("Person", [
        "givenName",
        "email",
      ]);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.some((f) => f.name === "givenName")).toBe(false);
        expect(result.data.some((f) => f.name === "email")).toBe(false);
        expect(result.data.length).toBeGreaterThan(0); // still has other fields
      }
    });

    it("returns empty array when no standard matches", () => {
      const result = suggestFieldsFromStandard("XyzNonExistent", []);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.length).toBe(0);
      }
    });

    it("matches synonyms (Customer -> Person)", () => {
      const result = suggestFieldsFromStandard("Customer", []);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.length).toBeGreaterThan(0);
      }
    });

    it("matches plurals (Patients -> Patient)", () => {
      const result = suggestFieldsFromStandard("Patients", []);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.length).toBeGreaterThan(0);
      }
    });

    it("case-insensitive matching", () => {
      const result = suggestFieldsFromStandard("person", []);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.length).toBeGreaterThan(0);
      }
    });
  });
});
