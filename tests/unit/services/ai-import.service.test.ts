/**
 * Unit tests for AI Import Enhancement Service — Story 11.4
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  buildImportPrompt,
  mergeAiWithDeterministic,
  calculateOverallQualityScore,
  applyRuleBasedEnhancement,
  enhanceImportWithAi,
} from "@/services/ai-import.service";
import type { ParsedField } from "@/types/schemas/ai-import";

describe("AI Import Enhancement Service", () => {
  // ── buildImportPrompt ────────────────────────────────────────────────

  describe("buildImportPrompt", () => {
    it("includes source content", () => {
      const prompt = buildImportPrompt(
        "CREATE TABLE users (id INT, name VARCHAR)",
        [{ name: "id", type: "int" }, { name: "name", type: "varchar" }],
        { domainName: "test", existingEntityNames: [] }
      );
      expect(prompt).toContain("CREATE TABLE users");
    });

    it("includes parsed fields", () => {
      const prompt = buildImportPrompt(
        "source",
        [{ name: "amount", type: "STRING" }],
        { domainName: "test", existingEntityNames: [] }
      );
      expect(prompt).toContain("amount");
      expect(prompt).toContain("STRING");
    });

    it("includes type system reference", () => {
      const prompt = buildImportPrompt(
        "source",
        [],
        { domainName: "test", existingEntityNames: [] }
      );
      expect(prompt).toContain("string");
      expect(prompt).toContain("integer");
      expect(prompt).toContain("decimal");
      expect(prompt).toContain("timestamp");
    });

    it("includes domain context", () => {
      const prompt = buildImportPrompt(
        "source",
        [],
        {
          domainName: "e-commerce",
          existingEntityNames: ["Product", "Customer"],
        }
      );
      expect(prompt).toContain("e-commerce");
      expect(prompt).toContain("Product");
      expect(prompt).toContain("Customer");
    });

    it("includes classification taxonomy", () => {
      const prompt = buildImportPrompt(
        "source",
        [],
        { domainName: "test", existingEntityNames: [] }
      );
      expect(prompt).toContain("PII");
      expect(prompt).toContain("SENSITIVE");
      expect(prompt).toContain("INTERNAL");
      expect(prompt).toContain("PUBLIC");
    });
  });

  // ── mergeAiWithDeterministic ─────────────────────────────────────────

  describe("mergeAiWithDeterministic", () => {
    it("AI agrees with parser: confidence increases", () => {
      const parsedFields: ParsedField[] = [
        { name: "email", type: "string", confidence: 0.6 },
      ];
      const aiSuggestions = [
        { name: "email", suggestedType: "string", confidence: 0.9 },
      ];

      const result = mergeAiWithDeterministic(parsedFields, aiSuggestions);
      expect(result).toHaveLength(1);
      expect(result[0].finalType).toBe("string");
      expect(result[0].confidence).toBe(0.9); // max of 0.6 and 0.9
      expect(result[0].source).toBe("deterministic");
    });

    it("AI disagrees with parser: AI type used, source marked ai-enhanced", () => {
      const parsedFields: ParsedField[] = [
        { name: "amount", type: "string", confidence: 0.6 },
      ];
      const aiSuggestions = [
        {
          name: "amount",
          suggestedType: "decimal",
          confidence: 0.85,
          reasoning: "Field named 'amount' is typically a monetary value",
        },
      ];

      const result = mergeAiWithDeterministic(parsedFields, aiSuggestions);
      expect(result).toHaveLength(1);
      expect(result[0].deterministicType).toBe("string");
      expect(result[0].aiSuggestedType).toBe("decimal");
      expect(result[0].finalType).toBe("decimal");
      expect(result[0].source).toBe("ai-enhanced");
      expect(result[0].confidence).toBe(0.85);
    });

    it("no AI suggestion for field: deterministic mapping preserved", () => {
      const parsedFields: ParsedField[] = [
        { name: "someField", type: "string", confidence: 0.6 },
      ];
      const aiSuggestions: { name: string; suggestedType: string; confidence: number }[] = [];

      const result = mergeAiWithDeterministic(parsedFields, aiSuggestions);
      expect(result).toHaveLength(1);
      expect(result[0].finalType).toBe("string");
      expect(result[0].source).toBe("deterministic");
      expect(result[0].confidence).toBe(0.6);
    });

    it("includes AI classification suggestion", () => {
      const parsedFields: ParsedField[] = [
        { name: "email", type: "string", confidence: 0.6 },
      ];
      const aiSuggestions = [
        {
          name: "email",
          suggestedType: "string",
          confidence: 0.9,
          classification: "PII",
        },
      ];

      const result = mergeAiWithDeterministic(parsedFields, aiSuggestions);
      expect(result[0].classification).toBe("PII");
    });

    it("includes AI reasoning", () => {
      const parsedFields: ParsedField[] = [
        { name: "created_at", type: "string", confidence: 0.5 },
      ];
      const aiSuggestions = [
        {
          name: "created_at",
          suggestedType: "timestamp",
          confidence: 0.95,
          reasoning: "Datetime field pattern",
        },
      ];

      const result = mergeAiWithDeterministic(parsedFields, aiSuggestions);
      expect(result[0].aiReasoning).toBe("Datetime field pattern");
    });

    it("AI suggests decimal for STRING field named 'amount'", () => {
      const parsedFields: ParsedField[] = [
        { name: "amount", type: "string", confidence: 0.5 },
      ];
      const aiSuggestions = [
        {
          name: "amount",
          suggestedType: "decimal",
          confidence: 0.9,
        },
      ];

      const result = mergeAiWithDeterministic(parsedFields, aiSuggestions);
      expect(result[0].finalType).toBe("decimal");
      expect(result[0].source).toBe("ai-enhanced");
    });

    it("AI suggests PII classification for field named 'email'", () => {
      const parsedFields: ParsedField[] = [
        { name: "email", type: "string", confidence: 0.7 },
      ];
      const aiSuggestions = [
        {
          name: "email",
          suggestedType: "string",
          confidence: 0.95,
          classification: "PII",
        },
      ];

      const result = mergeAiWithDeterministic(parsedFields, aiSuggestions);
      expect(result[0].classification).toBe("PII");
    });
  });

  // ── calculateOverallQualityScore ─────────────────────────────────────

  describe("calculateOverallQualityScore", () => {
    it("returns 0 for empty fields", () => {
      expect(calculateOverallQualityScore([])).toBe(0);
    });

    it("all high confidence fields produce high score", () => {
      const fields = [
        { name: "a", deterministicType: "string", finalType: "string", confidence: 0.95, source: "deterministic" as const },
        { name: "b", deterministicType: "integer", finalType: "integer", confidence: 0.9, source: "deterministic" as const },
        { name: "c", deterministicType: "decimal", finalType: "decimal", confidence: 0.88, source: "deterministic" as const },
      ];

      const score = calculateOverallQualityScore(fields);
      expect(score).toBeGreaterThan(0.85);
    });

    it("mixed confidence fields produce medium score", () => {
      const fields = [
        { name: "a", deterministicType: "string", finalType: "string", confidence: 0.95, source: "deterministic" as const },
        { name: "b", deterministicType: "string", finalType: "integer", confidence: 0.6, source: "ai-enhanced" as const },
        { name: "c", deterministicType: "string", finalType: "string", confidence: 0.3, source: "deterministic" as const },
      ];

      const score = calculateOverallQualityScore(fields);
      expect(score).toBeGreaterThan(0.4);
      expect(score).toBeLessThan(0.9);
    });

    it("all low confidence fields produce low score", () => {
      const fields = [
        { name: "a", deterministicType: "string", finalType: "string", confidence: 0.2, source: "deterministic" as const },
        { name: "b", deterministicType: "string", finalType: "string", confidence: 0.3, source: "deterministic" as const },
      ];

      const score = calculateOverallQualityScore(fields);
      expect(score).toBeLessThan(0.5);
    });

    it("score is between 0 and 1", () => {
      const fields = [
        { name: "a", deterministicType: "string", finalType: "string", confidence: 0.5, source: "deterministic" as const },
      ];

      const score = calculateOverallQualityScore(fields);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    });
  });

  // ── applyRuleBasedEnhancement ────────────────────────────────────────

  describe("applyRuleBasedEnhancement", () => {
    it("suggests decimal for field named 'amount' with string type", () => {
      const fields: ParsedField[] = [
        { name: "amount", type: "string" },
      ];

      const result = applyRuleBasedEnhancement(fields);
      expect(result[0].finalType).toBe("decimal");
      expect(result[0].source).toBe("ai-enhanced");
    });

    it("suggests timestamp for field named 'created_at' with string type", () => {
      const fields: ParsedField[] = [
        { name: "created_at", type: "string" },
      ];

      const result = applyRuleBasedEnhancement(fields);
      expect(result[0].finalType).toBe("timestamp");
      expect(result[0].source).toBe("ai-enhanced");
    });

    it("keeps type when no better hint exists", () => {
      const fields: ParsedField[] = [
        { name: "someCustomField", type: "string" },
      ];

      const result = applyRuleBasedEnhancement(fields);
      expect(result[0].finalType).toBe("string");
      expect(result[0].source).toBe("deterministic");
    });

    it("suggests PII classification for email field", () => {
      const fields: ParsedField[] = [
        { name: "email", type: "string" },
      ];

      const result = applyRuleBasedEnhancement(fields);
      expect(result[0].classification).toBe("PII");
    });

    it("suggests SENSITIVE classification for password field", () => {
      const fields: ParsedField[] = [
        { name: "password", type: "string" },
      ];

      const result = applyRuleBasedEnhancement(fields);
      expect(result[0].classification).toBe("SENSITIVE");
    });

    it("suggests boolean for is_active field", () => {
      const fields: ParsedField[] = [
        { name: "is_active", type: "string" },
      ];

      const result = applyRuleBasedEnhancement(fields);
      expect(result[0].finalType).toBe("boolean");
    });
  });

  // ── enhanceImportWithAi ──────────────────────────────────────────────

  describe("enhanceImportWithAi", () => {
    it("falls back to rule-based when AI not configured", async () => {
      const fields: ParsedField[] = [
        { name: "amount", type: "string" },
        { name: "email", type: "string" },
      ];

      const result = await enhanceImportWithAi(
        fields,
        "CREATE TABLE t (amount VARCHAR, email VARCHAR)",
        { domainName: "test", existingEntityNames: [] }
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.fields).toHaveLength(2);
        // Rule-based should improve 'amount' to 'decimal'
        const amountField = result.data.fields.find(
          (f) => f.name === "amount"
        );
        expect(amountField?.finalType).toBe("decimal");
        expect(result.data.overallQualityScore).toBeGreaterThan(0);
      }
    });

    it("skips AI when withAiEnhancement is false", async () => {
      const fields: ParsedField[] = [
        { name: "name", type: "string", confidence: 0.8 },
      ];

      const result = await enhanceImportWithAi(
        fields,
        "source",
        { domainName: "test", existingEntityNames: [] },
        { withAiEnhancement: false }
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.fields[0].source).toBe("deterministic");
      }
    });

    it("produces an overall quality score", async () => {
      const fields: ParsedField[] = [
        { name: "id", type: "string", confidence: 0.9 },
        { name: "name", type: "string", confidence: 0.8 },
      ];

      const result = await enhanceImportWithAi(
        fields,
        "source",
        { domainName: "test", existingEntityNames: [] }
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.overallQualityScore).toBeGreaterThanOrEqual(0);
        expect(result.data.overallQualityScore).toBeLessThanOrEqual(1);
      }
    });

    it("AI-enhanced import produces higher confidence for ambiguous types", async () => {
      // Rule-based enhancement recognizes 'amount' as decimal
      const fields: ParsedField[] = [
        { name: "amount", type: "string", confidence: 0.5 },
      ];

      const result = await enhanceImportWithAi(
        fields,
        "source",
        { domainName: "test", existingEntityNames: [] }
      );

      expect(result.success).toBe(true);
      if (result.success) {
        const amountField = result.data.fields[0];
        // Rule-based should suggest decimal with higher confidence than original
        expect(amountField.confidence).toBeGreaterThan(0.5);
        expect(amountField.finalType).toBe("decimal");
      }
    });
  });
});
