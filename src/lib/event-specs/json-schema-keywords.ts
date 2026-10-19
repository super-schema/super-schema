import { setOwn } from "./own-property";
import type { JsonObject, JsonValue } from "./types";

/**
 * Where JSON Schema keeps subschemas. Shared by every pure-layer walker that must
 * tell a *schema position* from data (down-converter, `$ref` rebasing, `$ref`
 * fragment rewriting) so they all agree on what is a keyword and what is a name.
 *
 * - map keywords: `{ <name>: <subschema> }` — the names are free text (a property may
 *   be called `default`, `enum`, `const`, `$ref`, `$defs` …), only the VALUES are schemas;
 * - array keywords: `[<subschema>, …]`;
 * - single-schema keywords: the value is one subschema;
 * - special shapes handled by the walkers themselves: `items` (a schema, or the draft-07
 *   array form) and `dependencies` (name → subschema | string[]).
 *
 * Everything else (`const`, `enum`, `default`, `examples`, unknown / `x-*` keywords)
 * is data and is copied verbatim.
 */
export const SCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);

export const SCHEMA_ARRAY_KEYWORDS: ReadonlySet<string> = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);

/** The keywords whose value is data a consumer copies as it is (a sample is taken from them), not a schema. */
export const DATA_KEYWORDS: ReadonlySet<string> = new Set(["const", "enum", "default", "example", "examples"]);

export const SINGLE_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  "additionalProperties",
  "additionalItems",
  "unevaluatedProperties",
  "unevaluatedItems",
  "contains",
  "propertyNames",
  "if",
  "then",
  "else",
  "not",
  "contentSchema",
]);

const isObject = (v: JsonValue | undefined): v is JsonObject =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Copy `schema`, replacing the value of every `$ref` that sits in a schema position
 * with `mapRef(value)`. Data keywords, unknown keywords and map-keyword NAMES are
 * never interpreted, so a property called `default` or `$ref` is walked like any other
 * property. The input is never mutated.
 */
export function mapSchemaRefs(schema: JsonObject, mapRef: (ref: string) => string): JsonObject {
  const subschema = (value: JsonValue): JsonValue => (isObject(value) ? node(value) : structuredClone(value));
  const schemaArray = (value: JsonValue): JsonValue =>
    Array.isArray(value) ? value.map(subschema) : structuredClone(value);
  const schemaMap = (value: JsonValue): JsonValue => {
    if (!isObject(value)) return structuredClone(value);
    const out: JsonObject = {};
    for (const [name, sub] of Object.entries(value)) setOwn(out, name, subschema(sub));
    return out;
  };
  const dependencies = (value: JsonValue): JsonValue => {
    if (!isObject(value)) return structuredClone(value);
    const out: JsonObject = {};
    for (const [name, dep] of Object.entries(value)) setOwn(out, name, Array.isArray(dep) ? structuredClone(dep) : subschema(dep));
    return out;
  };

  function node(current: JsonObject): JsonObject {
    const out: JsonObject = {};
    for (const [key, value] of Object.entries(current)) {
      if (key === "$ref" && typeof value === "string") setOwn(out, key, mapRef(value));
      else if (SCHEMA_MAP_KEYWORDS.has(key)) setOwn(out, key, schemaMap(value));
      else if (SCHEMA_ARRAY_KEYWORDS.has(key)) setOwn(out, key, schemaArray(value));
      else if (key === "items") setOwn(out, key, Array.isArray(value) ? schemaArray(value) : subschema(value));
      else if (key === "dependencies") setOwn(out, key, dependencies(value));
      else if (SINGLE_SCHEMA_KEYWORDS.has(key)) setOwn(out, key, subschema(value));
      else setOwn(out, key, structuredClone(value));
    }
    return out;
  }

  return node(schema);
}
