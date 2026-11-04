import { describe, expect, it } from "vitest";
import { baseTypeOptions, boundApplies, enumUpdateFrom, savedMessage, scalarFormFrom, scalarUpdateFrom } from "@/app/(dashboard)/schemas/[domainSlug]/components/data-type-edit";

const COUNTRY = { description: "ISO alpha-2", baseType: "string", logicalType: "string", format: null, pattern: "^[A-Z]{2}$", constraints: { minLength: 2, maxLength: 2 } };

describe("scalar edit form", () => {
  it("shows the stored facts and sends them back unchanged", () => {
    const form = scalarFormFrom(COUNTRY);
    expect(form.bounds.maxLength).toBe("2");
    expect(form.bounds.minValue).toBe("");
    expect(scalarUpdateFrom(form, COUNTRY)).toEqual({
      ok: true,
      update: { description: "ISO alpha-2", baseType: "string", logicalType: "string", format: null, pattern: "^[A-Z]{2}$", constraints: { minLength: 2, maxLength: 2 } },
    });
  });

  it("clearing every bound sends null constraints", () => {
    const form = scalarFormFrom(COUNTRY);
    form.bounds.minLength = "";
    form.bounds.maxLength = " ";
    const r = scalarUpdateFrom(form, COUNTRY);
    expect(r.ok && r.update.constraints).toBeNull();
  });

  it("length bounds apply to a string, numeric bounds to a number", () => {
    const form = scalarFormFrom(COUNTRY);
    expect(boundApplies(form, COUNTRY, "maxLength")).toBe(true);
    expect(boundApplies(form, COUNTRY, "maxValue")).toBe(false);
    const n = { ...COUNTRY, baseType: "int32", logicalType: "int32", pattern: null, constraints: {} };
    expect(boundApplies(scalarFormFrom(n), n, "maxValue")).toBe(true);
    expect(boundApplies(scalarFormFrom(n), n, "pattern")).toBe(false);
  });

  it("changing the base type drops the bounds that no longer apply and resets the logical type", () => {
    const form = scalarFormFrom(COUNTRY);
    form.baseType = "int32";
    form.pattern = "";
    form.bounds.maxValue = "99";
    const r = scalarUpdateFrom(form, COUNTRY);
    expect(r).toEqual({ ok: true, update: expect.objectContaining({ baseType: "int32", logicalType: null, constraints: { maxValue: 99 } }) });
  });

  it("refuses a pattern on a type that takes none, a bad regex, a non-number, min > max", () => {
    const form = scalarFormFrom(COUNTRY);
    form.baseType = "int32";
    expect(scalarUpdateFrom(form, COUNTRY)).toEqual({ ok: false, error: "A pattern cannot be set on int32" });
    const bad = scalarFormFrom(COUNTRY);
    bad.pattern = "([";
    expect(scalarUpdateFrom(bad, COUNTRY)).toMatchObject({ ok: false, error: expect.stringMatching(/regular expression/) });
    const nan = scalarFormFrom(COUNTRY);
    nan.bounds.maxLength = "two";
    expect(scalarUpdateFrom(nan, COUNTRY)).toMatchObject({ ok: false, error: "Max length must be a number" });
    const frac = scalarFormFrom(COUNTRY);
    frac.bounds.maxLength = "2.5";
    expect(scalarUpdateFrom(frac, COUNTRY)).toMatchObject({ ok: false });
    const swapped = scalarFormFrom(COUNTRY);
    swapped.bounds.minLength = "5";
    expect(scalarUpdateFrom(swapped, COUNTRY)).toMatchObject({ ok: false, error: "Min length is greater than max length" });
  });

  it("always offers the stored base type", () => {
    expect(baseTypeOptions("numeric")[0]).toBe("numeric");
    expect(baseTypeOptions("string")).not.toContain("numeric");
  });
});

describe("enum edit form", () => {
  it("keeps only non-blank descriptions of current symbols; none = null", () => {
    expect(enumUpdateFrom(["A", "B"], { description: " d ", valueDescriptions: { A: " first ", B: " ", C: "gone" } })).toEqual({ description: "d", valueDescriptions: { A: "first" } });
    expect(enumUpdateFrom(["A"], { description: "", valueDescriptions: {} }).valueDescriptions).toBeNull();
  });
});

describe("saved message", () => {
  it("names the fields that followed", () => {
    expect(savedMessage("Scalar", "Email", 3)).toBe('Scalar "Email" saved · 3 fields updated');
    expect(savedMessage("Enum", "E", 1)).toBe('Enum "E" saved · 1 field updated');
    expect(savedMessage("Enum", "E", 0)).toBe('Enum "E" saved');
  });
});
