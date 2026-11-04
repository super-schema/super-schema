import { describe, expect, it } from "vitest";
import { parseJsonSchemaDocument } from "@/lib/importers/jsonschema.importer";
import { buildDecoratorsFromParsedField } from "@/lib/importers/decorator-builder";

const parse = (props: Record<string, unknown>) => {
  const r = parseJsonSchemaDocument(JSON.stringify({ type: "object", title: "O", properties: props }));
  if (!r.success) throw new Error(r.error.message);
  return r.data;
};
const field = (d: ReturnType<typeof parse>, name: string) => d.entities[0].fields.find((f) => f.name === name)!;

describe("default", () => {
  it("is kept as the field's default for string, number and boolean", () => {
    const d = parse({ s: { type: "string", default: "x" }, n: { type: "integer", default: 3 }, b: { type: "boolean", default: false } });
    expect(field(d, "s").defaultValue).toBe("x");
    expect(field(d, "n").defaultValue).toBe(3);
    expect(field(d, "b").defaultValue).toBe(false);
    expect(buildDecoratorsFromParsedField(field(d, "b"))).toMatchObject({ typespec: { identity: { defaultValue: false } } });
    expect(d.warnings.join("\n")).not.toMatch(/default/);
    expect(field(d, "s").extensions?.default).toBeUndefined();
    expect(field(d, "s").ignoredKeywords ?? []).not.toContain("default");
  });

  it("a default that does not fit the type is not applied and says so", () => {
    const d = parse({ n: { type: "integer", default: "three" }, o: { type: "object", default: {} } });
    expect(field(d, "n").defaultValue).toBeUndefined();
    expect(d.warnings.join("\n")).toMatch(/default/);
    expect(field(d, "n").ignoredKeywords).toContain("default");
  });

  it("an enum's default is not applied (TypeSpec writes it as a member, not a string)", () => {
    const d = parse({ e: { type: "string", enum: ["A", "B"], default: "A" } });
    expect(field(d, "e").defaultValue).toBeUndefined();
    expect(field(d, "e").ignoredKeywords).toContain("default");
  });
});

describe("readOnly / writeOnly", () => {
  it("map to the lifecycle phases of the field", () => {
    const d = parse({ r: { type: "string", readOnly: true }, w: { type: "string", writeOnly: true }, f: { type: "string", readOnly: false } });
    expect(field(d, "r").visibility).toEqual(["Read"]);
    expect(field(d, "w").visibility).toEqual(["Create", "Update"]);
    expect(field(d, "f").visibility).toBeUndefined();
    expect(buildDecoratorsFromParsedField(field(d, "r"))).toMatchObject({ typespec: { visibility: { phases: ["Read"] } } });
    expect(d.warnings.join("\n")).not.toMatch(/readOnly|writeOnly/);
    expect(field(d, "r").ignoredKeywords ?? []).not.toContain("readOnly");
  });

  it("both true: readOnly wins, with a warning", () => {
    const d = parse({ x: { type: "string", readOnly: true, writeOnly: true } });
    expect(field(d, "x").visibility).toEqual(["Read"]);
    expect(d.warnings.join("\n")).toMatch(/readOnly and writeOnly/);
  });
});

describe("patternProperties", () => {
  it("one pattern is a map of that value type; the pattern is kept as x-pattern-properties", () => {
    const d = parse({ labels: { type: "object", patternProperties: { "^x-": { type: "string" } } } });
    const f = field(d, "labels");
    expect(f).toMatchObject({ type: "map", mapKeyType: "string", mapValueType: "string" });
    expect(f.extensions?.["x-pattern-properties"]).toEqual({ "^x-": { type: "string" } });
    expect(f.ignoredKeywords ?? []).not.toContain("patternProperties");
    expect(f.extensions?.patternProperties).toBeUndefined();
  });

  it("several patterns: the first types the map (low confidence), all are kept, and it is reported", () => {
    const d = parse({ m: { type: "object", patternProperties: { "^a": { type: "string" }, "^b": { type: "integer" } } } });
    const f = field(d, "m");
    expect(f).toMatchObject({ type: "map", mapValueType: "string", confidence: "low" });
    expect(Object.keys(f.extensions?.["x-pattern-properties"] as object)).toEqual(["^a", "^b"]);
    expect(d.warnings.join("\n")).toMatch(/patternProperties/);
  });

  it("an object with properties keeps them and does not become a map", () => {
    const d = parse({ o: { type: "object", properties: { a: { type: "string" } }, patternProperties: { "^x": { type: "string" } } } });
    expect(field(d, "o").type).not.toBe("map");
  });
});

describe("item description", () => {
  it("is a first-class field fact, still written as x-items-description for the round trip", () => {
    const d = parse({ tags: { type: "array", items: { type: "string", description: "One tag." } } });
    const f = field(d, "tags");
    expect(f.itemDescription).toBe("One tag.");
    expect(f.extensions?.["x-items-description"]).toBe("One tag.");
    expect(buildDecoratorsFromParsedField(f)).toMatchObject({ semantics: { itemDescription: "One tag." } });
    expect(d.warnings.join("\n")).not.toMatch(/IR has no element-level/);
  });
});
