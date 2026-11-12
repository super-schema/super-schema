import { describe, it, expect } from "vitest";
import {
  activeValidationKeys,
  applicableValidationKeys,
  legacyEnumSymbols,
  staleValidationKeys,
  validationNotApplicableReason,
} from "@/lib/field-attributes";
import { constraintAppliesTo } from "@/lib/compiler/constraint-targets";

describe("validation applicability follows the TypeSpec target rules", () => {
  it("gives enum, boolean and structured types no validator", () => {
    for (const type of ["enum", "boolean", "object", "map", "reference", "bytes", "utcDateTime"])
      expect(applicableValidationKeys(type)).toEqual([]);
  });

  it("gives numeric types the bounds and string types length and pattern", () => {
    expect(applicableValidationKeys("int32")).toEqual([
      "minValue",
      "maxValue",
      "minValueExclusive",
      "maxValueExclusive",
    ]);
    expect(applicableValidationKeys("string")).toEqual(["minLength", "maxLength", "pattern"]);
    expect(applicableValidationKeys("url")).toEqual(["minLength", "maxLength", "pattern"]);
  });

  it("gives arrays only the item-count bounds, never element-level validators", () => {
    expect(applicableValidationKeys("array")).toEqual(["minItems", "maxItems"]);
    expect(constraintAppliesTo("array", "minLength")).toBe(false);
    expect(constraintAppliesTo("array", "minValue")).toBe(false);
  });

  it("counts only applicable stored validators as active", () => {
    const validation = { pattern: "A|B|C", minLength: 2 };
    expect(activeValidationKeys(validation, "enum")).toEqual([]);
    expect(activeValidationKeys(validation, "string")).toEqual(["minLength", "pattern"]);
  });

  it("reports stored validators that do not apply, so they can be cleared", () => {
    expect(staleValidationKeys({ pattern: "A|B|C" }, "enum")).toEqual(["pattern"]);
    expect(staleValidationKeys({ minValue: 1, pattern: "x" }, "int32")).toEqual(["pattern"]);
    expect(staleValidationKeys({ minValue: 1 }, "int32")).toEqual([]);
  });

  it("explains why an enum has no validators", () => {
    expect(validationNotApplicableReason("enum")).toMatch(/enum values under Properties/);
    expect(validationNotApplicableReason("boolean")).toMatch(/Boolean/);
  });
});

describe("legacy enum symbols stored in pattern", () => {
  it("reads a symbol list and ignores regular expressions", () => {
    expect(legacyEnumSymbols("A|B|C")).toEqual(["A", "B", "C"]);
    expect(legacyEnumSymbols("^[A-Z]+$")).toEqual([]);
    expect(legacyEnumSymbols("")).toEqual([]);
    expect(legacyEnumSymbols(undefined)).toEqual([]);
  });
});
