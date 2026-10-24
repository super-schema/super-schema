import { describe, expect, it } from "vitest";
import { BIGQUERY_BIGNUMERIC_LIMITS, BIGQUERY_NUMERIC_LIMITS, declaredDecimalFacts } from "@/lib/importers/decimal-facts";

describe("declaredDecimalFacts: what a source may declare for a decimal", () => {
  it.each([
    [12, 2],
    [1, 0],
    [76, 76],
    [76, 0],
    [10, 10],
  ])("accepts precision %i and scale %i", (precision, scale) => {
    expect(declaredDecimalFacts(precision, scale)).toEqual({ ok: true, precision, scale });
  });

  it("a scale that is not given is 0, as in Avro and in BigQuery's NUMERIC(p)", () => {
    expect(declaredDecimalFacts(9, undefined)).toEqual({ ok: true, precision: 9, scale: 0 });
  });

  it.each([
    ["no precision", undefined, 2],
    ["a precision of 0", 0, 0],
    ["a negative precision", -3, 0],
    ["a fractional precision", 1.5, 0],
    ["a precision that is a string", "12", 2],
    ["a null precision", null, 2],
    ["a precision above 76", 77, 2],
    ["a precision of 1e10", 1e10, 2],
    ["a precision that overflows a double (1e309)", Number("1e309"), 2],
    ["a precision of 99999999999", 99_999_999_999, 2],
    ["NaN", Number.NaN, 2],
    ["a scale above the precision", 12, 13],
    ["a negative scale", 12, -1],
    ["a fractional scale", 12, 0.5],
    ["a scale that is a string", 12, "2"],
    ["a scale of 1e309", 12, Number("1e309")],
    ["a scale beyond the safe integers", 12, 2 ** 53],
  ])("refuses %s", (_name, precision, scale) => {
    const result = declaredDecimalFacts(precision, scale);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(10);
  });

  it("applies the limits of the dialect it is given: BigQuery NUMERIC is precision 38 / scale 9 / 29 digits before the point, BIGNUMERIC 76 / 38 / 38", () => {
    expect(declaredDecimalFacts(38, 9, BIGQUERY_NUMERIC_LIMITS).ok).toBe(true);
    expect(declaredDecimalFacts(39, 9, BIGQUERY_NUMERIC_LIMITS).ok).toBe(false);
    expect(declaredDecimalFacts(20, 10, BIGQUERY_NUMERIC_LIMITS).ok).toBe(false);
    expect(declaredDecimalFacts(38, 8, BIGQUERY_NUMERIC_LIMITS).ok).toBe(false); // 30 digits before the point
    expect(declaredDecimalFacts(76, 38, BIGQUERY_BIGNUMERIC_LIMITS).ok).toBe(true);
    expect(declaredDecimalFacts(77, 38, BIGQUERY_BIGNUMERIC_LIMITS).ok).toBe(false);
    expect(declaredDecimalFacts(76, 39, BIGQUERY_BIGNUMERIC_LIMITS).ok).toBe(false);
    expect(declaredDecimalFacts(76, 37, BIGQUERY_BIGNUMERIC_LIMITS).ok).toBe(false); // 39 digits before the point
  });

  it("every accepted pair fits a 32-bit integer column (the database's Int)", () => {
    for (let precision = 1; precision <= 76; precision += 1) {
      for (const scale of [0, precision]) {
        const result = declaredDecimalFacts(precision, scale);
        expect(result.ok).toBe(true);
        if (result.ok) expect(Math.max(result.precision, result.scale)).toBeLessThan(2 ** 31);
      }
    }
  });
});
