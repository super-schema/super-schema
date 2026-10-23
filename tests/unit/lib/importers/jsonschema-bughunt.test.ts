/** Bug-hunt wave: inline $defs refs, entity-level oneOf/anyOf/not, unions of external refs, escaped pointers. */
import { describe, it, expect } from "vitest";
import { parseJsonSchemaDocument } from "@/lib/importers/jsonschema.importer";
import type { MultiEntityImportResult, ParsedEntity } from "@/lib/importers/types";

function parse(schema: unknown): MultiEntityImportResult {
  const r = parseJsonSchemaDocument(JSON.stringify(schema));
  if (!r.success) throw new Error(r.error.message);
  return r.data;
}
const field = (e: ParsedEntity, name: string) => {
  const f = e.fields.find((x) => x.name === name);
  if (!f) throw new Error(`no field ${name}`);
  return f;
};

describe("#2 an inline $defs definition referenced by $ref keeps its annotations", () => {
  it("carries constraints, description, deprecated and extensions onto the field", () => {
    const doc = parse({
      title: "R",
      type: "object",
      properties: { a: { $ref: "#/$defs/S" } },
      $defs: { S: { type: "string", maxLength: 5, minLength: 2, description: "short", deprecated: true, "x-owner": "team" } },
    });
    const a = field(doc.entities[0], "a");
    expect(a.constraints).toEqual(expect.arrayContaining([{ type: "maxLength", value: 5 }, { type: "minLength", value: 2 }]));
    expect(a.description).toBe("short");
    expect(a.deprecated).toBe(true);
    expect(a.extensions).toMatchObject({ "x-owner": "team" });
  });

  it("the property's own siblings win on conflict", () => {
    const doc = parse({
      title: "R",
      type: "object",
      properties: { a: { $ref: "#/$defs/S", maxLength: 9, description: "mine" } },
      $defs: { S: { type: "string", maxLength: 5, description: "theirs" } },
    });
    const a = field(doc.entities[0], "a");
    expect(a.constraints).toEqual([{ type: "maxLength", value: 9 }]);
    expect(a.description).toBe("mine");
  });

  it("a chain of inline definitions is followed and a cycle does not loop", () => {
    const doc = parse({
      title: "R",
      type: "object",
      properties: { a: { $ref: "#/$defs/A" }, c: { $ref: "#/$defs/C" } },
      $defs: { A: { $ref: "#/$defs/B" }, B: { type: "string", maxLength: 3 }, C: { $ref: "#/$defs/C" } },
    });
    expect(field(doc.entities[0], "a").constraints).toEqual([{ type: "maxLength", value: 3 }]);
  });
});

describe("#4 a union of unresolved external refs is flagged", () => {
  it("is low confidence with a warning naming the refs", () => {
    const doc = parse({
      title: "R",
      type: "object",
      properties: { p: { oneOf: [{ $ref: "a.json" }, { $ref: "b.json" }] } },
    });
    const p = field(doc.entities[0], "p");
    expect(p.type).toBe("union");
    expect(p.confidence).toBe("low");
    expect(doc.warnings.join("\n")).toMatch(/R_p_Union.*a\.json.*b\.json/i);
  });

  it("a union of in-document entities stays medium and silent", () => {
    const doc = parse({
      title: "R",
      type: "object",
      properties: { p: { oneOf: [{ $ref: "#/$defs/A" }, { $ref: "#/$defs/B" }] } },
      $defs: { A: { type: "object", properties: { x: { type: "string" } } }, B: { type: "object", properties: { y: { type: "string" } } } },
    });
    expect(field(doc.entities[0], "p").confidence).toBe("medium");
    expect(doc.warnings.join("\n")).not.toMatch(/union/i);
  });

  it("a shared $defs union with an external member is flagged where it is used", () => {
    const doc = parse({
      title: "R",
      type: "object",
      properties: { p: { $ref: "#/$defs/U" } },
      $defs: { U: { oneOf: [{ $ref: "a.json" }, { $ref: "b.json" }] } },
    });
    expect(field(doc.entities[0], "p").confidence).toBe("low");
    expect(doc.warnings.join("\n")).toMatch(/union.*U.*a\.json/i);
  });
});

describe("#3 entity-level oneOf / anyOf is reported, and allOf members still apply", () => {
  it("lists oneOf as an ignored keyword, preserves it and warns", () => {
    const oneOf = [{ required: ["a"] }, { required: ["b"] }];
    const doc = parse({ title: "R", type: "object", properties: { a: { type: "string" } }, oneOf });
    const e = doc.entities[0];
    expect(e.ignoredKeywords).toContain("oneOf");
    expect(e.extensions).toMatchObject({ oneOf });
    expect(doc.warnings.join("\n")).toMatch(/Entity `R`.*`oneOf`/);
  });

  it("anyOf and not are reported the same way", () => {
    const doc = parse({ title: "R", type: "object", properties: { a: { type: "string" } }, anyOf: [{ required: ["a"] }], not: { required: ["z"] } });
    expect(doc.entities[0].ignoredKeywords).toEqual(expect.arrayContaining(["anyOf", "not"]));
    expect(doc.entities[0].extensions).toMatchObject({ anyOf: [{ required: ["a"] }], not: { required: ["z"] } });
  });

  it("keeps the allOf base and members next to an entity-level oneOf", () => {
    const doc = parse({
      title: "R",
      allOf: [{ $ref: "#/$defs/Base" }, { properties: { extra: { type: "string" } }, required: ["extra"] }],
      oneOf: [{ required: ["extra"] }],
      properties: { a: { type: "string" } },
      $defs: { Base: { type: "object", properties: { id: { type: "string" } } } },
    });
    const r = doc.entities.find((e) => e.name === "R")!;
    expect(r.extends).toBe("Base");
    expect(r.fields.map((f) => f.name).sort()).toEqual(["a", "extra"]);
    expect(r.ignoredKeywords).toContain("oneOf");
  });

  it("a $defs entity with properties and oneOf is reported the same way", () => {
    const doc = parse({
      title: "R",
      type: "object",
      properties: { x: { $ref: "#/$defs/E" } },
      $defs: { E: { type: "object", properties: { a: { type: "string" } }, oneOf: [{ required: ["a"] }] } },
    });
    expect(doc.entities.find((e) => e.name === "E")!.ignoredKeywords).toContain("oneOf");
  });
});
