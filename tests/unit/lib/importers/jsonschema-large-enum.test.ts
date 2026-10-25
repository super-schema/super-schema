/**
 * A numeric `enum` of ~130,000 values made `Math.min(...numbers)` throw (a RangeError: too many arguments), reported as "nested too deeply".
 * The range is a loop now, and an enum is bounded: past MAX_ENUM_VALUES symbols the rest are dropped, with a warning that says how many.
 */
import { describe, it, expect } from "vitest";
import { parseJsonSchemaDocument, MAX_ENUM_VALUES } from "@/lib/importers/jsonschema.importer";

function importDoc(schema: unknown) {
  const r = parseJsonSchemaDocument(JSON.stringify(schema));
  if (!r.success) throw new Error(r.error.message);
  return r.data;
}
const field = (doc: ReturnType<typeof importDoc>, name: string) => doc.entities[0].fields.find((f) => f.name === name)!;

describe("a numeric enum of 200,000 values", () => {
  it("imports as a number with its range, not as 'nested too deeply'", () => {
    const values = Array.from({ length: 200_000 }, (_, i) => i);
    const started = performance.now();
    const d = importDoc({ title: "R", type: "object", properties: { n: { type: "integer", enum: values } } });
    expect(performance.now() - started).toBeLessThan(5000);
    expect(field(d, "n")).toMatchObject({ type: "integer", confidence: "low" });
    expect(field(d, "n").constraints).toEqual([{ type: "minValue", value: 0 }, { type: "maxValue", value: 199_999 }]);
  });

  it("floats, and a mixed enum, do not throw either", () => {
    const floats = Array.from({ length: 200_000 }, (_, i) => i + 0.5);
    expect(field(importDoc({ title: "R", type: "object", properties: { n: { enum: floats } } }), "n")).toMatchObject({ type: "float64" });
    const mixed = [...floats, "x", null];
    expect(field(importDoc({ title: "R", type: "object", properties: { n: { enum: mixed } } }), "n").type).toBe("string");
  });

  it("the original type is a short label, not the 1 MB list", () => {
    const d = importDoc({ title: "R", type: "object", properties: { n: { enum: Array.from({ length: 100_000 }, (_, i) => i) } } });
    expect(field(d, "n").originalType).toBe("enum(100000 values)");
    expect(importDoc({ title: "R", type: "object", properties: { n: { enum: [1, 2, 5] } } }).entities[0].fields[0].originalType).toBe("enum(1,2,5)");
  });
});

describe("an enum is bounded", () => {
  const symbols = (n: number) => Array.from({ length: n }, (_, i) => `S${i}`);

  it("the cap is 5000", () => {
    expect(MAX_ENUM_VALUES).toBe(5000);
  });

  it("a property enum past the cap keeps the first 5000 symbols and says how many were dropped", () => {
    const d = importDoc({ title: "R", type: "object", properties: { s: { type: "string", enum: symbols(6000) } } });
    expect(field(d, "s").enumValues).toHaveLength(5000);
    expect(field(d, "s").enumValues![4999]).toBe("S4999");
    expect(d.warnings).toContain("Enum R.s has 6000 values; only the first 5000 are kept (1000 dropped).");
  });

  it("an enum at the cap is untouched, with no warning", () => {
    const d = importDoc({ title: "R", type: "object", properties: { s: { type: "string", enum: symbols(5000) } } });
    expect(field(d, "s").enumValues).toHaveLength(5000);
    expect(d.warnings.filter((w) => w.startsWith("Enum"))).toEqual([]);
  });

  it("a shared $defs enum past the cap is bounded once, in the enum and in the field that uses it", () => {
    const d = importDoc({
      title: "R", type: "object",
      properties: { a: { $ref: "#/$defs/Big" }, b: { $ref: "#/$defs/Big" } },
      $defs: { Big: { type: "string", enum: symbols(7000) } },
    });
    expect(d.enums[0].values).toHaveLength(5000);
    expect(field(d, "a").enumValues).toHaveLength(5000);
    expect(d.warnings.filter((w) => w.startsWith("Enum"))).toEqual(["Enum Big has 7000 values; only the first 5000 are kept (2000 dropped)."]);
  });
});
