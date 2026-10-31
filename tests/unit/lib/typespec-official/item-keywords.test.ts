import { describe, it, expect } from "vitest";
import { liftItemKeywords } from "@/lib/typespec-official/item-keywords";

const lift = (schema: unknown) => JSON.parse(liftItemKeywords(JSON.stringify(schema, null, 4)));

describe("liftItemKeywords", () => {
  it("puts x-items-<keyword> on the items of the same property, next to a $ref", () => {
    const out = lift({
      type: "object",
      properties: {
        tags: { type: "array", items: { $ref: "Tag.json" }, description: "list", "x-items-description": "one tag", "x-items-minLength": 1, "x-items-maxLength": 40 },
      },
    });
    expect(out.properties.tags).toEqual({ type: "array", items: { $ref: "Tag.json", description: "one tag", minLength: 1, maxLength: 40 }, description: "list" });
  });

  it("works at any depth, and in arrays of schemas", () => {
    const out = lift({ $defs: { A: { properties: { x: { type: "array", items: { type: "string" }, "x-items-pattern": "^a" } } } }, allOf: [{ properties: { y: { type: "array", items: { type: "integer" }, "x-items-minimum": 0 } } }] });
    expect(out.$defs.A.properties.x.items).toEqual({ type: "string", pattern: "^a" });
    expect(out.allOf[0].properties.y.items).toEqual({ type: "integer", minimum: 0 });
  });

  it("leaves an item keyword the items already has, and any other x- key, alone", () => {
    const out = lift({ properties: { a: { type: "array", items: { type: "string", description: "kept" }, "x-items-description": "dropped?", "x-vendor": 1 } } });
    expect(out.properties.a.items.description).toBe("kept");
    expect(out.properties.a["x-vendor"]).toBe(1);
  });

  it("leaves x-items-* where there is no items to put it on", () => {
    const text = JSON.stringify({ properties: { a: { type: "string", "x-items-description": "d" } } }, null, 4);
    expect(liftItemKeywords(text)).toBe(text);
  });

  it("returns text it cannot or need not change as it is", () => {
    expect(liftItemKeywords("not json x-items-")).toBe("not json x-items-");
    const plain = JSON.stringify({ a: 1 }, null, 4) + "\n";
    expect(liftItemKeywords(plain)).toBe(plain);
  });

  it("keeps the trailing newline of the file", () => {
    const text = JSON.stringify({ properties: { a: { type: "array", items: {}, "x-items-title": "t" } } }, null, 4) + "\n";
    expect(liftItemKeywords(text).endsWith("\n")).toBe(true);
  });
});
