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
