import { describe, expect, it } from "vitest";
import { parseJsonSchemaDocument } from "@/lib/importers/jsonschema.importer";

const parse = (schema: unknown, sourceName?: string) => parseJsonSchemaDocument(JSON.stringify(schema), undefined, sourceName);

describe("a primitive-only root schema is imported as a shared scalar", () => {
  it("keeps pattern and length constraints of a string", () => {
    const r = parse({ type: "string", title: "CountryCode", description: "ISO 3166-1 alpha-2.", pattern: "^[A-Z]{2}$", minLength: 2, maxLength: 2 });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.entities).toHaveLength(0);
    expect(r.data.rootScalarName).toBe("CountryCode");
    expect(r.data.scalars).toHaveLength(1);
    const s = r.data.scalars[0];
    expect(s).toMatchObject({ name: "CountryCode", baseType: "string", logicalType: "string", description: "ISO 3166-1 alpha-2." });
    expect(s.constraints).toEqual(expect.arrayContaining([
      { type: "minLength", value: 2 },
      { type: "maxLength", value: 2 },
      { type: "pattern", value: "^[A-Z]{2}$" },
    ]));
  });

  it("maps a string format to the matching type and keeps the format", () => {
    const r = parse({ type: "string", title: "DateTime", format: "date-time", maxLength: 64 });
    expect(r.success).toBe(true);
    if (!r.success) return;
    const s = r.data.scalars[0];
    expect(s.name).toBe("DateTime");
    expect(s.logicalType).not.toBe("string");
    // maxLength does not apply to a date-time: reported, not silently dropped
    expect(r.data.warnings.join("\n")).toMatch(/maxLength/);
  });

  it("keeps numeric bounds of an integer", () => {
    const r = parse({ type: "integer", title: "Percentage", minimum: 0, maximum: 100 });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.scalars[0].constraints).toEqual(expect.arrayContaining([{ type: "minValue", value: 0 }, { type: "maxValue", value: 100 }]));
  });

  it("names the scalar from the file when the schema has no title", () => {
    const r = parse({ type: "string", pattern: "^[a-z]+$" }, "common/language.json");
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.scalars[0].name).toBe("language");
  });

  it("still refuses an empty object schema", () => {
    const r = parse({ type: "object", title: "Empty" });
    expect(r.success).toBe(false);
  });

  it("a string enum stays an enum, not a scalar", () => {
    const r = parse({ type: "string", title: "Color", enum: ["RED", "GREEN"] });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.scalars).toHaveLength(0);
    expect(r.data.enums.map((e) => e.name)).toEqual(["Color"]);
  });
});
