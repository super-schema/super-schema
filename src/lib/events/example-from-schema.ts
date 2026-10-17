// src/lib/events/example-from-schema.ts
// A sample JSON value for a JSON Schema: what "Generate from payload" writes into a message example. Pure and client-safe (no server
// imports; the sampler is plain JavaScript). It never throws: a schema it cannot use is an error Result.
//
// The values come from `openapi-sampler`: the first enum value, a const or default when there is one, a fixed plausible value per type
// and string format (a date-time is always 2019-08-24T14:15:22Z, a uuid is derived from the property name), so the same schema always
// gives the same example. Read-only properties are left out: an example is something a producer sends.
//
// "Bounded": the sampler cuts a recursive `$ref` at its second visit and stops descending at `maxSampleDepth`, but it follows a
// reference every time it meets it, so definitions that fan out (A has two properties of type B, B two of type C, ...) multiply into
// a huge value. `expandedSize` counts what the sampler would visit, once per definition, and the schema is refused above a budget.
import { sample } from "openapi-sampler";
import { resolveLocalRef } from "@/lib/event-specs/json-pointer";
import { SCHEMA_ARRAY_KEYWORDS, SCHEMA_MAP_KEYWORDS, SINGLE_SCHEMA_KEYWORDS } from "@/lib/event-specs/json-schema-keywords";
import { setOwn } from "@/lib/event-specs/own-property";
import { ok, err, type Result } from "@/types/result";

type Schema = Record<string, unknown>;

/** The sampler's own limit on how deep objects and arrays nest; deeper levels become an empty placeholder. */
const MAX_SAMPLE_DEPTH = 10;
/** Schema nodes (counting a followed `$ref` once per use) an example may be built from. A 1,000-property payload is about 1,000. */
const MAX_EXPANDED_NODES = 25_000;

const isSchema = (v: unknown): v is Schema => typeof v === "object" && v !== null && !Array.isArray(v);

/** Keywords whose value is a map of schemas, a list of schemas, or one schema, as far as sampling goes. */
const MAP_KEYWORDS = ["properties", "patternProperties"] as const;
const LIST_KEYWORDS = ["allOf", "anyOf", "oneOf", "prefixItems"] as const;
const ONE_KEYWORDS = ["items", "additionalProperties", "not", "if", "then", "else"] as const;

/** How many schema nodes sampling `root` would visit, counting each use of a `$ref` in full; saturates just above the budget. */
function expandedSize(root: Schema): number {
  const memo = new Map<string, number>();
  const following = new Set<string>();
  const cap = MAX_EXPANDED_NODES + 1;

  function sizeOf(node: unknown): number {
    if (!isSchema(node)) return 0;
    if (typeof node.$ref === "string") return sizeOfRef(node.$ref);
    const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
    const children: unknown[] = [
      ...MAP_KEYWORDS.flatMap((keyword) => (isSchema(node[keyword]) ? Object.values(node[keyword]) : [])),
      ...LIST_KEYWORDS.flatMap((keyword) => listOf(node[keyword])),
      ...ONE_KEYWORDS.flatMap((keyword) => (Array.isArray(node[keyword]) ? listOf(node[keyword]) : [node[keyword]])), // `items` may be a list
    ];
    let total = 1;
    for (const child of children) {
      total = Math.min(total + sizeOf(child), cap);
      if (total >= cap) break;
    }
    return total;
  }

  function sizeOfRef(ref: string): number {
    if (following.has(ref)) return 1; // a cycle: the sampler stops here as well
    const known = memo.get(ref);
    if (known !== undefined) return known;
    let target: ReturnType<typeof resolveLocalRef>;
    try {
      target = resolveLocalRef(root, decodeURIComponent(ref));
    } catch {
      return 1; // a malformed escape: the sampler fails on it, not this count
    }
    if (!target.found) return 1;
    following.add(ref);
    const size = Math.min(1 + sizeOf(target.value), cap);
    following.delete(ref);
    memo.set(ref, size);
    return size;
  }

  return sizeOf(root);
}

const NUMERIC = new Set(["integer", "number"]);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/** Where the sampler would otherwise take the value from (it never invents one when the schema gives one). */
const HAS_SAMPLE = ["const", "enum", "default", "example", "examples"] as const;

/** Whether 0 satisfies the bounds of a numeric schema (draft-04 boolean and draft-06+ numeric exclusive bounds both). */
function allowsZero(node: Schema): boolean {
  const { minimum, maximum, exclusiveMinimum, exclusiveMaximum } = node;
  if (finite(minimum) && (minimum > 0 || (minimum === 0 && exclusiveMinimum === true))) return false;
  if (finite(maximum) && (maximum < 0 || (maximum === 0 && exclusiveMaximum === true))) return false;
  if (finite(exclusiveMinimum) && exclusiveMinimum >= 0) return false;
  if (finite(exclusiveMaximum) && exclusiveMaximum <= 0) return false;
  return true;
}

/**
 * The sampler answers a bounded number with its lowest bound, and TypeSpec bounds every `int32` to its type range: every integer of an
 * example would be -2147483648. A bounded number that can be 0 is given the default 0 instead (a bound that excludes 0 still wins).
 * Only schema positions are walked (`json-schema-keywords`); a copy is returned, the input is never touched.
 */
function preferZero(node: Schema): Schema {
  const sub = (value: unknown): unknown => (isSchema(value) ? preferZero(value) : value);
  const out: Schema = {};
  for (const [key, value] of Object.entries(node)) {
    if (SCHEMA_MAP_KEYWORDS.has(key) && isSchema(value)) {
      const map: Schema = {};
      for (const [name, child] of Object.entries(value)) setOwn(map, name, sub(child));
      setOwn(out, key, map);
    } else if ((SCHEMA_ARRAY_KEYWORDS.has(key) || key === "items") && Array.isArray(value)) setOwn(out, key, value.map(sub));
    else if (key === "items" || SINGLE_SCHEMA_KEYWORDS.has(key)) setOwn(out, key, sub(value));
    else setOwn(out, key, value);
  }
  const type = Array.isArray(out.type) ? out.type[0] : out.type;
  const bounded = [out.minimum, out.maximum, out.exclusiveMinimum, out.exclusiveMaximum].some(finite);
  if (typeof type === "string" && NUMERIC.has(type) && bounded && allowsZero(out) && !HAS_SAMPLE.some((k) => k in out)) out.default = 0;
  return out;
}

/**
 * A JSON value that fits `schema` (a fully inlined draft-07-style schema: `properties`, `items`, local `definitions` / `$defs`
 * references). Errors: `VALIDATION_ERROR` for something that is not a schema object, `EXAMPLE_TOO_LARGE` for a schema that would
 * expand beyond the budget, `EXAMPLE_FAILED` for one the sampler cannot follow (a `$ref` that goes nowhere, a remote one, ...).
 */
export function exampleFromSchema(schema: Record<string, unknown>): Result<unknown> {
  if (!isSchema(schema)) return err({ code: "VALIDATION_ERROR", message: "A JSON Schema object is required" });
  try {
    if (expandedSize(schema) > MAX_EXPANDED_NODES) {
      return err({ code: "EXAMPLE_TOO_LARGE", message: "The schema is too large to generate an example from" });
    }
    // `maxSampleDepth` is an option of the sampler that its type declarations leave out.
    const options = { skipReadOnly: true, quiet: true, maxSampleDepth: MAX_SAMPLE_DEPTH };
    const prepared = preferZero(schema);
    const value = sample(prepared, options, prepared);
    // Through JSON: drops what JSON cannot hold (undefined, symbols) and hands back plain data nobody else shares.
    const text = JSON.stringify(value);
    return ok(text === undefined ? null : (JSON.parse(text) as unknown));
  } catch (e: unknown) {
    return err({ code: "EXAMPLE_FAILED", message: `An example could not be generated: ${e instanceof Error ? e.message : "unknown error"}` });
  }
}
