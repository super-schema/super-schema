import { describe, it, expect } from "vitest";
import { parseJsonSchemaDocument } from "@/lib/importers/jsonschema.importer";

function data(result: ReturnType<typeof parseJsonSchemaDocument>) {
  if (!result.success) throw new Error("import failed");
  return result.data;
}

describe("JSON Schema importer: generic extension capture", () => {
  it("keeps unknown root and property keys as extensions, values unstringified", () => {
    const result = parseJsonSchemaDocument(
      JSON.stringify({
        title: "Thing",
        type: "object",
        properties: {
          name: { type: "string" },
          legacy: { type: "string", "x-deprecated-reason": "use name" },
        },
        "x-links": [{ rel: "self", href: "https://x" }],
      }),
    );
    expect(result.success).toBe(true);
    const entity = data(result).entities[0];
    expect(entity?.extensions).toEqual({ "x-links": [{ rel: "self", href: "https://x" }] });
    expect(entity?.fields.find((f) => f.name === "legacy")?.extensions).toEqual({
      "x-deprecated-reason": "use name",
    });
    expect(entity?.fields.find((f) => f.name === "name")?.extensions).toBeUndefined();
  });

  it("keeps a __proto__ key as an own extension, not a prototype", () => {
    const result = parseJsonSchemaDocument(
      '{"title":"T","type":"object","properties":{"a":{"type":"string"}},"__proto__":{"isAdmin":true}}'
    );
    const ext = data(result).entities[0].extensions as Record<string, unknown>;
    expect(Object.keys(ext)).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(ext)).toBe(Object.prototype);
    expect(ext.isAdmin).toBeUndefined();
  });

  it("preserves numbers, booleans, null and objects", () => {
    const result = parseJsonSchemaDocument(
      JSON.stringify({
        title: "T",
        type: "object",
        properties: { a: { type: "string", "x-n": 3, "x-b": false, "x-z": null, "x-o": { k: [1] } } },
      }),
    );
    expect(data(result).entities[0].fields[0].extensions).toEqual({
      "x-n": 3,
      "x-b": false,
      "x-z": null,
      "x-o": { k: [1] },
    });
  });

  it("excludes x-tags and x-classification from generic capture", () => {
    const result = parseJsonSchemaDocument(
      JSON.stringify({
        title: "T",
        type: "object",
        "x-tags": ["a"],
        properties: { a: { type: "string", "x-classification": "PII" } },
      }),
    );
    expect(data(result).entities[0].extensions).toBeUndefined();
    expect(data(result).entities[0].fields[0].extensions).toBeUndefined();
  });

  it("captures unknown keys on $defs entities", () => {
    const result = parseJsonSchemaDocument(
      JSON.stringify({
        title: "Root",
        type: "object",
        properties: { a: { type: "string" } },
        $defs: { Child: { type: "object", properties: { b: { type: "string" } }, "x-owner": "team" } },
      }),
    );
    const child = data(result).entities.find((e) => e.name === "Child");
    expect(child?.extensions).toEqual({ "x-owner": "team" });
  });
});
