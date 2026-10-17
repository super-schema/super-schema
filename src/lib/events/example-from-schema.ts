// src/lib/events/example-from-schema.ts
// A sample JSON value for a JSON Schema: what "Generate from payload" writes into a message example. Pure and client-safe (no server
// imports; the sampler is plain JavaScript). It never throws: a schema it cannot use is an error Result.
//
// The values come from `openapi-sampler`: the first enum value, a const or default when there is one, a fixed plausible value per type
// and string format (a date-time is always 2019-08-24T14:15:22Z, a uuid is derived from the property name), so the same schema always
// gives the same example. Read-only properties are left out: an example is something a producer sends.
//
// "Bounded": this runs in the BROWSER on a schema a tenant user wrote, and the sampler cannot be interrupted, so what it is given is
// checked first, in three steps, and the schema is refused (`EXAMPLE_TOO_LARGE`) before the sampler allocates anything:
//   1. `oversizedKeyword`: no `minLength`, `minItems` or `minProperties` anywhere in the schema may ask for more than MAX_SIZE_KEYWORD
//      (the sampler builds that many characters / items however deep the keyword sits, `if` / `then` / `allOf` included);
//   2. `expandedSize`: what the sampler would build, counted the way it builds it (a `$ref` once per use, `minItems` copies of an item,
//      two samples of `additionalProperties`, `if` and `then` merged into their parent, a long string or a long default as many nodes as
//      it has characters / MAX_NODE_CHARS) must stay within MAX_EXPANDED_NODES;
//   3. the finished example may not be longer than MAX_EXAMPLE_CHARS.
// The sampler itself cuts a recursive `$ref` at its second visit and stops descending at `maxSampleDepth`, but it follows a reference
// every time it meets it, so definitions that fan out (A has two properties of type B, B two of type C, ...) multiply into a huge value,
// and it writes `minItems` copies of an array's item (1000 x 1000 nested arrays is a million values).
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
/**
 * The most any ONE size keyword (`SIZE_KEYWORDS`) may ask for, wherever it sits in the schema (also under `if` / `then` / `else`,
 * `allOf` / `anyOf` / `oneOf`, `not`, `items`, `additionalProperties`, `patternProperties`, `$defs` / `definitions`). A real schema asks for
 * a handful (a `minItems` of 1,000 and a `minLength` of 255 are far beyond what one example needs); a hostile one asks for 100 million.
 * `maxLength` / `maxItems` are not in the list: the sampler only ever cuts to them, it never builds up to them, and real schemas set them
 * to 1,048,576 as a matter of course.
 */
const MAX_SIZE_KEYWORD = 100_000;
const SIZE_KEYWORDS: ReadonlySet<string> = new Set(["minLength", "minItems", "minProperties"]);
/** Longest example (its JSON text, compact) the generator hands back; one that would be longer is refused, never truncated. */
const MAX_EXAMPLE_CHARS = 1024 * 1024;
/** How many characters of a long string, `default`, `const` or `example` the size gate counts as one schema node (so 25,000 nodes is about 1.6 million characters at most). */
const MAX_NODE_CHARS = 64;

const isSchema = (v: unknown): v is Schema => typeof v === "object" && v !== null && !Array.isArray(v);

/** Keywords whose value is a map of schemas, a list of schemas, or one schema, as far as sampling goes (the array part is `itemsSize`). */
const MAP_KEYWORDS = ["properties", "patternProperties"] as const;
const LIST_KEYWORDS = ["allOf", "anyOf", "oneOf"] as const;
/** `additionalProperties` is not here: the sampler writes two entries from it, so it counts twice (`sizeOf`). */
const ONE_KEYWORDS = ["not", "if", "then", "else"] as const;
/** Keywords whose value is data the sampler copies as it is (or never reads): `oversizedKeyword` does not look inside them. */
const DATA_KEYWORDS: ReadonlySet<string> = new Set(["const", "enum", "default", "example", "examples"]);

/**
 * The first size keyword (`SIZE_KEYWORDS`) anywhere in `root` whose value is over MAX_SIZE_KEYWORD, or null. The value is read the way the
 * sampler reads it (`Number(value)`: a string counts, `1e999` is Infinity). The whole tree is walked, iteratively and each object once:
 * a `$ref` may point anywhere, so the schema positions are not the only places that count. Only the data keywords (`enum`, `default` ...)
 * are not entered, and the names of a map (`properties: { default: ... }`) are names, not keywords.
 */
function oversizedKeyword(root: unknown): string | null {
  const seen = new Set<object>();
  const stack: Array<{ value: unknown; names: boolean }> = [{ value: root, names: false }];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const { value, names } = next;
    if (typeof value !== "object" || value === null || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) stack.push({ value: item, names: false });
      continue;
    }
    for (const [key, child] of Object.entries(value)) {
      if (!names && SIZE_KEYWORDS.has(key) && Number(child) > MAX_SIZE_KEYWORD) return key;
      if (!names && DATA_KEYWORDS.has(key)) continue;
      stack.push({ value: child, names: !names && SCHEMA_MAP_KEYWORDS.has(key) });
    }
  }
  return null;
}

/** The sampler's `mergeDeep`: objects present on both sides are merged, anything else is overwritten by the later one. */
function mergeDeep(...objects: unknown[]): Schema {
  const isObject = (v: unknown): v is Schema => typeof v === "object" && v !== null;
  const merged: Schema = {};
  for (const object of objects) {
    if (!isObject(object)) continue;
    for (const [key, value] of Object.entries(object)) {
      const before = merged[key];
      setOwn(merged, key, isObject(before) && isObject(value) ? mergeDeep(before, value) : value);
    }
  }
  return merged;
}

/** The JSON length of `value` (0 for what JSON cannot hold). */
function jsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** How many characters of text the sampler would write for `node` alone: the string `minLength` asks for, or the value it copies. */
function textLength(node: Schema): number {
  const copied = [node.const, node.default, node.example, Array.isArray(node.enum) ? node.enum[0] : undefined, Array.isArray(node.examples) ? node.examples[0] : undefined];
  const minLength = Number(node.minLength);
  return Math.max(Number.isFinite(minLength) ? minLength : 0, ...copied.map(jsonLength));
}

/** `node` as the sampler sees it: `if` and `then` merged into it (a `minItems` in either applies to the node's own array). */
function asSampled(node: Schema): Schema {
  if (!node.if || !node.then) return node;
  const { if: condition, then, ...rest } = node;
  return mergeDeep(rest, condition, then);
}

/**
 * How many schema nodes sampling `root` would build, counting each use of a `$ref` in full; saturates just above the budget. Counted the
 * way the sampler builds: `if` and `then` are merged into their node (`asSampled`) and `additionalProperties` is sampled twice. What
 * the sampler does not read (`else`, `not`) is counted like any sub-schema, which only ever over-counts.
 */
function expandedSize(root: Schema): number {
  const memo = new Map<string, number>();
  const following = new Set<string>();
  const cap = MAX_EXPANDED_NODES + 1;

  function sizeOf(node: unknown): number {
    if (!isSchema(node)) return 0;
    if (typeof node.$ref === "string") return sizeOfRef(node.$ref);
    const own = asSampled(node);
    if (own !== node && typeof own.$ref === "string") return Math.min(1 + sizeOfRef(own.$ref), cap); // the merge brought a `$ref`
    const listOf = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
    const twice = isSchema(node.additionalProperties) ? [node.additionalProperties, node.additionalProperties] : [];
    const children: unknown[] = [
      ...MAP_KEYWORDS.flatMap((keyword) => (isSchema(node[keyword]) ? Object.values(node[keyword]) : [])),
      ...LIST_KEYWORDS.flatMap((keyword) => listOf(node[keyword])),
      ...ONE_KEYWORDS.map((keyword) => node[keyword]),
      ...twice,
    ];
    let total = Math.min(1 + Math.ceil(textLength(own) / MAX_NODE_CHARS), cap);
    for (const child of children) {
      total = Math.min(total + sizeOf(child), cap);
      if (total >= cap) break;
    }
    return total >= cap ? cap : Math.min(total + itemsSize(own), cap);
  }

  /**
   * What the sampler builds for the array part of `node`: as many copies of the item schema as `minItems` (1 when it is not given,
   * never more than `maxItems`), counted the way the sampler reads the two (a string is coerced, 1e999 is Infinity), or, for a tuple,
   * every element once and one node for each place beyond it. `contains` is sampled like `items`.
   */
  function itemsSize(node: Schema): number {
    const items = node.prefixItems || node.items || node.contains;
    if (!items) return 0;
    const length = Math.min(node.maxItems != null ? Number(node.maxItems) : Infinity, Number(node.minItems || 1));
    if (Number.isNaN(length)) return 0; // the sampler's loop does not run for NaN
    const places = Math.ceil(length);
    if (Array.isArray(items)) {
      let tuple = 0;
      for (const item of items) {
        tuple = Math.min(tuple + Math.max(1, sizeOf(item)), cap);
        if (tuple >= cap) return cap;
      }
      return Math.min(tuple + Math.max(0, places - items.length), cap);
    }
    return places > 0 ? Math.min(places * Math.max(1, sizeOf(items)), cap) : 0;
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
 * A JSON value that fits `schema` (a draft-07-style schema: `properties`, `items`, and local `$ref`s into its own `definitions` / `$defs`).
 * Errors: `VALIDATION_ERROR` for something that is not a schema object, `EXAMPLE_TOO_LARGE` for a schema that asks for too much (a size
 * keyword over MAX_SIZE_KEYWORD), would expand beyond the node budget, or gives an example over MAX_EXAMPLE_CHARS (the first two are
 * decided before the sampler allocates anything), `EXAMPLE_FAILED` for one the sampler cannot follow (a `$ref` that goes nowhere, a remote one, ...).
 */
export function exampleFromSchema(schema: Record<string, unknown>): Result<unknown> {
  if (!isSchema(schema)) return err({ code: "VALIDATION_ERROR", message: "A JSON Schema object is required" });
  try {
    const oversized = oversizedKeyword(schema);
    if (oversized !== null) {
      return err({ code: "EXAMPLE_TOO_LARGE", message: `The schema is too large to generate an example from: \`${oversized}\` asks for more than ${MAX_SIZE_KEYWORD.toLocaleString("en-US")}` });
    }
    if (expandedSize(schema) > MAX_EXPANDED_NODES) {
      return err({ code: "EXAMPLE_TOO_LARGE", message: "The schema is too large to generate an example from" });
    }
    // `maxSampleDepth` is an option of the sampler that its type declarations leave out.
    const options = { skipReadOnly: true, quiet: true, maxSampleDepth: MAX_SAMPLE_DEPTH };
    const prepared = preferZero(schema);
    const value = sample(prepared, options, prepared);
    // Through JSON: drops what JSON cannot hold (undefined, symbols) and hands back plain data nobody else shares.
    const text = JSON.stringify(value);
    if (text !== undefined && text.length > MAX_EXAMPLE_CHARS) {
      return err({ code: "EXAMPLE_TOO_LARGE", message: "The example would be larger than 1 MiB, too large to generate" });
    }
    return ok(text === undefined ? null : (JSON.parse(text) as unknown));
  } catch (e: unknown) {
    return err({ code: "EXAMPLE_FAILED", message: `An example could not be generated: ${e instanceof Error ? e.message : "unknown error"}` });
  }
}
