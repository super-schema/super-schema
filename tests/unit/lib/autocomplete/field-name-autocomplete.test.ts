import { describe, it, expect } from "vitest";
import { getFieldNameSuggestions } from "@/lib/autocomplete/field-name-autocomplete";

describe("getFieldNameSuggestions", () => {
  it("returns suggestions matching query from standard source", () => {
    const results = getFieldNameSuggestions("email");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].value).toBe("email");
    expect(results[0].source).toBe("standard");
  });

  it("returns max 8 results", () => {
    const results = getFieldNameSuggestions("id");
    expect(results.length).toBeLessThanOrEqual(8);
  });

  it("excludes existing field names", () => {
    const results = getFieldNameSuggestions("email", {
      existingFieldNames: ["email"],
    });
    expect(results.find((r) => r.value === "email")).toBeUndefined();
  });

  it("returns empty for empty query", () => {
    expect(getFieldNameSuggestions("")).toEqual([]);
  });

  it("matches partial names", () => {
    const results = getFieldNameSuggestions("creat");
    expect(results.some((r) => r.value.includes("created"))).toBe(true);
  });

  it("returns domain field suggestions with source label", () => {
    const results = getFieldNameSuggestions("cust", {
      domainFields: [
        { name: "customer_name", type: "string", entityName: "Order" },
      ],
    });
    expect(results.some((r) => r.value === "customer_name" && r.source === "domain")).toBe(true);
    const domainResult = results.find((r) => r.source === "domain");
    expect(domainResult?.sourceLabel).toContain("Order");
  });

  it("ranks prefix matches above contains matches", () => {
    const results = getFieldNameSuggestions("name");
    // "name" should be first (prefix match) before "first_name" (contains)
    const nameIdx = results.findIndex((r) => r.value === "name");
    const firstNameIdx = results.findIndex((r) => r.value === "first_name");
    if (nameIdx >= 0 && firstNameIdx >= 0) {
      expect(nameIdx).toBeLessThan(firstNameIdx);
    }
  });

  it("includes suggestedType from standard fields", () => {
    const results = getFieldNameSuggestions("amount");
    const amount = results.find((r) => r.value === "amount");
    expect(amount?.suggestedType).toBe("decimal");
  });
});
