/**
 * Unit tests for AI Service — Stories 11.1 and 11.3
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildEntityPrompt,
  buildFieldSuggestionsPrompt,
  parseEntitySuggestion,
  parseFieldSuggestions,
  extractJsonFromResponse,
  normalizeType,
  clampConfidence,
  isAiConfigured,
  createAiClient,
  generateEntityFromDescription,
  OllamaClient,
  VllmClient,
  SUPPORTED_TYPES,
  CLASSIFICATION_OPTIONS,
} from "@/services/ai.service";

describe("AI Service", () => {
  // ── isAiConfigured ───────────────────────────────────────────────────

  describe("isAiConfigured", () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it("returns false when env vars are not set", () => {
      delete process.env.AI_PROVIDER;
      delete process.env.AI_BASE_URL;
      expect(isAiConfigured()).toBe(false);
    });

    it("returns false when only AI_PROVIDER is set", () => {
      process.env.AI_PROVIDER = "ollama";
      delete process.env.AI_BASE_URL;
      expect(isAiConfigured()).toBe(false);
    });

    it("returns false when only AI_BASE_URL is set", () => {
      delete process.env.AI_PROVIDER;
      process.env.AI_BASE_URL = "http://localhost:11434";
      expect(isAiConfigured()).toBe(false);
    });

    it("returns true when both AI_PROVIDER and AI_BASE_URL are set", () => {
      process.env.AI_PROVIDER = "ollama";
      process.env.AI_BASE_URL = "http://localhost:11434";
      expect(isAiConfigured()).toBe(true);
    });
  });

  // ── createAiClient ───────────────────────────────────────────────────

  describe("createAiClient", () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it("returns null when env vars are not set", () => {
      delete process.env.AI_PROVIDER;
      delete process.env.AI_BASE_URL;
      expect(createAiClient()).toBeNull();
    });

    it("returns OllamaClient for provider 'ollama'", () => {
      process.env.AI_PROVIDER = "ollama";
      process.env.AI_BASE_URL = "http://localhost:11434";
      const client = createAiClient();
      expect(client).toBeInstanceOf(OllamaClient);
    });

    it("returns VllmClient for provider 'vllm'", () => {
      process.env.AI_PROVIDER = "vllm";
      process.env.AI_BASE_URL = "http://localhost:8000";
      const client = createAiClient();
      expect(client).toBeInstanceOf(VllmClient);
    });

    it("returns null for unknown provider", () => {
      process.env.AI_PROVIDER = "unknown-provider";
      process.env.AI_BASE_URL = "http://localhost:1234";
      expect(createAiClient()).toBeNull();
    });
  });

  // ── buildEntityPrompt ────────────────────────────────────────────────

  describe("buildEntityPrompt", () => {
    it("includes the user description", () => {
      const prompt = buildEntityPrompt("A customer entity with PII fields", {
        domainName: "fintech",
        existingEntityNames: [],
      });
      expect(prompt).toContain("A customer entity with PII fields");
    });

    it("includes domain context", () => {
      const prompt = buildEntityPrompt("An order entity", {
        domainName: "e-commerce",
        existingEntityNames: ["Product", "Customer"],
      });
      expect(prompt).toContain("e-commerce");
      expect(prompt).toContain("Product");
      expect(prompt).toContain("Customer");
    });

    it("includes the type system reference", () => {
      const prompt = buildEntityPrompt("test", {
        domainName: "test",
        existingEntityNames: [],
      });
      for (const type of SUPPORTED_TYPES) {
        expect(prompt).toContain(type);
      }
    });

    it("includes classification options", () => {
      const prompt = buildEntityPrompt("test", {
        domainName: "test",
        existingEntityNames: [],
      });
      for (const cls of CLASSIFICATION_OPTIONS) {
        expect(prompt).toContain(cls);
      }
    });

    it("handles empty existing entities", () => {
      const prompt = buildEntityPrompt("test", {
        domainName: "test",
        existingEntityNames: [],
      });
      expect(prompt).toContain("none");
    });
  });

  // ── buildFieldSuggestionsPrompt (Story 11.3) ────────────────────────

  describe("buildFieldSuggestionsPrompt", () => {
    it("includes entity name and domain context", () => {
      const prompt = buildFieldSuggestionsPrompt("Customer", {
        domainName: "fintech",
        existingEntityNames: ["Account"],
      });
      expect(prompt).toContain("Customer");
      expect(prompt).toContain("fintech");
      expect(prompt).toContain("Account");
    });

    it("includes description when provided", () => {
      const prompt = buildFieldSuggestionsPrompt(
        "Customer",
        { domainName: "test", existingEntityNames: [] },
        "A fintech customer"
      );
      expect(prompt).toContain("A fintech customer");
    });

    it("works without description", () => {
      const prompt = buildFieldSuggestionsPrompt("Order", {
        domainName: "test",
        existingEntityNames: [],
      });
      expect(prompt).toContain("Order");
      expect(prompt).not.toContain("described as");
    });
  });

  // ── extractJsonFromResponse ──────────────────────────────────────────

  describe("extractJsonFromResponse", () => {
    it("extracts JSON from raw response", () => {
      const raw = '{"entityName": "Customer"}';
      expect(extractJsonFromResponse(raw)).toBe('{"entityName": "Customer"}');
    });

    it("extracts JSON from markdown code blocks", () => {
      const raw = 'Here is the result:\n```json\n{"entityName": "Customer"}\n```\nDone.';
      expect(extractJsonFromResponse(raw)).toBe('{"entityName": "Customer"}');
    });

    it("extracts JSON from code block without language tag", () => {
      const raw = '```\n{"test": true}\n```';
      expect(extractJsonFromResponse(raw)).toBe('{"test": true}');
    });

    it("extracts JSON object from mixed text", () => {
      const raw = 'Sure! Here is the entity:\n{"entityName": "Test"}\nHope that helps!';
      const result = extractJsonFromResponse(raw);
      expect(result).toContain('"entityName"');
    });

    it("extracts JSON array from mixed text", () => {
      const raw = 'Fields:\n[{"name": "id"}]\nEnd.';
      const result = extractJsonFromResponse(raw);
      expect(result).toContain('"name"');
    });
  });

  // ── normalizeType ────────────────────────────────────────────────────

  describe("normalizeType", () => {
    it("returns supported types as-is", () => {
      expect(normalizeType("string")).toBe("string");
      expect(normalizeType("integer")).toBe("integer");
      expect(normalizeType("decimal")).toBe("decimal");
      expect(normalizeType("boolean")).toBe("boolean");
      expect(normalizeType("timestamp")).toBe("timestamp");
    });

    it("normalizes common aliases", () => {
      expect(normalizeType("int")).toBe("integer");
      expect(normalizeType("float")).toBe("decimal");
      expect(normalizeType("bool")).toBe("boolean");
      expect(normalizeType("datetime")).toBe("timestamp");
      expect(normalizeType("text")).toBe("string");
      expect(normalizeType("varchar")).toBe("string");
    });

    it("falls back to 'string' for unknown types", () => {
      expect(normalizeType("unknown_type")).toBe("string");
      expect(normalizeType("xyz")).toBe("string");
    });

    it("is case-insensitive", () => {
      expect(normalizeType("STRING")).toBe("string");
      expect(normalizeType("Integer")).toBe("integer");
      expect(normalizeType("BOOLEAN")).toBe("boolean");
    });
  });

  // ── clampConfidence ──────────────────────────────────────────────────

  describe("clampConfidence", () => {
    it("returns the value if within range", () => {
      expect(clampConfidence(0.5)).toBe(0.5);
      expect(clampConfidence(0.0)).toBe(0.0);
      expect(clampConfidence(1.0)).toBe(1.0);
    });

    it("clamps values above 1.0 to 1.0", () => {
      expect(clampConfidence(1.5)).toBe(1.0);
      expect(clampConfidence(100)).toBe(1.0);
    });

    it("clamps values below 0.0 to 0.0", () => {
      expect(clampConfidence(-0.5)).toBe(0.0);
      expect(clampConfidence(-1)).toBe(0.0);
    });

    it("returns 0.5 for non-numeric values", () => {
      expect(clampConfidence("high")).toBe(0.5);
      expect(clampConfidence(undefined)).toBe(0.5);
      expect(clampConfidence(null)).toBe(0.5);
      expect(clampConfidence(NaN)).toBe(0.5);
    });
  });

  // ── parseEntitySuggestion ────────────────────────────────────────────

  describe("parseEntitySuggestion", () => {
    it("parses well-formed JSON response", () => {
      const json = JSON.stringify({
        entityName: "Customer",
        description: "A customer record",
        fields: [
          {
            name: "email",
            type: "string",
            classification: "PII",
            description: "Email address",
            confidence: 0.9,
          },
          {
            name: "age",
            type: "integer",
            confidence: 0.8,
          },
        ],
      });

      const result = parseEntitySuggestion(json);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.entityName).toBe("Customer");
        expect(result.data.fields).toHaveLength(2);
        expect(result.data.fields[0].name).toBe("email");
        expect(result.data.fields[0].classification).toBe("PII");
      }
    });

    it("handles response wrapped in markdown code blocks", () => {
      const raw = `\`\`\`json
{
  "entityName": "Order",
  "fields": [
    { "name": "amount", "type": "decimal", "confidence": 0.95 }
  ]
}
\`\`\``;

      const result = parseEntitySuggestion(raw);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.entityName).toBe("Order");
      }
    });

    it("normalizes unknown types to string fallback", () => {
      const json = JSON.stringify({
        entityName: "Test",
        fields: [
          { name: "field1", type: "varchar(255)", confidence: 0.8 },
          { name: "field2", type: "bigint", confidence: 0.7 },
        ],
      });

      const result = parseEntitySuggestion(json);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.fields[0].type).toBe("string");
        expect(result.data.fields[1].type).toBe("integer");
      }
    });

    it("clamps confidence scores to 0.0-1.0", () => {
      const json = JSON.stringify({
        entityName: "Test",
        fields: [
          { name: "f1", type: "string", confidence: 1.5 },
          { name: "f2", type: "string", confidence: -0.3 },
          { name: "f3", type: "string", confidence: 0.7 },
        ],
      });

      const result = parseEntitySuggestion(json);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.fields[0].confidence).toBe(1.0);
        expect(result.data.fields[1].confidence).toBe(0.0);
        expect(result.data.fields[2].confidence).toBe(0.7);
      }
    });

    it("returns error for malformed JSON", () => {
      const result = parseEntitySuggestion("this is not json at all");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("PARSE_ERROR");
      }
    });

    it("returns error for JSON missing required fields", () => {
      const json = JSON.stringify({ fields: [] }); // missing entityName
      const result = parseEntitySuggestion(json);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("PARSE_ERROR");
      }
    });
  });

  // ── parseFieldSuggestions (Story 11.3) ───────────────────────────────

  describe("parseFieldSuggestions", () => {
    it("parses a JSON array of field suggestions", () => {
      const json = JSON.stringify([
        { name: "email", type: "string", confidence: 0.9 },
        { name: "age", type: "integer", confidence: 0.8 },
      ]);

      const result = parseFieldSuggestions(json);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(2);
        expect(result.data[0].name).toBe("email");
      }
    });

    it("handles response with fields property", () => {
      const json = JSON.stringify({
        fields: [{ name: "id", type: "string", confidence: 1.0 }],
      });

      const result = parseFieldSuggestions(json);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(1);
      }
    });

    it("normalizes types and clamps confidence", () => {
      const json = JSON.stringify([
        { name: "f1", type: "varchar", confidence: 2.0 },
      ]);

      const result = parseFieldSuggestions(json);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data[0].type).toBe("string");
        expect(result.data[0].confidence).toBe(1.0);
      }
    });

    it("returns error for malformed JSON", () => {
      const result = parseFieldSuggestions("not json");
      expect(result.success).toBe(false);
    });
  });

  // ── generateEntityFromDescription ────────────────────────────────────

  describe("generateEntityFromDescription", () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it("returns error when AI is not configured", async () => {
      delete process.env.AI_PROVIDER;
      delete process.env.AI_BASE_URL;

      const result = await generateEntityFromDescription(
        "A customer entity",
        { domainName: "test", existingEntityNames: [] }
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("AI_NOT_CONFIGURED");
      }
    });
  });
});
