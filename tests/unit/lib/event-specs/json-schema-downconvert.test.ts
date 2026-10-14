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

  it("rewriteDefsRef only rewrites $defs where it is the keyword, not a property or definition NAME", () => {
    // `$defs` as a property name / entry name / inside data stays as it is
    expect(rewriteDefsRef("#/properties/$defs")).toBe("#/properties/$defs");
    expect(rewriteDefsRef("#/properties/$defs/properties/x")).toBe("#/properties/$defs/properties/x");
    expect(rewriteDefsRef("#/$defs/$defs")).toBe("#/definitions/$defs");
    expect(rewriteDefsRef("#/definitions/$defs/type")).toBe("#/definitions/$defs/type");
    expect(rewriteDefsRef("#/patternProperties/$defs")).toBe("#/patternProperties/$defs");
    expect(rewriteDefsRef("#/default/$defs/X")).toBe("#/default/$defs/X");
    expect(rewriteDefsRef("#/const/$defs")).toBe("#/const/$defs");
    // ...while keyword positions are rewritten at any depth
    expect(rewriteDefsRef("#/$defs/A/properties/$defs/$defs/B")).toBe("#/definitions/A/properties/$defs/definitions/B");
    expect(rewriteDefsRef("#/allOf/0/$defs/A")).toBe("#/allOf/0/definitions/A");
    expect(rewriteDefsRef("#/items/$defs/A")).toBe("#/items/definitions/A");
    expect(rewriteDefsRef("#/items/0/$defs/A")).toBe("#/items/0/definitions/A");
    expect(rewriteDefsRef("#/properties/a/not/$defs/A")).toBe("#/properties/a/not/definitions/A");
    expect(rewriteDefsRef("common.json#/$defs/A")).toBe("common.json#/definitions/A");
  });

  it("rewriteDefsRef decodes percent-encoded keywords and leaves non-pointer fragments alone", () => {
    expect(rewriteDefsRef("#/%24defs/A")).toBe("#/definitions/A");
    expect(rewriteDefsRef("#/$defs/A/%24defs/B")).toBe("#/definitions/A/definitions/B");
    expect(rewriteDefsRef("#/properties/%24defs")).toBe("#/properties/%24defs");
    expect(rewriteDefsRef("#anchor")).toBe("#anchor");
    expect(rewriteDefsRef("#")).toBe("#");
  });

  it("does not corrupt a $ref that points at a property called $defs", () => {
    const { schema, warnings } = downConvertToDraft07({
      type: "object",
      properties: { $defs: { type: "string" }, other: { $ref: "#/properties/$defs" } },
    });
    expect(schema).toEqual({
      type: "object",
      properties: { $defs: { type: "string" }, other: { $ref: "#/properties/$defs" } },
    });
    expect(warnings).toEqual([]);
  });

  it("wraps $ref siblings in allOf (draft-07 ignores them), keeps annotations outside, and warns", () => {
    const { schema, warnings } = downConvertToDraft07({
      type: "object",
      properties: {
        short: { $ref: "#/$defs/Name", maxLength: 3, description: "Short name", title: "Short" },
        plain: { $ref: "#/$defs/Name", description: "annotations only" },
      },
      $defs: { Name: { type: "string" } },
    });
    expect(schema).toEqual({
      type: "object",
      properties: {
        short: {
          description: "Short name",
          title: "Short",
          allOf: [{ $ref: "#/definitions/Name" }, { maxLength: 3 }],
        },
        plain: { $ref: "#/definitions/Name", description: "annotations only" },
      },
      definitions: { Name: { type: "string" } },
    });
    expect(warnings).toEqual([
      {
        pointer: "/properties/short/$ref",
        keyword: "$ref",
        kind: "rewritten",
        message: '"$ref" siblings (maxLength) are ignored in draft-07; wrapped as allOf: [{ $ref }, { ...siblings }]',
      },
    ]);
  });

  it("wraps at the root without moving definitions, and nests an existing allOf sibling", () => {
    const { schema, warnings } = downConvertToDraft07({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $ref: "#/$defs/Root",
      required: ["id"],
      allOf: [{ minProperties: 1 }],
      $defs: { Root: { type: "object", properties: { id: { type: "string" } } } },
    });
    expect(schema).toEqual({
      $schema: DRAFT_07_META_SCHEMA,
      definitions: { Root: { type: "object", properties: { id: { type: "string" } } } },
      allOf: [{ $ref: "#/definitions/Root" }, { required: ["id"], allOf: [{ minProperties: 1 }] }],
    });
    expect(warnings.map((w) => [w.pointer, w.keyword, w.kind])).toEqual([["/$ref", "$ref", "rewritten"]]);
  });

  it("does not wrap when every sibling was dropped (nothing left to preserve)", () => {
    const { schema, warnings } = downConvertToDraft07({ $ref: "#/$defs/A", unevaluatedProperties: false, $defs: { A: {} } });
    expect(schema).toEqual({ $ref: "#/definitions/A", definitions: { A: {} } });
    expect(warnings.map((w) => [w.keyword, w.kind])).toEqual([["unevaluatedProperties", "dropped"]]);
  });
});
