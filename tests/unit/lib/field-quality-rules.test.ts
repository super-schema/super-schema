import { describe, it, expect } from "vitest";
import {
  newQualityRule,
  qualityRuleErrors,
  qualityRuleSeverity,
  qualityRuleSummary,
  withQualityParam,
} from "@/lib/field-quality-rules";

describe("quality rule summaries", () => {
  it("states what each rule checks in one line", () => {
    expect(qualityRuleSummary({ type: "range", params: { min: 0, max: 100 } })).toBe("Between 0 and 100");
    expect(qualityRuleSummary({ type: "range", params: { min: 5 } })).toBe("At least 5");
    expect(qualityRuleSummary({ type: "regex", params: { pattern: "^[A-Z]+$" } })).toBe("Matches ^[A-Z]+$");
    expect(qualityRuleSummary({ type: "enum", params: { values: ["a", "b", "c"] } })).toBe("One of 3 values");
    expect(qualityRuleSummary({ type: "enum", params: { values: ["a"] } })).toBe("One of 1 value");
    expect(qualityRuleSummary({ type: "not-null", params: { threshold: 95 } })).toBe("At least 95% of rows non-null");
    expect(qualityRuleSummary({ type: "unique", params: {} })).toBe("Values must be unique");
  });

  it("truncates a long pattern in the summary", () => {
    const summary = qualityRuleSummary({ type: "regex", params: { pattern: "x".repeat(80) } });
    expect(summary.length).toBeLessThanOrEqual(50);
    expect(summary.startsWith("Matches ")).toBe(true);
  });
});

describe("quality rule validation", () => {
  it("requires a bound, orders min and max, and rejects non-numeric raw values", () => {
    expect(qualityRuleErrors({ type: "range", params: {} })).toEqual([
      { field: "min", message: "Enter a minimum, a maximum, or both." },
    ]);
    expect(qualityRuleErrors({ type: "range", params: { min: 10, max: 2 } })).toEqual([
      { field: "max", message: "Maximum must be at least the minimum." },
    ]);
    expect(qualityRuleErrors({ type: "range", params: { min: "5" } })).toEqual([
      { field: "min", message: "Minimum must be a number." },
    ]);
    expect(qualityRuleErrors({ type: "range", params: { min: 2, max: 2 } })).toEqual([]);
  });

  it("rejects an invalid regular expression and an empty pattern", () => {
    expect(qualityRuleErrors({ type: "regex", params: { pattern: "(" } })[0].field).toBe("pattern");
    expect(qualityRuleErrors({ type: "regex", params: {} })[0].message).toBe("Enter a pattern.");
    expect(qualityRuleErrors({ type: "regex", params: { pattern: "^a+$" } })).toEqual([]);
  });

  it("requires enum values, a 0–100 threshold and a custom expression", () => {
    expect(qualityRuleErrors({ type: "enum", params: { values: [] } })[0].field).toBe("values");
    expect(qualityRuleErrors({ type: "not-null", params: { threshold: 120 } })[0].field).toBe("threshold");
    expect(qualityRuleErrors({ type: "not-null", params: {} })).toEqual([]);
    expect(qualityRuleErrors({ type: "custom", params: { name: "x" } })[0].field).toBe("expression");
    expect(qualityRuleErrors({ type: "unique", params: {} })).toEqual([]);
  });
});

describe("quality rule parameters", () => {
  it("stores severity explicitly and defaults to error", () => {
    expect(newQualityRule("enum")).toEqual({ type: "enum", params: { severity: "error", values: [] } });
    expect(qualityRuleSeverity({})).toBe("error");
    expect(qualityRuleSeverity({ severity: "warning" })).toBe("warning");
    expect(qualityRuleSeverity({ severity: "bogus" })).toBe("error");
  });

  it("removes an emptied key and keeps every other key, including unknown ones", () => {
    const params = { min: 1, max: 9, owner: "data-team" };
    expect(withQualityParam(params, "min", undefined)).toEqual({ max: 9, owner: "data-team" });
    expect(withQualityParam(params, "max", "")).toEqual({ min: 1, owner: "data-team" });
    expect(withQualityParam(params, "min", 3)).toEqual({ min: 3, max: 9, owner: "data-team" });
    expect(params).toEqual({ min: 1, max: 9, owner: "data-team" });
  });
});
