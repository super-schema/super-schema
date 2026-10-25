/**
 * What a `$defs` entry carries besides its kind-defining keywords (an enum's `x-enum-varnames`, `x-enum-descriptions`, `deprecated`; a shared
 * union's vendor keys). A shared enum / union row has no place of its own for them, so they are kept on `ParsedEnum` AND on every field that
 * uses the definition (as an inline definition's already are), where they persist and are re-emitted; one warning says so.
 */
import { describe, it, expect } from "vitest";
import { parseJsonSchemaDocument } from "@/lib/importers/jsonschema.importer";

function importDoc(schema: unknown) {
  const r = parseJsonSchemaDocument(JSON.stringify(schema));
  if (!r.success) throw new Error(r.error.message);
  return r.data;
}
const STATUS = {
  type: "string", enum: ["A", "B"], description: "a status", deprecated: true, title: "St",
  "x-enum-varnames": ["Alpha", "Beta"], "x-enum-descriptions": ["first", "second"], default: "A",
};
const doc = importDoc({
  title: "R", type: "object", required: ["s", "many"],
  properties: { s: { $ref: "#/$defs/Status" }, many: { type: "array", items: { $ref: "#/$defs/Status" } }, plain: { type: "string" } },
  $defs: { Status: STATUS },
});
const fieldOf = (name: string) => doc.entities[0].fields.find((f) => f.name === name)!;

describe("an enum definition's annotations", () => {
  it("are kept on the parsed enum (extensions, deprecated, ignored keywords), its name and values as before", () => {
    const status = doc.enums[0];
    expect(status).toMatchObject({ name: "Status", values: ["A", "B"], description: "a status", deprecated: true });
    expect(status.extensions).toEqual({
      title: "St", "x-enum-varnames": ["Alpha", "Beta"], "x-enum-descriptions": ["first", "second"], default: "A",
    });
    expect(status.ignoredKeywords).toEqual(["title", "default"]);
  });

  it("are kept on the field that $refs the enum, and on the array whose items do", () => {
    for (const name of ["s", "many"]) {
      expect(fieldOf(name).extensions, name).toMatchObject({ "x-enum-varnames": ["Alpha", "Beta"], "x-enum-descriptions": ["first", "second"], default: "A" });
    }
    // the field itself is deprecated; for an array it is the ITEMS that are (an element-level flag: kept as x-items-deprecated)
    expect(fieldOf("s").deprecated).toBe(true);
    expect(fieldOf("many").extensions).toMatchObject({ "x-items-deprecated": true });
    expect(fieldOf("plain").extensions).toBeUndefined();
    expect(fieldOf("s")).toMatchObject({ type: "enum", enumName: "Status" });
  });

  it("are reported once, naming the keys", () => {
    const said = doc.warnings.filter((w) => w.startsWith("Enum `Status`"));
    expect(said).toEqual([
      "Enum `Status`: deprecated, title, x-enum-varnames, x-enum-descriptions, default are kept on every field that uses it (a shared enum has no place of its own for them)",
    ]);
  });

  it("an enum with nothing but its values is unchanged: no extensions, no warning", () => {
    const d = importDoc({
      title: "R", type: "object", properties: { s: { $ref: "#/$defs/Status" } },
      $defs: { Status: { type: "string", enum: ["A", "B"], description: "d" } },
    });
    expect(d.enums[0].extensions).toBeUndefined();
    expect(d.entities[0].fields[0].extensions).toBeUndefined();
    expect(d.warnings.filter((w) => w.startsWith("Enum"))).toEqual([]);
  });
});

describe("a shared union definition's annotations", () => {
  it("vendor keys of the definition reach the fields that use it", () => {
    const d = importDoc({
      title: "R", type: "object", properties: { pet: { $ref: "#/$defs/Pet" } },
      $defs: {
        Cat: { type: "object", properties: { lives: { type: "integer" } } },
        Dog: { type: "object", properties: { bark: { type: "string" } } },
        Pet: { description: "a pet", "x-pet-kind": "animal", oneOf: [{ $ref: "#/$defs/Cat" }, { $ref: "#/$defs/Dog" }] },
      },
    });
    expect(d.unions?.[0]).toMatchObject({ name: "Pet", description: "a pet" });
    expect(d.entities[0].fields[0]).toMatchObject({ type: "union", unionName: "Pet" });
    expect(d.entities[0].fields[0].extensions).toEqual({ "x-pet-kind": "animal" });
  });
});
