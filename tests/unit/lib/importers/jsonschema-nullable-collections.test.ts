/**
 * A nullable array or map is the field itself: `anyOf` / `oneOf` of `[X, { type: "null" }]` is the shape the JSON Schema emitter writes for
 * `X[] | null` and `Record<string, X> | null`. Its element or value type must be the one the same property gets without the null (the
 * reference and enum targets of that type included), where a plain `items` / `additionalProperties` on the property itself was always read.
 */
import { describe, it, expect } from "vitest";
import { parseJsonSchemaDocument } from "@/lib/importers/jsonschema.importer";

const DEFS = {
  Line: { type: "object", properties: { sku: { type: "string" } } },
  Tags: { type: "array", items: { type: "string" } },
};

/** The field `p` of the entity `R`, whose only property is `p`. */
function fieldP(property: Record<string, unknown>) {
  const r = parseJsonSchemaDocument(JSON.stringify({ title: "R", type: "object", $defs: DEFS, properties: { p: property } }));
  if (!r.success) throw new Error(r.error.message);
  const entity = r.data.entities.find((e) => e.name === "R")!;
  return entity.fields.find((f) => f.name === "p")!;
}

const ARRAYS: Array<[string, Record<string, unknown>]> = [
  ["a string item", { type: "array", items: { type: "string" } }],
  ["an integer item", { type: "array", items: { type: "integer" } }],
  ["an entity item", { type: "array", items: { $ref: "#/$defs/Line" } }],
  ["an enum item", { type: "array", items: { type: "string", enum: ["a", "b"] } }],
];

const MAPS: Array<[string, Record<string, unknown>]> = [
  ["a string value", { type: "object", additionalProperties: { type: "string" } }],
  ["an entity value", { type: "object", additionalProperties: { $ref: "#/$defs/Line" } }],
  ["an enum value", { type: "object", additionalProperties: { type: "string", enum: ["a", "b"] } }],
];

describe("a nullable array keeps its element type", () => {
  it.each(ARRAYS)("%s, in anyOf and in oneOf, as the same array without the null", (_label, array) => {
    const plain = fieldP(array);
    expect(plain.type).toBe("array");
    expect(plain.arrayElementType).toBeDefined();
    for (const keyword of ["anyOf", "oneOf"]) {
      const nullable = fieldP({ [keyword]: [array, { type: "null" }] });
      expect(nullable.type).toBe("array");
      expect(nullable.nullableType).toBe(true);
      expect(nullable.arrayElementType).toBe(plain.arrayElementType);
      expect(nullable.referencedEntityName).toBe(plain.referencedEntityName);
      expect(nullable.enumValues).toEqual(plain.enumValues);
      expect(nullable.confidence).toBe(plain.confidence);
    }
  });

  it("the null member may come first", () => {
    const plain = fieldP({ type: "array", items: { $ref: "#/$defs/Line" } });
    const nullable = fieldP({ anyOf: [{ type: "null" }, { type: "array", items: { $ref: "#/$defs/Line" } }] });
    expect(nullable.arrayElementType).toBe(plain.arrayElementType);
    expect(nullable.referencedEntityName).toBe("Line");
  });

  it("the array may be written as an allOf inside the null wrapper", () => {
    const plain = fieldP({ type: "array", items: { type: "string" } });
    const nullable = fieldP({ anyOf: [{ allOf: [{ type: "array", items: { type: "string" } }] }, { type: "null" }] });
    expect(nullable).toMatchObject({ type: "array", nullableType: true });
    expect(nullable.arrayElementType).toBe(plain.arrayElementType);
  });

  it("a plain array of entities still references the entity", () => {
    expect(fieldP({ type: "array", items: { $ref: "#/$defs/Line" } })).toMatchObject({ arrayElementType: "reference", referencedEntityName: "Line" });
  });
});

describe("a nullable reference to a named array keeps its element type", () => {
  it.each(["anyOf", "oneOf"])("a reference to an array definition, in %s with null, as the same reference without the null", (keyword) => {
    const plain = fieldP({ $ref: "#/$defs/Tags" });
    const nullable = fieldP({ [keyword]: [{ $ref: "#/$defs/Tags" }, { type: "null" }] });
    expect(plain.arrayElementType).toBe("string");
    expect(nullable).toMatchObject({ type: "array", nullableType: true });
    expect(nullable.arrayElementType).toBe(plain.arrayElementType);
  });
});

describe("a nullable map keeps its value type", () => {
  it.each(MAPS)("%s, in anyOf and in oneOf, as the same map without the null", (_label, map) => {
    const plain = fieldP(map);
    expect(plain.type).toBe("map");
    expect(plain.mapValueType).toBeDefined();
    for (const keyword of ["anyOf", "oneOf"]) {
      const nullable = fieldP({ [keyword]: [map, { type: "null" }] });
      expect(nullable).toMatchObject({ type: "map", nullableType: true, mapKeyType: "string" });
      expect(nullable.mapValueType).toBe(plain.mapValueType);
      expect(nullable.referencedEntityName).toBe(plain.referencedEntityName);
      expect(nullable.enumValues).toEqual(plain.enumValues);
    }
  });
});
