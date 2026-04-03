import { describe, it, expect } from "vitest";
import { getFieldNameSuggestions } from "@/lib/autocomplete/field-name-autocomplete";

describe("getFieldNameSuggestions", () => {
  it("returns suggestions matching query", () => {
    const results = getFieldNameSuggestions("email");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].value).toBe("email");
  });

  it("returns max 8 results", () => {
    const results = getFieldNameSuggestions("id");
    expect(results.length).toBeLessThanOrEqual(8);
  });

  it("excludes existing field names", () => {
    const results = getFieldNameSuggestions("email", ["email"]);
    expect(results.find((r) => r.value === "email")).toBeUndefined();
  });

  it("returns empty for short queries", () => {
    expect(getFieldNameSuggestions("e")).toEqual([]);
    expect(getFieldNameSuggestions("")).toEqual([]);
  });

  it("matches partial names", () => {
    const results = getFieldNameSuggestions("creat");
    expect(results.some((r) => r.value.includes("created"))).toBe(true);
  });
});
