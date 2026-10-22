import { describe, it, expect } from "vitest";
import { parseJsonSchemaDocument } from "@/lib/importers/jsonschema.importer";

function data(content: unknown) {
  const result = parseJsonSchemaDocument(typeof content === "string" ? content : JSON.stringify(content));
  if (!result.success) throw new Error("import failed");
  return result.data;
}

const STANDARD_UNSUPPORTED: Record<string, unknown> = {
  not: { type: "null" },
  if: { type: "string" },
  then: { minLength: 1 },
  else: { maxLength: 9 },
  dependentRequired: { a: ["b"] },
  dependentSchemas: { a: { type: "object" } },
  $dynamicRef: "#meta",
  $dynamicAnchor: "meta",
  $recursiveRef: "#",
  unevaluatedProperties: false,
  unevaluatedItems: false,
  patternProperties: { "^x": { type: "string" } },
  propertyNames: { pattern: "^a" },
  additionalProperties: { type: "string" },
  contains: { type: "string" },
  minContains: 1,
  maxContains: 2,
  prefixItems: [{ type: "string" }],
  multipleOf: 5,
  uniqueItems: true,
  minProperties: 1,
  maxProperties: 4,
  contentEncoding: "base64",
  contentMediaType: "image/png",
  contentSchema: { type: "string" },
  readOnly: true,
  writeOnly: true,
  examples: ["a"],
  example: "a",
  $comment: "note",
  $anchor: "anc",
  default: "x",
};

describe("JSON Schema importer: ignoredKeywords", () => {
  it("reports every standard unsupported keyword on a field with its entity.field warning", () => {
    const d = data({ title: "T", type: "object", properties: { a: { type: "string", ...STANDARD_UNSUPPORTED } } });
    const field = d.entities[0].fields[0];
    expect([...(field.ignoredKeywords ?? [])].sort()).toEqual(Object.keys(STANDARD_UNSUPPORTED).sort());
    for (const keyword of Object.keys(STANDARD_UNSUPPORTED)) {
      expect(d.warnings).toContain(`Field \`T.a\`: JSON Schema keyword \`${keyword}\` is not supported and was ignored`);
    }
    // never also kept as extensions
    expect(field.extensions).toBeUndefined();
  });

  it("reports unsupported keywords on the entity (root and $defs)", () => {
    const d = data({
      title: "Root",
      type: "object",
      not: {},
      additionalProperties: false,
      properties: { a: { type: "string" } },
      $defs: { Child: { type: "object", patternProperties: {}, properties: { b: { type: "string" } } } },
    });
    expect(d.entities.find((e) => e.name === "Root")?.ignoredKeywords).toEqual(["not", "additionalProperties"]);
    expect(d.entities.find((e) => e.name === "Child")?.ignoredKeywords).toEqual(["patternProperties"]);
    expect(d.warnings).toContain("Entity `Root`: JSON Schema keyword `not` is not supported and was ignored");
    expect(d.warnings).toContain("Entity `Child`: JSON Schema keyword `patternProperties` is not supported and was ignored");
  });

  it("does not report keywords the importer consumes, vendor keys, or the classification key", () => {
    const d = data({
      title: "T",
      type: "object",
      required: ["a"],
      properties: {
        a: {
          type: "integer",
          format: "int32",
          description: "d",
          minimum: 1,
          maximum: 9,
          exclusiveMinimum: 0,
          exclusiveMaximum: 10,
          deprecated: true,
          "x-custom": 1,
          unknownThing: 2,
          "x-securityClassification": { data_class: "PII", data_category: "contact" },
        },
        list: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 },
        s: { type: "string", pattern: "^a", minLength: 1, maxLength: 2, enum: ["a", "b"] },
      },
    });
    expect(d.entities[0].fields.every((f) => f.ignoredKeywords === undefined)).toBe(true);
    expect(d.entities[0].fields[0].extensions).toMatchObject({ "x-custom": 1, unknownThing: 2 });
    expect(d.warnings.filter((w) => w.includes("not supported"))).toEqual([]);
  });

  it("reports a property-level title (unused) but not the root title (the entity name)", () => {
    const d = data({ title: "T", type: "object", properties: { a: { type: "string", title: "A!" } } });
    expect(d.entities[0].ignoredKeywords).toBeUndefined();
    expect(d.entities[0].fields[0].ignoredKeywords).toEqual(["title"]);
  });

  it("caps the warnings and adds an overflow warning", () => {
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < 150; i++) properties[`f${i}`] = { type: "string", not: {}, multipleOf: 1 };
    const d = data({ title: "Big", type: "object", properties });
    const ignoredWarnings = d.warnings.filter((w) => w.includes("is not supported and was ignored"));
    expect(ignoredWarnings).toHaveLength(200);
    expect(d.warnings).toContain("…and 100 more ignored-keyword warnings");
    // the data itself is complete
    expect(d.entities[0].fields[149].ignoredKeywords).toEqual(["not", "multipleOf"]);
  });

  it("is safe with hostile keys", () => {
    const d = data(
      '{"title":"T","type":"object","__proto__":{"x":1},"properties":{"__proto__":{"type":"string","not":{}},"constructor":{"type":"string","hasOwnProperty":1}}}',
    );
    const fields = d.entities[0].fields;
    expect(fields.find((f) => f.name === "__proto__")?.ignoredKeywords).toEqual(["not"]);
    expect(fields.find((f) => f.name === "constructor")?.extensions).toEqual({ hasOwnProperty: 1 });
    expect(({} as Record<string, unknown>).not).toBeUndefined();
  });
});
