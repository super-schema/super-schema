/**
 * The anti-goal of the vendor-extension design: "silently dropping any non-keyword key, ever". A table of every standard JSON Schema
 * 2020-12 keyword (plus the legacy ones, a vendor `x-` key and an unknown key) at every site a schema node can sit at: the root,
 * a property, `items`, an `allOf` member (of a property and of an entity), a `oneOf` / `anyOf` member, a `$defs` entry (entity, enum, inline,
 * union) and an inline enum. Each key must be accounted for in the import result: interpreted (it changed the result in the way the keyword
 * means), kept (its key or its value is in an `extensions` bag, under its own name or `x-<site>-<keyword>`), or reported (listed in
 * `ignoredKeywords`, named by a warning). A key that is nowhere is a silent drop and fails here.
 *
 * Keys that DEFINE the site (a property's `type`, an `items` schema's `$ref`, ...) are the structure the table is built on, not data: they are
 * skipped per site (`STRUCTURAL`).
 */
import { describe, it, expect } from "vitest";
import { parseJsonSchemaDocument } from "@/lib/importers/jsonschema.importer";

const TOKEN = "TOK-7f3a9";
const NUM = 4242;

/** Every keyword of the 2020-12 vocabularies, the legacy ones, a vendor key and an unknown key, with a value that fits it and carries the token. */
const KEYWORDS: Record<string, unknown> = {
  // core
  $schema: `https://example.test/${TOKEN}`,
  $id: `https://example.test/${TOKEN}.json`,
  $ref: `#/$defs/${TOKEN}`,
  $anchor: TOKEN,
  $dynamicRef: `#${TOKEN}`,
  $dynamicAnchor: TOKEN,
  $vocabulary: { [`https://example.test/${TOKEN}`]: true },
  $comment: TOKEN,
  $defs: { [TOKEN]: { type: "string" } },
  definitions: { [TOKEN]: { type: "string" } },
  // applicator
  prefixItems: [{ type: "string", description: TOKEN }],
  items: { type: "string", description: TOKEN },
  contains: { type: "string", description: TOKEN },
  additionalProperties: { type: "string", description: TOKEN },
  properties: { [TOKEN]: { type: "string" } },
  patternProperties: { "^x": { type: "string", description: TOKEN } },
  dependentSchemas: { [TOKEN]: { type: "object" } },
  propertyNames: { pattern: TOKEN },
  if: { properties: { [TOKEN]: { const: 1 } } },
  then: { required: [TOKEN] },
  else: { required: [`${TOKEN}-else`] },
  allOf: [{ description: TOKEN }],
  anyOf: [{ description: TOKEN }],
  oneOf: [{ description: TOKEN }],
  not: { description: TOKEN },
  // unevaluated
  unevaluatedItems: { description: TOKEN },
  unevaluatedProperties: { description: TOKEN },
  // validation
  type: "string",
  const: TOKEN,
  enum: [TOKEN, `${TOKEN}-2`],
  multipleOf: NUM,
  maximum: NUM,
  exclusiveMaximum: NUM,
  minimum: -NUM,
  exclusiveMinimum: -NUM,
  maxLength: NUM,
  minLength: NUM,
  pattern: `^${TOKEN}$`,
  maxItems: NUM,
  minItems: NUM,
  uniqueItems: true,
  maxContains: NUM,
  minContains: NUM,
  maxProperties: NUM,
  minProperties: NUM,
  required: [TOKEN],
  dependentRequired: { [TOKEN]: [`${TOKEN}-b`] },
  // format, content
  format: `fmt-${TOKEN}`,
  contentEncoding: TOKEN,
  contentMediaType: `text/${TOKEN}`,
  contentSchema: { description: TOKEN },
  // annotations
  title: TOKEN,
  description: TOKEN,
  default: TOKEN,
  deprecated: true,
  readOnly: true,
  writeOnly: true,
  examples: [TOKEN],
  // legacy
  dependencies: { [TOKEN]: [`${TOKEN}-b`] },
  additionalItems: { description: TOKEN },
  example: TOKEN,
  $recursiveRef: "#",
  $recursiveAnchor: true,
  nullable: true,
  discriminator: { propertyName: TOKEN },
  // vendor and unknown
  "x-vendor": { [TOKEN]: 1 },
  "x-tags-like": [TOKEN],
  "unknown-keyword": TOKEN,
};

type Doc = Record<string, unknown>;
const entityDef = { type: "object", properties: { z: { type: "string" } } };

/** A document with the keyword `k` at the site. */
const SITES: Record<string, (k: string, v: unknown) => Doc> = {
  root: (k, v) => ({ title: "R", type: "object", properties: { a: { type: "string" } }, [k]: v }),
  property: (k, v) => ({ title: "R", type: "object", properties: { a: { type: "string", [k]: v } } }),
  items: (k, v) => ({ title: "R", type: "object", properties: { a: { type: "array", items: { type: "string", [k]: v } } } }),
  "allOf member of a property": (k, v) => ({ title: "R", type: "object", properties: { a: { allOf: [{ type: "string" }, { [k]: v }] } } }),
  "allOf member of an entity": (k, v) => ({ title: "R", type: "object", allOf: [{ properties: { a: { type: "string" } } }, { [k]: v }] }),
  "oneOf member": (k, v) => ({ title: "R", type: "object", properties: { a: { oneOf: [{ type: "string", [k]: v }, { type: "integer" }] } } }),
  "anyOf null wrapper": (k, v) => ({ title: "R", type: "object", properties: { a: { anyOf: [{ type: "string", [k]: v }, { type: "null" }] } } }),
  "$defs entity": (k, v) => ({ title: "R", type: "object", properties: { a: { $ref: "#/$defs/E" } }, $defs: { E: { ...entityDef, [k]: v } } }),
  "$defs enum": (k, v) => ({ title: "R", type: "object", properties: { a: { $ref: "#/$defs/S" } }, $defs: { S: { type: "string", enum: ["A", "B"], [k]: v } } }),
  "$defs inline": (k, v) => ({ title: "R", type: "object", properties: { a: { $ref: "#/$defs/S" } }, $defs: { S: { type: "string", [k]: v } } }),
  "$defs union": (k, v) => ({
    title: "R", type: "object", properties: { a: { $ref: "#/$defs/U" } },
    $defs: { A: entityDef, B: entityDef, U: { oneOf: [{ $ref: "#/$defs/A" }, { $ref: "#/$defs/B" }], [k]: v } },
  }),
  "inline enum": (k, v) => ({ title: "R", type: "object", properties: { a: { type: "string", enum: ["A", "B"], [k]: v } } }),
};

/**
 * Keys that build the site itself (not annotations on it), per site. An entity site is defined by its `properties` / `required` and holds the
 * definitions; every other site is a type whose own `type`, `items`, combinators and `enum` / `const` are what it IS. Everything else must be accounted for.
 */
const TYPE_DEFINING = ["type", "$ref", "items", "oneOf", "anyOf", "allOf", "enum", "const"];
const ENTITY_DEFINING = [...TYPE_DEFINING, "properties", "required"];
/** The document's own `$defs` / `definitions` (the root's) are the definitions themselves: structural there, not below it. */
const ROOT_DEFINING = [...ENTITY_DEFINING, "$defs", "definitions"];
/** A definition's `$id` is the identity of the embedded resource: `$ref`s are resolved by it (read, not carried). */
const STRUCTURAL: Record<string, string[]> = {
  root: ROOT_DEFINING,
  property: TYPE_DEFINING,
  items: TYPE_DEFINING,
  "allOf member of a property": TYPE_DEFINING,
  "allOf member of an entity": ENTITY_DEFINING,
  "oneOf member": TYPE_DEFINING,
  "anyOf null wrapper": TYPE_DEFINING,
  "$defs entity": [...ENTITY_DEFINING, "$id"],
  "$defs enum": [...TYPE_DEFINING, "$id"],
  "$defs inline": [...TYPE_DEFINING, "$id"],
  "$defs union": [...TYPE_DEFINING, "$id"],
  "inline enum": TYPE_DEFINING,
};

function importResult(doc: Doc): { text: string; error?: string } {
  const r = parseJsonSchemaDocument(JSON.stringify(doc));
  if (!r.success) return { text: "", error: r.error.message };
  const data = { ...r.data, entities: r.data.entities.map((e) => ({ ...e, originalContent: undefined })) };
  return { text: JSON.stringify(data) };
}

/** Whether the import result accounts for `key`: its name (as a key, a listed keyword, a warning), a warning that says where it was found, or its value. */
function accounted(text: string, key: string, value: unknown): boolean {
  if (text.includes(`"${key}"`) || text.includes(`\`${key}\``) || text.includes(`${key} found on`)) return true;
  const probe = typeof value === "number" ? String(value).replace("-", "") : TOKEN;
  return text.includes(probe);
}

describe("no keyword is silently dropped, at any site", () => {
  for (const [site, build] of Object.entries(SITES)) {
    it(site, () => {
      const unaccounted: string[] = [];
      for (const [key, value] of Object.entries(KEYWORDS)) {
        if (STRUCTURAL[site].includes(key)) continue;
        const { text, error } = importResult(build(key, value));
        if (error !== undefined) {
          unaccounted.push(`${key}: the import failed (${error})`);
          continue;
        }
        if (!accounted(text, key, value)) unaccounted.push(key);
      }
      expect(unaccounted).toEqual([]);
    });
  }

  it("an inline object nested past the literal depth is reported (it could not be written back), not kept in silence", () => {
    let nested: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 40; i++) nested = { type: "object", properties: { next: nested } };
    const r = parseJsonSchemaDocument(JSON.stringify({ title: "R", type: "object", properties: { deep: nested } }));
    if (!r.success) throw new Error(r.error.message);
    expect(r.data.entities[0].fields[0].extensions).toBeUndefined();
    expect(r.data.warnings).toContain("properties of R.deep nests deeper than 64 levels and was not kept");
  });

  it("the control: a document with nothing special accounts for nothing (the check can fail)", () => {
    const { text } = importResult(SITES.property("noop", undefined));
    expect(accounted(text, "maxLength", NUM)).toBe(false);
    expect(accounted(text, "x-vendor", { [TOKEN]: 1 })).toBe(false);
  });
});
