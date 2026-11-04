import { describe, expect, it } from "vitest";
import { applyScalarToField, scalarRowFromParsed } from "@/lib/importers/scalar-asset";
import { normalizeAssetName, sameAssetName } from "@/lib/importers/asset-name-match";

describe("scalarRowFromParsed", () => {
  it("splits pattern and the numeric bounds", () => {
    const row = scalarRowFromParsed({
      name: "CountryCode", baseType: "string", logicalType: "string",
      constraints: [{ type: "pattern", value: "^[A-Z]{2}$" }, { type: "minLength", value: 2 }, { type: "maxLength", value: 2 }],
    });
    expect(row).toMatchObject({ pattern: "^[A-Z]{2}$", constraints: { minLength: 2, maxLength: 2 }, logicalType: "string" });
  });
  it("keeps exclusive bounds and stores null when there is no constraint", () => {
    expect(scalarRowFromParsed({ name: "X", baseType: "int32", minValueExclusive: 0 }).constraints).toEqual({ minValueExclusive: 0 });
    expect(scalarRowFromParsed({ name: "X", baseType: "string" }).constraints).toBeNull();
  });
});

describe("applyScalarToField", () => {
  const scalar = { baseType: "string", logicalType: "string", format: "email", pattern: "^a", constraints: { maxLength: 9 } };
  it("copies type, format and validation and records the scalar", () => {
    const r = applyScalarToField({ type: "reference", decorators: { semantics: { description: "d" } } }, "Email", scalar, false);
    expect(r.type).toBe("string");
    expect(r.decorators).toMatchObject({ scalarName: "Email", semantics: { description: "d" }, typespec: { identity: { format: "email" }, validation: { pattern: "^a", maxLength: 9 } } });
  });
  it("re-applying an edited scalar replaces the old bounds and keeps other validators", () => {
    const first = applyScalarToField({ type: "string", decorators: {} }, "Email", scalar, false);
    const withOwn = { type: first.type, decorators: { ...first.decorators, typespec: { ...(first.decorators.typespec as object), validation: { ...(first.decorators.typespec as { validation: object }).validation, minItems: 1 } } } };
    const next = applyScalarToField(withOwn, "Email", { baseType: "string", constraints: { minLength: 3 } }, false);
    const validation = (next.decorators.typespec as { validation: Record<string, unknown> }).validation;
    expect(validation).toEqual({ minLength: 3, minItems: 1 });
    expect((next.decorators.typespec as { identity?: unknown }).identity).toBeUndefined();
  });
  it("an array of scalars takes the element type only", () => {
    const r = applyScalarToField({ type: "array", decorators: {} }, "Email", scalar, true);
    expect(r.type).toBe("array");
    expect(r.decorators).toMatchObject({ scalarName: "Email", arrayElementType: "string" });
    expect(r.decorators.typespec).toBeUndefined();
  });
});

describe("asset name matching", () => {
  it("matches file spellings to asset names", () => {
    expect(sameAssetName("country_code", "CountryCode")).toBe(true);
    expect(sameAssetName("country-code.json", "CountryCode")).toBe(true);
    expect(sameAssetName("Orthography.v1", "orthography")).toBe(true);
    expect(sameAssetName("date_time", "DateTimeZone")).toBe(false);
    expect(normalizeAssetName("../x/Address_Portable.json")).toBe("xaddressportable");
  });
});
