import { describe, expect, it } from "vitest";
import { summarizeSchemaFields } from "@/features/events/builder/sections/schema-fields";

describe("summarizeSchemaFields", () => {
  it("lists the properties with their types, and marks the required ones", () => {
    const schema = { type: "object", properties: { orderId: { type: "string" }, quantity: { type: "integer" } }, required: ["orderId"] };
    expect(summarizeSchemaFields(schema)).toEqual({
      rows: [{ name: "orderId", type: "string", required: true }, { name: "quantity", type: "integer", required: false }],
      more: 0,
    });
  });

  it("appends the format and joins a type list", () => {
    const schema = { properties: { at: { type: "string", format: "date-time" }, note: { type: ["string", "null"] } } };
    expect(summarizeSchemaFields(schema).rows).toEqual([
      { name: "at", type: "string (date-time)", required: false },
      { name: "note", type: "string | null", required: false },
    ]);
  });

  it("names a referenced type and writes an array as its item type with brackets", () => {
    const schema = {
      properties: {
        buyer: { $ref: "#/$defs/Customer" },
        tags: { type: "array", items: { type: "string" } },
        lines: { type: "array", items: { $ref: "#/$defs/Line" } },
        loose: { type: "array" },
      },
      $defs: { Customer: { type: "object" }, Line: { type: "object" } },
    };
    expect(summarizeSchemaFields(schema).rows.map((r) => r.type)).toEqual(["Customer", "string[]", "Line[]", "array"]);
  });

  it("calls a property with no type by what it is: an enum, a choice, or any", () => {
    const schema = { properties: { kind: { enum: ["a", "b"] }, either: { oneOf: [{ type: "string" }, { type: "integer" }] }, anything: {} } };
    expect(summarizeSchemaFields(schema).rows.map((r) => r.type)).toEqual(["enum", "one of", "any"]);
  });

  it("follows a root $ref into $defs or definitions", () => {
    const viaDefs = { $ref: "#/$defs/Order", $defs: { Order: { properties: { id: { type: "string" } }, required: ["id"] } } };
    expect(summarizeSchemaFields(viaDefs).rows).toEqual([{ name: "id", type: "string", required: true }]);
    const viaDefinitions = { $ref: "#/definitions/Order", definitions: { Order: { properties: { id: { type: "string" } } } } };
    expect(summarizeSchemaFields(viaDefinitions).rows).toEqual([{ name: "id", type: "string", required: false }]);
  });

  it("merges the properties and the required lists of allOf members, a member $ref included", () => {
    const schema = {
      allOf: [{ $ref: "#/$defs/Base" }, { properties: { total: { type: "number" } }, required: ["total"] }],
      $defs: { Base: { properties: { id: { type: "string" } }, required: ["id"] } },
    };
    expect(summarizeSchemaFields(schema).rows).toEqual([
      { name: "id", type: "string", required: true },
      { name: "total", type: "number", required: true },
    ]);
  });

  it("gives up quietly on a $ref cycle", () => {
    const schema = { $ref: "#/$defs/A", $defs: { A: { $ref: "#/$defs/B" }, B: { $ref: "#/$defs/A" } } };
    expect(summarizeSchemaFields(schema)).toEqual({ rows: [], more: 0 });
  });

  it("gives up quietly on a $ref it cannot resolve, on a missing schema and on one with no properties", () => {
    expect(summarizeSchemaFields({ $ref: "#/$defs/Gone" })).toEqual({ rows: [], more: 0 });
    expect(summarizeSchemaFields({ $ref: "https://example.com/other.json" })).toEqual({ rows: [], more: 0 });
    expect(summarizeSchemaFields(null)).toEqual({ rows: [], more: 0 });
    expect(summarizeSchemaFields({ type: "string" })).toEqual({ rows: [], more: 0 });
  });

  it("ignores a required that is not a list of names", () => {
    expect(summarizeSchemaFields({ properties: { a: { type: "string" } }, required: "a" }).rows).toEqual([{ name: "a", type: "string", required: false }]);
  });

  it("shows the first rows up to the limit and counts the rest", () => {
    const properties = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`f${i}`, { type: "string" }]));
    const result = summarizeSchemaFields({ properties });
    expect(result.rows).toHaveLength(8);
    expect(result.rows[0].name).toBe("f0");
    expect(result.more).toBe(3);
    expect(summarizeSchemaFields({ properties }, 2)).toMatchObject({ more: 9 });
  });
});
