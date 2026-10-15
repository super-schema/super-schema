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
    // (`unevaluatedItems`, not `unevaluatedProperties`: that one is converted on a plain object — see below)
    const { schema, warnings } = downConvertToDraft07({
      type: "object",
      unevaluatedItems: false,
      properties: { tags: { type: "array", contains: { type: "string" }, minContains: 1 } },
      $defs: { Node: { $anchor: "node", type: "object" } },
    });
    expect(schema).toEqual({
      type: "object",
      properties: { tags: { type: "array", contains: { type: "string" } } },
      definitions: { Node: { type: "object" } },
    });
    expect(warnings.map((w) => [w.pointer, w.keyword])).toEqual([
      ["/unevaluatedItems", "unevaluatedItems"],
      ["/properties/tags/minContains", "minContains"],
      ["/$defs/Node/$anchor", "$anchor"],
    ]);
  });

  describe("unevaluatedProperties (C-I4)", () => {
    it("converts it to additionalProperties on a plain object schema, keeping the value type (TypeSpec Record<T>)", () => {
      const { schema, warnings } = downConvertToDraft07({
        type: "object",
        properties: { tags: { $ref: "#/$defs/RecordInt32" } },
        $defs: {
          RecordInt32: { type: "object", properties: {}, unevaluatedProperties: { type: "integer", minimum: -2147483648, maximum: 2147483647 } },
          RecordBase: { type: "object", properties: {}, unevaluatedProperties: { $ref: "#/$defs/Base" } },
          RecordUnknown: { type: "object", properties: {}, unevaluatedProperties: {} },
          Base: { type: "object", properties: { a: { type: "string" } } },
        },
      });
      expect(schema).toEqual({
        type: "object",
        properties: { tags: { $ref: "#/definitions/RecordInt32" } },
        definitions: {
          RecordInt32: { type: "object", properties: {}, additionalProperties: { type: "integer", minimum: -2147483648, maximum: 2147483647 } },
          RecordBase: { type: "object", properties: {}, additionalProperties: { $ref: "#/definitions/Base" } },
          RecordUnknown: { type: "object", properties: {}, additionalProperties: {} },
          Base: { type: "object", properties: { a: { type: "string" } } },
        },
      });
      // an exact equivalence: nothing was lost, so nothing is reported
      expect(warnings).toEqual([]);
    });

    it("carries a boolean through, and works with properties / patternProperties (or neither)", () => {
      expect(
        downConvertToDraft07({ type: "object", properties: { a: { type: "string" } }, unevaluatedProperties: false }).schema,
      ).toEqual({ type: "object", properties: { a: { type: "string" } }, additionalProperties: false });
      expect(
        downConvertToDraft07({ type: "object", patternProperties: { "^x-": { type: "string" } }, unevaluatedProperties: true }).schema,
      ).toEqual({ type: "object", patternProperties: { "^x-": { type: "string" } }, additionalProperties: true });
      expect(downConvertToDraft07({ type: "object", unevaluatedProperties: false }).schema).toEqual({
        type: "object",
        additionalProperties: false,
      });
    });

    it("converts the nested subschema's own unevaluatedProperties too", () => {
      const { schema } = downConvertToDraft07({
        type: "object",
        properties: { inner: { type: "object", properties: {}, unevaluatedProperties: { type: "string" } } },
      });
      expect(schema).toEqual({
        type: "object",
        properties: { inner: { type: "object", properties: {}, additionalProperties: { type: "string" } } },
      });
    });

    it.each([
      ["allOf", { allOf: [{ properties: { a: { type: "string" } } }] }],
      ["anyOf", { anyOf: [{ properties: { a: { type: "string" } } }] }],
      ["oneOf", { oneOf: [{ properties: { a: { type: "string" } } }] }],
      ["$ref", { $ref: "#/$defs/A" }],
      ["if/then/else", { if: { required: ["a"] }, then: { properties: { b: { type: "string" } } } }],
      ["dependentSchemas", { dependentSchemas: { a: { properties: { b: { type: "string" } } } } }],
      ["not", { not: { required: ["a"] } }],
      ["additionalProperties", { additionalProperties: { type: "string" } }],
    ])("keeps dropping it, with the warning, when a %s sibling may evaluate properties", (_name, siblings) => {
      const { schema, warnings } = downConvertToDraft07({
        type: "object",
        properties: { id: { type: "string" } },
        unevaluatedProperties: false,
        ...siblings,
        $defs: { A: { type: "object" } },
      });
      expect(schema.unevaluatedProperties).toBeUndefined();
      expect(Object.keys(schema)).not.toContain("unevaluatedProperties");
      // nothing was turned into additionalProperties on the user's behalf
      if (!("additionalProperties" in siblings)) expect(schema.additionalProperties).toBeUndefined();
      expect(warnings.some((w) => w.keyword === "unevaluatedProperties" && w.kind === "dropped")).toBe(true);
    });

    it("does not touch a property or example that is merely CALLED unevaluatedProperties", () => {
      const input: JsonObject = {
        type: "object",
        properties: { unevaluatedProperties: { type: "string" } },
        examples: [{ unevaluatedProperties: 1 }],
      };
      expect(downConvertToDraft07(input).schema).toEqual(input);
    });
  });

  it("keeps a `__proto__` property / definition as an own entry instead of setting the prototype", () => {
    const input = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"string"},"ok":{"type":"integer"}},"$defs":{"__proto__":{"type":"boolean"}}}',
    ) as JsonObject;
    const { schema } = downConvertToDraft07(input);
    const properties = schema.properties as JsonObject;
    expect(Object.keys(properties)).toEqual(["__proto__", "ok"]);
    expect(Object.getPrototypeOf(properties)).toBe(Object.prototype);
    expect(Object.keys(schema.definitions as JsonObject)).toEqual(["__proto__"]);
    expect(JSON.stringify(schema)).toContain('"__proto__":{"type":"string"}');
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
