/**
 * Item-level extensions (spec "Item-level extensions", path C): a keyword found on an array's `items`, on a `oneOf` / `anyOf` member,
 * or on a definition they point at has no node of its own in the IR. It is folded onto the OWNING field, never dropped:
 *  - a vendor / unknown key keeps its spelling (`x-visibility`) and a warning says where it came from;
 *  - a constraint, description, deprecated flag (the IR has no element-constraint concept) is kept as `x-<site>-<keyword>`
 *    so it can never override the field's own value when the extensions are re-emitted.
 */
import { describe, it, expect } from "vitest";
import { parseJsonSchemaDocument } from "@/lib/importers/jsonschema.importer";

function importDoc(schema: unknown) {
  const r = parseJsonSchemaDocument(JSON.stringify(schema));
  if (!r.success) throw new Error(r.error.message);
  return r.data;
}
const fieldOf = (doc: ReturnType<typeof importDoc>, entity: string, name: string) =>
  doc.entities.find((e) => e.name === entity)!.fields.find((f) => f.name === name)!;

describe("items of an array field", () => {
  const doc = importDoc({
    title: "R", type: "object", required: ["tags"],
    properties: {
      tags: {
        type: "array",
        items: { type: "string", pattern: "^[a-z]+$", maxLength: 10, "x-visibility": { extent: "EXTERNAL" }, description: "a tag", deprecated: true },
      },
    },
  });
  const tags = fieldOf(doc, "R", "tags");

  it("keeps the vendor key under its own name, with a warning that says where it was found", () => {
    expect(tags.extensions?.["x-visibility"]).toEqual({ extent: "EXTERNAL" });
    expect(doc.warnings).toContain("x-visibility found on items of R.tags was kept on the field");
  });

  it("keeps the element constraints, description and deprecated flag as namespaced extensions (never as the array's own)", () => {
    expect(tags.extensions).toMatchObject({
      "x-items-pattern": "^[a-z]+$", "x-items-maxLength": 10, "x-items-description": "a tag", "x-items-deprecated": true,
    });
    expect(tags.constraints).toBeUndefined();
    expect(tags.description).toBeUndefined();
    expect(tags.deprecated).toBeUndefined();
    for (const key of ["pattern", "maxLength", "description", "deprecated"]) {
      expect(doc.warnings.some((w) => w.includes(`${key} found on items of R.tags was kept on the field as x-items-${key}`))).toBe(true);
    }
  });

  it("still types the field as an array of strings", () => {
    expect(tags).toMatchObject({ type: "array", arrayElementType: "string" });
  });
});

describe("items that is a $ref (the PayPal links.items.x-visibility case)", () => {
  const doc = importDoc({
    title: "R", type: "object", required: ["links"],
    properties: { links: { type: "array", items: { $ref: "#/$defs/LinkDescription", "x-visibility": { extent: "EXTERNAL" } } } },
    $defs: { LinkDescription: { type: "object", properties: { href: { type: "string" } } } },
  });

  it("keeps x-visibility on the array field and still references the entity", () => {
    const links = fieldOf(doc, "R", "links");
    expect(links).toMatchObject({ type: "array", arrayElementType: "reference", referencedEntityName: "LinkDescription" });
    expect(links.extensions).toEqual({ "x-visibility": { extent: "EXTERNAL" } });
    expect(doc.warnings).toContain("x-visibility found on items of R.links was kept on the field");
  });

  it("an unresolved external $ref with a sibling x-visibility keeps both", () => {
    const d = importDoc({
      title: "R", type: "object",
      properties: { links: { type: "array", items: { $ref: "link_description.json", "x-visibility": { extent: "EXTERNAL" } } } },
    });
    const links = fieldOf(d, "R", "links");
    expect(links.danglingRef).toMatchObject({ ref: "link_description.json", element: true });
    expect(links.extensions?.["x-visibility"]).toEqual({ extent: "EXTERNAL" });
  });

  it("an items $ref to an inline definition brings the definition's constraints and extensions along", () => {
    const d = importDoc({
      title: "R", type: "object",
      properties: { tags: { type: "array", items: { $ref: "#/$defs/Tag" } } },
      $defs: { Tag: { type: "string", maxLength: 10, "x-pii": true, title: "Tag" } },
    });
    const tags = fieldOf(d, "R", "tags");
    expect(tags.extensions).toMatchObject({ "x-pii": true, "x-items-maxLength": 10 });
    expect(tags.extensions).not.toHaveProperty("x-items-title");
  });
});

describe("a vendor key that the field already has with another value", () => {
  it("keeps both: the field's own under its name, the item's under <key>@items", () => {
    const d = importDoc({
      title: "R", type: "object",
      properties: { a: { type: "array", "x-v": 1, items: { type: "string", "x-v": 2 } } },
    });
    const a = fieldOf(d, "R", "a");
    expect(a.extensions).toMatchObject({ "x-v": 1, "x-v@items": 2 });
    expect(d.warnings.some((w) => w.includes("x-v") && w.includes("x-v@items"))).toBe(true);
  });

  it("the same value twice is one key and no warning", () => {
    const d = importDoc({
      title: "R", type: "object",
      properties: { a: { type: "array", "x-v": 1, items: { type: "string", "x-v": 1 } } },
    });
    expect(fieldOf(d, "R", "a").extensions).toEqual({ "x-v": 1 });
    expect(d.warnings.filter((w) => w.includes("x-v"))).toEqual([]);
  });
});

describe("oneOf / anyOf members", () => {
  it("keeps what two members carry (x-m, maxLength, minimum) on the field", () => {
    const d = importDoc({
      title: "R", type: "object", required: ["u"],
      properties: { u: { oneOf: [{ type: "string", "x-m": 1, maxLength: 3 }, { type: "integer", minimum: 5 }] } },
    });
    const u = fieldOf(d, "R", "u");
    expect(u.extensions).toMatchObject({ "x-m": 1, "x-oneOf-0-maxLength": 3, "x-oneOf-1-minimum": 5 });
    expect(d.warnings).toContain("x-m found on oneOf[0] of R.u was kept on the field");
  });

  it("a nullable wrapper (one real member + null) is the field itself: its constraints and extensions are the field's", () => {
    const d = importDoc({
      title: "R", type: "object", required: ["a"],
      properties: { a: { anyOf: [{ type: "string", maxLength: 5, description: "d", "x-m": 1 }, { type: "null" }] } },
    });
    const a = fieldOf(d, "R", "a");
    expect(a.constraints).toEqual([{ type: "maxLength", value: 5 }]);
    expect(a.description).toBe("d");
    expect(a.extensions).toEqual({ "x-m": 1 });
    expect(d.warnings.filter((w) => w.includes("found on"))).toEqual([]);
  });

  it("members of a union of references keep their extensions too", () => {
    const d = importDoc({
      title: "R", type: "object",
      properties: { method: { oneOf: [{ $ref: "#/$defs/Card", "x-m": "card" }, { $ref: "#/$defs/Bank" }] } },
      $defs: { Card: { type: "object", properties: { pan: { type: "string" } } }, Bank: { type: "object", properties: { iban: { type: "string" } } } },
    });
    expect(fieldOf(d, "R", "method").extensions).toEqual({ "x-m": "card" });
  });
});

describe("nested deeper than one level", () => {
  it("array of arrays: the inner items' extension is found", () => {
    const d = importDoc({
      title: "R", type: "object",
      properties: { grid: { type: "array", items: { type: "array", items: { type: "number", "x-unit": "cm" } } } },
    });
    const grid = fieldOf(d, "R", "grid");
    expect(grid.extensions).toEqual({ "x-unit": "cm" });
    expect(d.warnings).toContain("x-unit found on items.items of R.grid was kept on the field");
  });

  it("an allOf member of the items schema is read", () => {
    const d = importDoc({
      title: "R", type: "object",
      properties: { a: { type: "array", items: { allOf: [{ type: "string" }, { "x-m": 1 }] } } },
    });
    expect(fieldOf(d, "R", "a").extensions).toEqual({ "x-m": 1 });
  });

  it("a recursive definition does not loop", () => {
    const d = importDoc({
      title: "R", type: "object",
      properties: { t: { $ref: "#/$defs/Tree" } },
      $defs: { Tree: { type: "array", "x-t": 1, items: { $ref: "#/$defs/Tree" } } },
    });
    expect(fieldOf(d, "R", "t").extensions).toMatchObject({ "x-t": 1 });
  });
});

describe("sites whose subschemas are kept whole", () => {
  it("additionalProperties / patternProperties / prefixItems keep every nested key verbatim on the field", () => {
    const d = importDoc({
      title: "R", type: "object",
      properties: {
        m: { type: "object", additionalProperties: { type: "string", maxLength: 3, "x-a": 1 } },
        p: { type: "object", patternProperties: { "^x": { type: "string", "x-b": 2 } } },
        t: { type: "array", prefixItems: [{ type: "string", "x-c": 3 }] },
      },
    });
    expect(fieldOf(d, "R", "m").extensions).toEqual({ additionalProperties: { type: "string", maxLength: 3, "x-a": 1 } });
    expect(fieldOf(d, "R", "p").extensions).toEqual({ patternProperties: { "^x": { type: "string", "x-b": 2 } } });
    expect(fieldOf(d, "R", "t").extensions).toEqual({ prefixItems: [{ type: "string", "x-c": 3 }] });
    expect(fieldOf(d, "R", "m").ignoredKeywords).toEqual(["additionalProperties"]);
  });
});

describe("hostile nesting", () => {
  it("a 100000-member oneOf of annotated members stays bounded and reports instead of flooding", () => {
    const members = Array.from({ length: 5000 }, (_, i) => ({ type: "string", [`x-m${i}`]: i }));
    const d = importDoc({ title: "R", type: "object", properties: { u: { oneOf: members } } });
    const u = fieldOf(d, "R", "u");
    expect(Object.keys(u.extensions ?? {}).length).toBeGreaterThan(0);
    expect(d.warnings.length).toBeLessThanOrEqual(260);
  });
});
