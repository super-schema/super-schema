import { describe, expect, it } from "vitest";
import { getFieldNameSuggestions } from "@/lib/autocomplete/field-name-autocomplete";
import type { DictionaryEntry } from "@/types/schemas/field-dictionary";

const entry = (over: Partial<DictionaryEntry> = {}): DictionaryEntry => ({
  id: "e1",
  tenantId: "t1",
  name: "customer_id",
  aliases: ["customerId"],
  type: "string",
  description: "The customer",
  classification: "PII",
  attributes: { "x-securityClassification": { data_category: "ConsumerPersonal" } },
  conceptId: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...over,
});

describe("getFieldNameSuggestions with a dictionary", () => {
  it("ranks a dictionary entry first and carries its properties", () => {
    const [first] = getFieldNameSuggestions("cust", { dictionary: [entry()] });
    expect(first.source).toBe("dictionary");
    expect(first.value).toBe("customer_id");
    expect(first.entryId).toBe("e1");
    expect(first.suggestedType).toBe("string");
    expect(first.suggestedClassification).toBe("PII");
    expect(first.description).toBe("The customer");
    expect(first.attributes).toEqual({ "x-securityClassification": { data_category: "ConsumerPersonal" } });
  });

  it("matches aliases case-insensitively and suggests the canonical name", () => {
    const results = getFieldNameSuggestions("customerid", { dictionary: [entry()] });
    expect(results[0]).toMatchObject({ source: "dictionary", value: "customer_id" });
  });

  it("ranks dictionary above a better-matching standard suggestion", () => {
    const results = getFieldNameSuggestions("email", { dictionary: [entry({ id: "e2", name: "work_email", aliases: [] })] });
    expect(results[0].source).toBe("dictionary");
    expect(results.some((r) => r.source === "standard" && r.value === "email")).toBe(true);
  });

  it("excludes an existing field name", () => {
    const results = getFieldNameSuggestions("cust", { dictionary: [entry()], existingFieldNames: ["customer_id"] });
    expect(results.find((r) => r.source === "dictionary")).toBeUndefined();
  });

  it("keeps the case of the entry name", () => {
    const [first] = getFieldNameSuggestions("cust", { dictionary: [entry({ name: "CustomerId", aliases: [] })] });
    expect(first.value).toBe("CustomerId");
  });

  it("is unchanged without a dictionary", () => {
    expect(getFieldNameSuggestions("email")).toEqual(getFieldNameSuggestions("email", { dictionary: [] }));
  });
});
