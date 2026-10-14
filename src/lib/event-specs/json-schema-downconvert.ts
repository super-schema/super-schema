import type { JsonObject, JsonValue } from "./types";
import { escapePointerSegment } from "./json-pointer";

/**
 * Spec §7.3 / Story 16.2 pure core: down-convert a JSON Schema 2020-12 document
 * to draft-07 for channels whose format profile asks for it.
 *
 * - `$defs` → `definitions`, and every `$ref` fragment segment `$defs` → `definitions`
 * - `prefixItems` → `items` (array form); a sibling 2020-12 `items` → `additionalItems`
 * - `dependentRequired` / `dependentSchemas` → `dependencies`
 * - keywords with no draft-07 equivalent are dropped, each with a warning
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

export type DownConvertWarning = { pointer: string; keyword: string; message: string };
export type DownConvertResult = { schema: JsonObject; warnings: DownConvertWarning[] };

const DROPPED = new Set(UNSUPPORTED_IN_DRAFT_07);
const SCHEMA_MAP_KEYWORDS = new Set(["properties", "patternProperties"]);
const SCHEMA_ARRAY_KEYWORDS = new Set(["allOf", "anyOf", "oneOf"]);
const SINGLE_SCHEMA_KEYWORDS = new Set([
  "additionalProperties",
  "additionalItems",
  "contains",
  "propertyNames",
  "if",
  "then",
  "else",
  "not",
]);

const isObject = (v: JsonValue | undefined): v is JsonObject =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function downConvertToDraft07(schema: JsonObject): DownConvertResult {
  const warnings: DownConvertWarning[] = [];
  return { schema: convertSchema(schema, "", warnings), warnings };
}

/** Rewrite `$defs` segments in the fragment of a `$ref` (`a.json#/$defs/X` → `a.json#/definitions/X`). */
export function rewriteDefsRef(ref: string): string {
  const hash = ref.indexOf("#");
  if (hash < 0) return ref;
  const fragment = ref
    .slice(hash + 1)
    .split("/")
    .map((s) => (s === "$defs" ? "definitions" : s))
    .join("/");
  return `${ref.slice(0, hash)}#${fragment}`;
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
  for (const [k, v] of Object.entries(value)) out[k] = convertSubschema(v, at(pointer, k), warnings);
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
        message: `definition "${name}" exists in both $defs and definitions; the first one was kept`,
      });
      continue;
    }
    target[name] = schema;
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
    target[prop] = Object.prototype.hasOwnProperty.call(target, prop) ? combineDependency(target[prop], value) : value;
  }
  out.dependencies = target;
}

function convertSchema(node: JsonObject, pointer: string, warnings: DownConvertWarning[]): JsonObject {
  const out: JsonObject = {};
  const hasPrefixItems = Array.isArray(node.prefixItems);

  for (const [key, value] of Object.entries(node)) {
    const here = at(pointer, key);

    if (DROPPED.has(key)) {
      warnings.push({ pointer: here, keyword: key, message: `"${key}" has no draft-07 equivalent and was dropped` });
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
        if (SCHEMA_MAP_KEYWORDS.has(key)) out[key] = convertSchemaMap(value, here, warnings);
        else if (SCHEMA_ARRAY_KEYWORDS.has(key)) out[key] = convertSchemaArray(value, here, warnings);
        else if (SINGLE_SCHEMA_KEYWORDS.has(key)) out[key] = convertSubschema(value, here, warnings);
        else out[key] = structuredClone(value);
    }
  }
  return out;
}
