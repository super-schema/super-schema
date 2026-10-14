import { describe, it, expect } from "vitest";
import { DRAFT_07_META_SCHEMA, downConvertToDraft07, rewriteDefsRef } from "@/lib/event-specs/json-schema-downconvert";
import type { JsonObject } from "@/lib/event-specs/types";
import { deepFreeze } from "./fixtures/builders";

describe("downConvertToDraft07 (spec §7.3, Story 16.2)", () => {
  it("renames $defs to definitions and rewrites $ref fragments", () => {
    const { schema, warnings } = downConvertToDraft07({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { shipTo: { $ref: "#/$defs/Address" }, billTo: { $ref: "common.json#/$defs/Address" } },
      $defs: { Address: { type: "object", properties: { zip: { $ref: "#/$defs/Zip" } } }, Zip: { type: "string" } },
    });
    expect(schema).toEqual({
      $schema: DRAFT_07_META_SCHEMA,
      type: "object",
      properties: { shipTo: { $ref: "#/definitions/Address" }, billTo: { $ref: "common.json#/definitions/Address" } },
      definitions: {
        Address: { type: "object", properties: { zip: { $ref: "#/definitions/Zip" } } },
        Zip: { type: "string" },
      },
    });
    expect(warnings).toEqual([]);
  });

  it("converts prefixItems to the items array and a sibling items to additionalItems", () => {
    const { schema } = downConvertToDraft07({
      type: "array",
      prefixItems: [{ type: "string" }, { type: "number" }],
      items: false,
    });
    expect(schema).toEqual({ type: "array", items: [{ type: "string" }, { type: "number" }], additionalItems: false });
    expect(downConvertToDraft07({ type: "array", items: { type: "string" } }).schema).toEqual({
      type: "array",
      items: { type: "string" },
    });
  });

  it("folds dependentRequired and dependentSchemas into dependencies", () => {
    const { schema } = downConvertToDraft07({
      type: "object",
      dependentRequired: { card: ["billingAddress"], vat: ["country"] },
      dependentSchemas: { vat: { properties: { country: { $ref: "#/$defs/Country" } } } },
    });
    expect(schema).toEqual({
      type: "object",
      dependencies: {
        card: ["billingAddress"],
        vat: { allOf: [{ required: ["country"] }, { properties: { country: { $ref: "#/definitions/Country" } } }] },
      },
    });
  });

  it("drops keywords draft-07 cannot express, with a pointer per warning", () => {
    const { schema, warnings } = downConvertToDraft07({
      type: "object",
      unevaluatedProperties: false,
      properties: { tags: { type: "array", contains: { type: "string" }, minContains: 1 } },
      $defs: { Node: { $anchor: "node", type: "object" } },
    });
    expect(schema).toEqual({
      type: "object",
      properties: { tags: { type: "array", contains: { type: "string" } } },
      definitions: { Node: { type: "object" } },
    });
    expect(warnings.map((w) => [w.pointer, w.keyword])).toEqual([
      ["/unevaluatedProperties", "unevaluatedProperties"],
      ["/properties/tags/minContains", "minContains"],
      ["/$defs/Node/$anchor", "$anchor"],
    ]);
  });

  it("leaves data keywords and property names alone", () => {
    const input: JsonObject = {
      type: "object",
      properties: { $defs: { type: "string", const: "#/$defs/X" } },
      default: { $ref: "#/$defs/X" },
      examples: [{ unevaluatedProperties: 1 }],
    };
    const { schema, warnings } = downConvertToDraft07(input);
    expect(schema).toEqual(input);
    expect(warnings).toEqual([]);
  });

  it("does not mutate its input", () => {
    const input = deepFreeze<JsonObject>({ $defs: { A: { type: "string" } }, prefixItems: [{ $ref: "#/$defs/A" }] });
    expect(() => downConvertToDraft07(input)).not.toThrow();
    expect(input).toEqual({ $defs: { A: { type: "string" } }, prefixItems: [{ $ref: "#/$defs/A" }] });
  });

  it("rewriteDefsRef only touches the fragment", () => {
    expect(rewriteDefsRef("#/$defs/A/$defs/B")).toBe("#/definitions/A/definitions/B");
    expect(rewriteDefsRef("schemas/$defs.json")).toBe("schemas/$defs.json");
  });
});
