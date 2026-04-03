import { describe, it, expect } from "vitest";
import { DecoratorSchema } from "@/types/schemas/decorator.schema";

describe("DecoratorSchema", () => {
  it("accepts an empty object (all categories optional)", () => {
    const result = DecoratorSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts a valid partial decorator with one category", () => {
    const result = DecoratorSchema.safeParse({
      structure: { nullable: true },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a fully populated decorator", () => {
    const result = DecoratorSchema.safeParse({
      structure: { nullable: true, key: false },
      semantics: {
        description: "Customer email",
        aliases: ["email_address"],
        glossaryTerms: ["email"],
      },
      classification: { level: "PII", customLevel: null },
      policy: {
        retention: "7 years",
        anonymization: "hash",
        encryption: "AES-256",
      },
      quality: {
        rules: [{ type: "format", params: { pattern: "^.+@.+$" } }],
      },
      lineage: {
        source: "crm-system",
        upstream: ["raw_customers"],
        downstream: ["customer_dim"],
      },
      operationalHints: { partition: false, index: true, cluster: false },
      evolution: { deprecated: false, since: "v1", replacement: null },
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid classification level", () => {
    const result = DecoratorSchema.safeParse({
      classification: { level: "INVALID" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects wrong type for structure.nullable", () => {
    const result = DecoratorSchema.safeParse({
      structure: { nullable: "yes" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects wrong type for quality.rules (non-array)", () => {
    const result = DecoratorSchema.safeParse({
      quality: { rules: "not-an-array" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects quality rule missing required params field", () => {
    const result = DecoratorSchema.safeParse({
      quality: { rules: [{ type: "format" }] },
    });
    expect(result.success).toBe(false);
  });

  it("accepts partial categories with some fields", () => {
    const result = DecoratorSchema.safeParse({
      semantics: { description: "A field" },
      lineage: { source: "system-a" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.semantics?.description).toBe("A field");
      expect(result.data.semantics?.aliases).toBeUndefined();
    }
  });
});
