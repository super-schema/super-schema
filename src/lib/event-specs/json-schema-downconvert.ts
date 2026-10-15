import type { JsonObject, JsonValue } from "./types";
import { escapePointerSegment, unescapePointerSegment } from "./json-pointer";
import { SCHEMA_ARRAY_KEYWORDS, SCHEMA_MAP_KEYWORDS, SINGLE_SCHEMA_KEYWORDS } from "./json-schema-keywords";
import { setOwn } from "./own-property";

/**
 * Spec §7.3 / Story 16.2 pure core: down-convert a JSON Schema 2020-12 document
 * to draft-07 for channels whose format profile asks for it.
 *
 * - `$defs` → `definitions`, and the `$defs` KEYWORD segments of every `$ref` fragment → `definitions`
 *   (a property or definition that happens to be called `$defs` is a name and is left alone)
 * - `prefixItems` → `items` (array form); a sibling 2020-12 `items` → `additionalItems`
 * - `dependentRequired` / `dependentSchemas` → `dependencies`
 * - `$ref` with validating siblings (ignored by draft-07) → `allOf: [{ $ref }, { …siblings }]`, with a warning
 * - keywords with no draft-07 equivalent are dropped, each with a warning
 * - `unevaluatedProperties` on a plain object schema (no `allOf` / `anyOf` / `oneOf` / `$ref` / `if` … siblings, no
 *   `additionalProperties`) is exactly `additionalProperties` and is converted, so a TypeSpec `Record<T>` keeps its
 *   value type; with composition siblings it cannot be expressed and is dropped with a warning
 *
 * Only schema positions are walked; data keywords (`const`, `enum`, `default`,
 * `examples`) and unknown keywords are copied verbatim. The input is never mutated.
 */

export const DRAFT_07_META_SCHEMA = "http://json-schema.org/draft-07/schema#";

export const UNSUPPORTED_IN_DRAFT_07: readonly string[] = [
  "$anchor",
  "$dynamicAnchor",
  "$dynamicRef",
  "$recursiveAnchor",
  "$recursiveRef",
  "$vocabulary",
  "unevaluatedProperties",
  "unevaluatedItems",
  "minContains",
  "maxContains",
  "contentSchema",
];

/** `dropped`: a keyword (or definition) was lost; `rewritten`: the schema was restructured, nothing was lost. */
export type DownConvertWarning = { pointer: string; keyword: string; message: string; kind: "dropped" | "rewritten" };
export type DownConvertResult = { schema: JsonObject; warnings: DownConvertWarning[] };

const DROPPED = new Set(UNSUPPORTED_IN_DRAFT_07);

/** Siblings of a wrapped `$ref` that stay on the outer object: annotations, and `definitions` (pointers target it). */
const KEEP_OUTSIDE_REF_WRAPPER = new Set([
  "$schema",
  "$id",
  "$comment",
  "definitions",
  "title",
  "description",
  "default",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
]);

const isObject = (v: JsonValue | undefined): v is JsonObject =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function downConvertToDraft07(schema: JsonObject): DownConvertResult {
  const warnings: DownConvertWarning[] = [];
  return { schema: convertSchema(schema, "", warnings), warnings };
}

const decodeSegment = (raw: string): string => {
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // keep the raw segment when it is not valid percent-encoding
  }
  return unescapePointerSegment(decoded);
};

const ARRAY_INDEX = /^(0|[1-9][0-9]*)$/;

/**
 * Rewrite the `$defs` KEYWORD segments in the fragment of a `$ref`
 * (`a.json#/$defs/X` → `a.json#/definitions/X`). The fragment is a path through a
 * schema, so the walk tracks what each segment is: after `properties` / `$defs` /
 * `definitions` / … the next segment is a free-text NAME (never rewritten), after
 * `allOf` / `prefixItems` … an index, after `not` / `items` / … a keyword again. Once the
 * path leaves schema space (`default`, `const`, unknown keywords) nothing is rewritten.
 * Percent-encoded keywords (`%24defs`) are recognised.
 */
export function rewriteDefsRef(ref: string): string {
  const hash = ref.indexOf("#");
  if (hash < 0) return ref;
  const fragment = ref.slice(hash + 1);
  if (!fragment.startsWith("/")) return ref;

  let position: "schema" | "name" | "index" | "opaque" = "schema";
  const segments = fragment
    .slice(1)
    .split("/")
    .map((raw) => {
      if (position === "name" || position === "index") {
        position = "schema";
        return raw;
      }
      if (position === "opaque") return raw;
      const keyword = decodeSegment(raw);
      if (ARRAY_INDEX.test(keyword)) return raw; // index into the draft-07 array form of `items`
      if (keyword === "$defs") {
        position = "name";
        return "definitions";
      }
      if (SCHEMA_MAP_KEYWORDS.has(keyword) || keyword === "dependencies") position = "name";
      else if (SCHEMA_ARRAY_KEYWORDS.has(keyword)) position = "index";
      else if (keyword === "items" || SINGLE_SCHEMA_KEYWORDS.has(keyword)) position = "schema";
      else position = "opaque";
      return raw;
    });
  return `${ref.slice(0, hash)}#/${segments.join("/")}`;
}

function at(pointer: string, key: string): string {
  return `${pointer}/${escapePointerSegment(key)}`;
}

/** Booleans are valid schemas (`true` / `false`); anything else non-object is copied. */
function convertSubschema(value: JsonValue, pointer: string, warnings: DownConvertWarning[]): JsonValue {
  return isObject(value) ? convertSchema(value, pointer, warnings) : structuredClone(value);
}

function convertSchemaArray(value: JsonValue, pointer: string, warnings: DownConvertWarning[]): JsonValue {
  return Array.isArray(value)
    ? value.map((v, i) => convertSubschema(v, `${pointer}/${i}`, warnings))
    : structuredClone(value);
}

function convertSchemaMap(value: JsonValue, pointer: string, warnings: DownConvertWarning[]): JsonValue {
  if (!isObject(value)) return structuredClone(value);
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(value)) setOwn(out, k, convertSubschema(v, at(pointer, k), warnings));
  return out;
}

function mergeDefinitions(out: JsonObject, incoming: JsonValue, pointer: string, warnings: DownConvertWarning[]): void {
  if (!isObject(incoming)) return;
  const target: JsonObject = isObject(out.definitions) ? out.definitions : {};
  for (const [name, schema] of Object.entries(incoming)) {
    if (Object.prototype.hasOwnProperty.call(target, name)) {
      warnings.push({
        pointer: at(pointer, name),
        keyword: "definitions",
        kind: "dropped",
        message: `definition "${name}" exists in both $defs and definitions; the first one was kept`,
      });
      continue;
    }
    setOwn(target, name, schema);
  }
  out.definitions = target;
}

function combineDependency(existing: JsonValue, incoming: JsonValue): JsonValue {
  if (Array.isArray(existing) && Array.isArray(incoming)) {
    return [...existing, ...incoming.filter((x) => !existing.includes(x))];
  }
  const asSchema = (v: JsonValue): JsonValue => (Array.isArray(v) ? { required: v } : v);
  return { allOf: [asSchema(existing), asSchema(incoming)] };
}

function mergeDependencies(out: JsonObject, incoming: JsonValue): void {
  if (!isObject(incoming)) return;
  const target: JsonObject = isObject(out.dependencies) ? out.dependencies : {};
  for (const [prop, value] of Object.entries(incoming)) {
    setOwn(
      target,
      prop,
      Object.prototype.hasOwnProperty.call(target, prop) ? combineDependency(target[prop], value) : value,
    );
  }
  out.dependencies = target;
}

/**
 * draft-07 ignores every sibling of `$ref`; 2020-12 applies them. Move the validating
 * siblings next to the `$ref` inside `allOf` so they keep their meaning. Annotations and
 * `definitions` stay on the outer object. Nothing is wrapped when no validating sibling is left.
 */
function wrapRefSiblings(out: JsonObject, pointer: string, warnings: DownConvertWarning[]): JsonObject {
  if (typeof out.$ref !== "string") return out;
  const outer: JsonObject = {};
  const siblings: JsonObject = {};
  for (const [key, value] of Object.entries(out)) {
    if (key === "$ref") continue;
    setOwn(KEEP_OUTSIDE_REF_WRAPPER.has(key) ? outer : siblings, key, value);
  }
  const names = Object.keys(siblings);
  if (names.length === 0) return out;
  warnings.push({
    pointer: at(pointer, "$ref"),
    keyword: "$ref",
    kind: "rewritten",
    message: `"$ref" siblings (${names.join(", ")}) are ignored in draft-07; wrapped as allOf: [{ $ref }, { ...siblings }]`,
  });
  return { ...outer, allOf: [{ $ref: out.$ref }, siblings] };
}

/**
 * Keywords that can EVALUATE properties on behalf of the schema object they sit in (in-place applicators and
 * composition). `unevaluatedProperties` only means "everything these did not cover", so it is equivalent to
 * `additionalProperties` only when none of them is present.
 */
const PROPERTY_EVALUATING_SIBLINGS: readonly string[] = [
  "$ref",
  "$dynamicRef",
  "$recursiveRef",
  "allOf",
  "anyOf",
  "oneOf",
  "if",
  "then",
  "else",
  "not",
  "dependentSchemas",
  "dependencies",
  "additionalProperties",
];

/**
 * True when `unevaluatedProperties` on `node` is exactly `additionalProperties`: a plain object schema whose
 * only property-evaluating keywords are `properties` / `patternProperties` (both draft-07 keywords with the
 * same meaning). This is the shape TypeSpec emits for `Record<T>` — `{ type: object, properties: {},
 * unevaluatedProperties: T }` — so converting keeps the value type in draft-07.
 */
function unevaluatedIsAdditional(node: JsonObject): boolean {
  return !PROPERTY_EVALUATING_SIBLINGS.some((keyword) => keyword in node);
}

function convertSchema(node: JsonObject, pointer: string, warnings: DownConvertWarning[]): JsonObject {
  const out: JsonObject = {};
  const hasPrefixItems = Array.isArray(node.prefixItems);
  const convertUnevaluated = "unevaluatedProperties" in node && unevaluatedIsAdditional(node);

  for (const [key, value] of Object.entries(node)) {
    const here = at(pointer, key);

    if (key === "unevaluatedProperties" && convertUnevaluated) {
      // Equivalent, so nothing is lost and there is nothing to warn about (like `$defs` → `definitions`).
      setOwn(out, "additionalProperties", convertSubschema(value, here, warnings));
      continue;
    }

    if (DROPPED.has(key)) {
      warnings.push({
        pointer: here,
        keyword: key,
        kind: "dropped",
        message: `"${key}" has no draft-07 equivalent and was dropped`,
      });
      continue;
    }

    switch (key) {
      case "$schema":
        out.$schema = DRAFT_07_META_SCHEMA;
        break;
      case "$ref":
        out.$ref = typeof value === "string" ? rewriteDefsRef(value) : structuredClone(value);
        break;
      case "$defs":
      case "definitions":
        mergeDefinitions(out, convertSchemaMap(value, here, warnings), here, warnings);
        break;
      case "prefixItems":
        out.items = convertSchemaArray(value, here, warnings);
        break;
      case "items":
        if (hasPrefixItems) out.additionalItems = convertSubschema(value, here, warnings);
        else
          out.items = Array.isArray(value)
            ? convertSchemaArray(value, here, warnings)
            : convertSubschema(value, here, warnings);
        break;
      case "dependentRequired":
        mergeDependencies(out, structuredClone(value));
        break;
      case "dependentSchemas":
        mergeDependencies(out, convertSchemaMap(value, here, warnings));
        break;
      case "dependencies":
        mergeDependencies(
          out,
          isObject(value)
            ? Object.fromEntries(
                Object.entries(value).map(([k, v]) => [
                  k,
                  Array.isArray(v) ? structuredClone(v) : convertSubschema(v, at(here, k), warnings),
                ]),
              )
            : value,
        );
        break;
      default:
        if (SCHEMA_MAP_KEYWORDS.has(key)) setOwn(out, key, convertSchemaMap(value, here, warnings));
        else if (SCHEMA_ARRAY_KEYWORDS.has(key)) setOwn(out, key, convertSchemaArray(value, here, warnings));
        else if (SINGLE_SCHEMA_KEYWORDS.has(key)) setOwn(out, key, convertSubschema(value, here, warnings));
        else setOwn(out, key, structuredClone(value));
    }
  }
  return wrapRefSiblings(out, pointer, warnings);
}
