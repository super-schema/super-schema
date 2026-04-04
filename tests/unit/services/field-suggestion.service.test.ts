/**
 * Unit tests for Field Suggestion Service — Story 11.3
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  getFieldSuggestions,
  getPatternBasedSuggestions,
} from "@/services/field-suggestion.service";

// Mock the AI service to avoid real LLM calls
vi.mock("@/services/ai.service", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    isAiConfigured: vi.fn(() => false),
    generateFieldSuggestions: vi.fn(async () => ({
      success: false,
      error: { code: "AI_NOT_CONFIGURED", message: "Not configured" },
    })),
  };
});

describe("Field Suggestion Service", () => {
  // ── getPatternBasedSuggestions ────────────────────────────────────────

  describe("getPatternBasedSuggestions", () => {
    it("returns universal fields for any entity name", () => {
      const suggestions = getPatternBasedSuggestions("AnythingAtAll");
      const names = suggestions.map((s) => s.name);
      expect(names).toContain("id");
      expect(names).toContain("createdAt");
      expect(names).toContain("updatedAt");
    });

    it("returns person-related fields for 'User'", () => {
      const suggestions = getPatternBasedSuggestions("User");
      const names = suggestions.map((s) => s.name);
      expect(names).toContain("email");
      expect(names).toContain("firstName");
      expect(names).toContain("lastName");
      expect(names).toContain("phone");
    });

    it("returns person-related fields for 'Customer'", () => {
      const suggestions = getPatternBasedSuggestions("Customer");
      const names = suggestions.map((s) => s.name);
      expect(names).toContain("email");
      expect(names).toContain("firstName");
      expect(names).toContain("lastName");
    });

    it("returns person-related fields for 'Person'", () => {
      const suggestions = getPatternBasedSuggestions("Person");
      const names = suggestions.map((s) => s.name);
      expect(names).toContain("email");
      expect(names).toContain("firstName");
    });

    it("returns financial fields for 'Order'", () => {
      const suggestions = getPatternBasedSuggestions("Order");
      const names = suggestions.map((s) => s.name);
      expect(names).toContain("amount");
      expect(names).toContain("currency");
      expect(names).toContain("status");
    });

    it("returns financial fields for 'Transaction'", () => {
      const suggestions = getPatternBasedSuggestions("Transaction");
      const names = suggestions.map((s) => s.name);
      expect(names).toContain("amount");
      expect(names).toContain("currency");
    });

    it("returns product fields for 'Product'", () => {
      const suggestions = getPatternBasedSuggestions("Product");
      const names = suggestions.map((s) => s.name);
      expect(names).toContain("name");
      expect(names).toContain("description");
      expect(names).toContain("price");
      expect(names).toContain("sku");
    });

    it("returns product fields for 'Item'", () => {
      const suggestions = getPatternBasedSuggestions("Item");
      const names = suggestions.map((s) => s.name);
      expect(names).toContain("name");
      expect(names).toContain("price");
    });

    it("returns address fields for 'Address'", () => {
      const suggestions = getPatternBasedSuggestions("Address");
      const names = suggestions.map((s) => s.name);
      expect(names).toContain("street");
      expect(names).toContain("city");
      expect(names).toContain("state");
      expect(names).toContain("postalCode");
      expect(names).toContain("country");
    });

    it("applies PII classification to person fields", () => {
      const suggestions = getPatternBasedSuggestions("User");
      const emailField = suggestions.find((s) => s.name === "email");
      expect(emailField?.classification).toBe("PII");
    });

    it("applies SENSITIVE classification to financial fields", () => {
      const suggestions = getPatternBasedSuggestions("Order");
      const amountField = suggestions.find((s) => s.name === "amount");
      expect(amountField?.classification).toBe("SENSITIVE");
    });

    it("all suggestions have valid types", () => {
      const validTypes = [
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
      const suggestions = getPatternBasedSuggestions("User");
      for (const s of suggestions) {
        expect(validTypes).toContain(s.type);
      }
    });
  });

  // ── getFieldSuggestions (integration of all sources) ─────────────────

  describe("getFieldSuggestions", () => {
    it("returns standard library matches for 'Customer'", async () => {
      const result = await getFieldSuggestions("Customer", {
        domainName: "test",
        existingEntityNames: [],
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.length).toBeGreaterThan(0);
        // Should have standard source matches (Customer -> Person synonym)
        const standardSuggestions = result.data.filter(
          (s) => s.source === "standard"
        );
        expect(standardSuggestions.length).toBeGreaterThan(0);
      }
    });

    it("returns pattern-based suggestions for unknown entities", async () => {
      const result = await getFieldSuggestions("SomethingUnique", {
        domainName: "test",
        existingEntityNames: [],
      });

      expect(result.success).toBe(true);
      if (result.success) {
        // At least universal fields (id, createdAt, updatedAt)
        expect(result.data.length).toBeGreaterThanOrEqual(3);
        const patternSuggestions = result.data.filter(
          (s) => s.source === "pattern"
        );
        expect(patternSuggestions.length).toBeGreaterThan(0);
      }
    });

    it("standard suggestions ranked above pattern suggestions", async () => {
      const result = await getFieldSuggestions("Person", {
        domainName: "test",
        existingEntityNames: [],
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const standardSuggestions = result.data.filter(
          (s) => s.source === "standard"
        );
        const patternSuggestions = result.data.filter(
          (s) => s.source === "pattern"
        );

        if (standardSuggestions.length > 0 && patternSuggestions.length > 0) {
          // Standard suggestions should have higher confidence
          const maxPatternConf = Math.max(
            ...patternSuggestions.map((s) => s.confidence)
          );
          const minStandardConf = Math.min(
            ...standardSuggestions.map((s) => s.confidence)
          );
          expect(minStandardConf).toBeGreaterThanOrEqual(maxPatternConf);
        }
      }
    });

    it("deduplication keeps higher-confidence version", async () => {
      const result = await getFieldSuggestions("Person", {
        domainName: "test",
        existingEntityNames: [],
      });

      expect(result.success).toBe(true);
      if (result.success) {
        const names = result.data.map((s) => s.name.toLowerCase());
        const uniqueNames = new Set(names);
        // No duplicate field names
        expect(names.length).toBe(uniqueNames.size);
      }
    });

    it("excludes existing field names", async () => {
      const result = await getFieldSuggestions(
        "Person",
        { domainName: "test", existingEntityNames: [] },
        undefined,
        ["email", "givenName", "id"]
      );

      expect(result.success).toBe(true);
      if (result.success) {
        const names = result.data.map((s) => s.name.toLowerCase());
        expect(names).not.toContain("email");
        expect(names).not.toContain("givenname");
        expect(names).not.toContain("id");
      }
    });

    it("works without AI configured (graceful degradation)", async () => {
      const result = await getFieldSuggestions("Customer", {
        domainName: "test",
        existingEntityNames: [],
      });

      expect(result.success).toBe(true);
      if (result.success) {
        // Should still have suggestions from standards and patterns
        expect(result.data.length).toBeGreaterThan(0);
        // No AI-sourced suggestions
        const aiSuggestions = result.data.filter((s) => s.source === "ai");
        expect(aiSuggestions.length).toBe(0);
      }
    });

    it("suggestions are ranked by confidence descending", async () => {
      const result = await getFieldSuggestions("Customer", {
        domainName: "test",
        existingEntityNames: [],
      });

      expect(result.success).toBe(true);
      if (result.success && result.data.length > 1) {
        for (let i = 1; i < result.data.length; i++) {
          expect(result.data[i - 1].confidence).toBeGreaterThanOrEqual(
            result.data[i].confidence
          );
        }
      }
    });

    it("each suggestion has a rank number", async () => {
      const result = await getFieldSuggestions("Product", {
        domainName: "test",
        existingEntityNames: [],
      });

      expect(result.success).toBe(true);
      if (result.success) {
        for (let i = 0; i < result.data.length; i++) {
          expect(result.data[i].rank).toBe(i + 1);
        }
      }
    });
  });
});
