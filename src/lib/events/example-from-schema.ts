// src/lib/events/example-from-schema.ts
// A sample JSON value for a JSON Schema: what "Generate from payload" writes into a message example. Pure and client-safe (no server
// imports; the sampler is plain JavaScript). It never throws: a schema it cannot use is an error Result.
//
// The values come from `openapi-sampler`: the first enum value, a const or default when there is one, a fixed plausible value per type
// and string format (a date-time is always 2019-08-24T14:15:22Z, a uuid is derived from the property name), so the same schema always
// gives the same example. Read-only properties are left out: an example is something a producer sends.
//
// "Bounded": this runs in the BROWSER on a schema a tenant user wrote, and the sampler cannot be interrupted. A gate that counted the
// schema as WRITTEN kept disagreeing with the sampler about what it would build (the sampler re-merges `if` / `then` until none is left,
// follows a `$ref` that is a list or has no `#`, iterates `properties` that is a list, ...), so the sampler is never given that schema.
// Every schema the sampler sees has been inlined and counted first, and every step has its own cost bound:
//   1. `oversizedKeyword`: a sanity limit on the literals of the schema as written, one walk over the schema (the size of the input). A
//      `minLength` or `minItems` over MAX_SIZE_KEYWORD is refused whatever it does (the sampler builds that many characters or items); so
//      is a `minProperties`, which the sampler never reads, but nobody asks for 100,000 properties of an example;
//   2. `normalise`: an inlined copy. Every `$ref` is followed by OUR resolver (only a string that starts with `#` and resolves in this
//      document; anything else is refused), `if` / `then` are merged exactly as the sampler merges them until none is left, a branch the
//      sampler never reads (`else`, `not`, `oneOf` after its first entry, the properties of a node that is not an object, the items of one
//      that is not an array or that holds none ...) is dropped, a place where the sampler would iterate something that is not an object
//      or a list is refused, and a cycle is cut where the sampler cuts it. Every unit of work it does for one use of a schema is charged
//      to MAX_EXPANDED_NODES BEFORE it is done (`spend`, `announce`; the keys of a node are never walked, only the readable ones looked
//      at, `project`), with no memo, so its cost is bounded by that budget whatever the number of uses times the width of what is used.
//      The only work it does that the budget does not pay for is once per object of the schema, not per use: finding how many entries
//      each map has (`widthOf`), and the walk of step 1 and of `preferZero`, which are the size of the input;
//   3. `outputWeight`: what the sampler would build from the copy (`minItems` copies of an item, two samples of `additionalProperties`, a
//      long string, default or property name as many nodes as it has characters / MAX_NODE_CHARS) must stay within MAX_EXPANDED_NODES; it
//      walks the copy, which has at most that many nodes, and stops at the budget;
//   4. the sampler runs on the copy, which holds no `$ref` of the user's and no `if` / `then` for it to disagree about (the one reference
//      left is a fixed one to the sampler's own "no value", see `cut`), and the example may not be longer than MAX_EXAMPLE_CHARS.
import { sample } from "openapi-sampler";
import { resolveLocalRef } from "@/lib/event-specs/json-pointer";
import { SCHEMA_ARRAY_KEYWORDS, SCHEMA_MAP_KEYWORDS, SINGLE_SCHEMA_KEYWORDS } from "@/lib/event-specs/json-schema-keywords";
import { setOwn } from "@/lib/event-specs/own-property";
import { ok, err, type Result } from "@/types/result";

type Schema = Record<string, unknown>;

/** The sampler's own limit on how deep objects and arrays nest; deeper levels become an empty placeholder. */
const MAX_SAMPLE_DEPTH = 10;
/**
 * The budget, in units of work, of BOTH the inlined copy (every `$ref` use counted in full; see `spend` for what a unit is) and what the
 * sampler would build from it (`outputWeight`). A 1,000-property payload is about 1,000. The sampler's work for a schema over it is
 * real work, but it is only an estimate: what the sampler builds and then throws away counts (the entries of an `allOf` but the last, a
 * `oneOf` entry that does not merge with its parent), and the estimate is not claimed to be tight. Nothing here proves a lower bound on
 * how much work a refused schema would have been.
 */
const MAX_EXPANDED_NODES = 25_000;
/**
 * Deepest chain of schemas inside schemas (properties, items, `$ref`s, `allOf` ...) the copy follows. It is a limit of the copy's own
 * recursion only: a schema nested a few thousand levels deep overflows the stack of `preferZero`, which runs first, long before the
 * copy gets here, and that is reported as "nested too deeply" as well.
 */
const MAX_NESTING = 256;
/**
 * The most any ONE of `SIZE_KEYWORDS` may say, wherever it sits in the schema (also under `if` / `then` / `else`, `allOf` / `anyOf` /
 * `oneOf`, `not`, `items`, `additionalProperties`, `patternProperties`, `$defs` / `definitions`). A real schema asks for a handful (a
 * `minItems` of 1,000 and a `minLength` of 255 are far beyond what one example needs); a hostile one asks for 100 million. `minLength`
 * and `minItems` are what the sampler builds up to; `minProperties` it never reads, so a huge one is refused only as a sanity limit.
 * `maxLength` / `maxItems` are not in the list: the sampler only ever cuts to them, it never builds up to them, and real schemas set them
 * to 1,048,576 as a matter of course.
 */
const MAX_SIZE_KEYWORD = 100_000;
const SIZE_KEYWORDS: ReadonlySet<string> = new Set(["minLength", "minItems", "minProperties"]);
/** Longest example (its JSON text, compact) the generator hands back; one that would be longer is refused, never truncated. */
const MAX_EXAMPLE_CHARS = 1024 * 1024;
/** How many characters of a long string, `default`, `const` or `example` the output estimate counts as one schema node (so 25,000 nodes is about 1.6 million characters at most). */
const MAX_NODE_CHARS = 64;

const isSchema = (v: unknown): v is Schema => typeof v === "object" && v !== null && !Array.isArray(v);
const truthy = (v: unknown): boolean => Boolean(v);

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

// ── a refusal: an error Result, decided before the sampler runs ─────────────────────────────────────────────────────────────

class Refusal extends Error {
  constructor(readonly code: "EXAMPLE_TOO_LARGE" | "EXAMPLE_FAILED", message: string) {
    super(message);
  }
}
const TOO_LARGE = "The schema is too large to generate an example from";
const tooLarge = (why: string): Refusal => new Refusal("EXAMPLE_TOO_LARGE", `${TOO_LARGE}: ${why}`);
/** A schema the copy cannot reproduce for the sampler without guessing: refused, never skipped. */
const unsupported = (why: string): Refusal => new Refusal("EXAMPLE_FAILED", `An example could not be generated: ${why}`);

// ── what the sampler reads of a schema (openapi-sampler 1.7.6: traverse.js, allOf.js, infer.js, samplers/*) ───────────────────

/** `inferType` of the sampler: the `type` of a node, or the type its keywords imply. */
const KEYWORD_TYPES: ReadonlyArray<readonly [string, string]> = [
  ["multipleOf", "number"], ["maximum", "number"], ["exclusiveMaximum", "number"], ["minimum", "number"], ["exclusiveMinimum", "number"],
  ["maxLength", "string"], ["minLength", "string"], ["pattern", "string"],
  ["items", "array"], ["maxItems", "array"], ["minItems", "array"], ["uniqueItems", "array"], ["additionalItems", "array"],
  ["maxProperties", "object"], ["minProperties", "object"], ["required", "object"], ["additionalProperties", "object"], ["properties", "object"],
  ["patternProperties", "object"], ["dependencies", "object"],
];
function inferType(node: Schema | boolean): unknown {
  if (typeof node === "boolean") return null;
  if (node.type !== undefined) return Array.isArray(node.type) ? (node.type.length === 0 ? null : node.type[0]) : node.type;
  for (const [keyword, type] of KEYWORD_TYPES) if (node[keyword] !== undefined) return type;
  return null;
}

/** The type the sampler picks a sampler by for a node that gives no value of its own: its `type` (the first of a list), else what its keywords imply. */
function samplerType(node: Schema): unknown {
  const type = Array.isArray(node.type) && node.type.length > 0 ? node.type[0] : node.type;
  return type ? type : inferType(node);
}

/** The value the sampler takes from the node itself, if it has one: `const`, then `examples[0]`, `enum[0]`, `default` (`inferExample`). Lists are checked before this runs. */
function inferExample(node: Schema): unknown {
  if (node.const !== undefined) return node.const;
  if (node.examples !== undefined && (node.examples as unknown[]).length) return (node.examples as unknown[])[0];
  if (node.enum !== undefined && (node.enum as unknown[]).length) return (node.enum as unknown[])[0];
  return node.default;
}

/**
 * Keys the sampler reads of a node besides the schemas it descends into; every other key is left out of the copy (it is never read).
 * `examples` and `enum` are cut to their first entry (only that and their being empty are read).
 */
const COPIED_KEYS = [
  "type", "format", "readOnly", "writeOnly", "const", "default", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minLength", "maxLength", "pattern", "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties", "required",
] as const;
/** Keys the sampler only tests the presence of (`inferType`): the copy keeps an empty placeholder, so the schemas under them are not carried along. */
const PRESENCE_KEYS = ["additionalItems", "patternProperties", "dependencies"] as const;
/** The three places a list of items can be, in the order the sampler prefers them (`prefixItems || items || contains`). */
const ITEM_KEYS = ["prefixItems", "items", "contains"] as const;

/**
 * What the sampler gives for a circular reference or for a node deeper than MAX_SAMPLE_DEPTH (`getResultForCircular`): `{}` for an object,
 * `[]` for an array, and NO value (not even null) for anything else, and no `type`, `readOnly` or `writeOnly` either (the sampler hands
 * those on, and an `allOf` reads them). For the first two an `example` node reproduces it: the sampler returns an `example` as it is, with
 * the node's own `type` (none); `required` / `uniqueItems` are there only so that the sampler's own depth cut, if it meets this node too
 * deep as well, infers `object` / `array` and answers the same again.
 *
 * "No value" cannot be written as a schema (every sampler answers with something, a symbol is told apart from `undefined` by the places
 * that test `!= null` and `!== undefined`), so it is the sampler's own answer: a reference to a fixed definition that refers to itself.
 * It is the one `$ref` the copy holds, it is never the user's, and `OMITTED_DOCUMENT` is the document it is read against.
 */
const OMITTED_REF = "#/definitions/omitted";
const OMITTED_DOCUMENT: object = Object.freeze({ definitions: Object.freeze({ omitted: Object.freeze({ oneOf: Object.freeze([Object.freeze({ $ref: OMITTED_REF })]) }) }) });
function cut(type: unknown): Schema {
  if (type === "object") return { example: {}, required: [] };
  if (type === "array") return { example: [], uniqueItems: false };
  return { $ref: OMITTED_REF };
}

// ── normalise: the inlined copy ─────────────────────────────────────────────────────────────────────────────────────────

/** The sampler's context for a node: how deep it is (`undefined` at the root and below an `allOf` at the root). */
type Ctx = { depth: number | undefined } | undefined;
const below = (ctx: Ctx): Ctx => ({ depth: ((ctx && ctx.depth) || 1) + 1 });

/**
 * How a node is reached, where the sampler hands it over differently:
 * - `fresh`: the sampler gets a new object (a merge, a copy without `oneOf`), so it can never be one that is already being visited;
 * - `injected`: an `allOf` entry, which the sampler spreads over `{ type: <the type found so far> }` at run time, so its depth cut (which
 *   infers a type) cannot be decided here: the copy is left to the sampler to cut;
 * - `pin`: a node that came out of a `$ref` in a place where the sampler would have treated the reference differently from its target
 *   (`allOf` entries get the type injected, the first `oneOf` / `anyOf` entry gets `readOnly` / `writeOnly` of its parent): the copy
 *   states those keys itself, so the sampler's own copying of them changes nothing;
 * - `assigned`: the first `oneOf` / `anyOf` entry itself (not what a `$ref` of it points at): the sampler hands it over as a copy that
 *   already carries `readOnly` / `writeOnly` of its parent, which its own first entry then inherits in turn.
 */
interface How { fresh?: boolean; injected?: boolean; pin?: "allOf" | "selected"; assigned?: boolean }

interface Walk {
  root: Schema;
  /** The decoded references being followed on the way down: meeting one again is a cycle (the sampler's `$refCache`). */
  following: Set<string>;
  /** The schemas being visited, as the sampler's `seenSchemasStack` has them. */
  onStack: Set<object>;
  /** The work done so far, in units (see `spend`). */
  nodes: number;
  /** How many entries each object has, found once per object: what a walk over one of its maps costs is known before the walk. */
  widths: WeakMap<object, number>;
}

/**
 * Charges `units` of work to the budget BEFORE it is done, and stops the whole expansion once the budget is gone. Everything `normalise`
 * does for one use of a schema is charged this way: a schema position (a node, a boolean, a falsy tuple item: one unit), a key a merge
 * copies, a reference followed (one unit per MAX_NODE_CHARS of its text beyond the first). So its cost is bounded by MAX_EXPANDED_NODES
 * whatever the number of uses times the width of what is used.
 */
function spend(w: Walk, units: number): void {
  w.nodes += units;
  if (w.nodes > MAX_EXPANDED_NODES) throw tooLarge(`it is more than ${MAX_EXPANDED_NODES.toLocaleString("en-US")} nodes once its references are inlined`);
}

/**
 * Stops before a walk over `entries` entries that will be charged one by one (as they are visited) if the budget could not pay for them
 * anyway: the walk does not start, and the array it would have started with (`Object.entries`, `map`) is not built.
 */
function announce(w: Walk, entries: number): void {
  if (w.nodes + entries > MAX_EXPANDED_NODES) throw tooLarge(`it is more than ${MAX_EXPANDED_NODES.toLocaleString("en-US")} nodes once its references are inlined`);
}

/** How many entries `object` has (a list: its length), counted once per object for the whole expansion. */
function widthOf(w: Walk, object: object): number {
  let width = w.widths.get(object);
  if (width === undefined) {
    width = Array.isArray(object) ? object.length : Object.keys(object).length;
    w.widths.set(object, width);
  }
  return width;
}

/**
 * The keys of a node that `normaliseNode` can read; the keys of a node are never walked, only these are looked at, so what a node costs
 * does not depend on how many other keys (`x-` extensions, descriptions, ...) it carries.
 */
const READ_KEYS: readonly string[] = [
  ...COPIED_KEYS, ...PRESENCE_KEYS, ...ITEM_KEYS, "$ref", "example", "enum", "examples", "allOf", "oneOf", "anyOf", "if", "then", "properties", "additionalProperties",
];

/** The readable keys of `node` (those of `READ_KEYS` it has, except `skip`) as a new object: a node as the sampler is handed it, without the keyword being looked at separately. */
function project(node: unknown, skip: readonly string[] = []): unknown {
  if (!isSchema(node)) return node;
  const out: Schema = {};
  for (const key of READ_KEYS) if (!skip.includes(key) && Object.hasOwn(node, key)) setOwn(out, key, node[key]);
  return out;
}

/** The node as a copy that only has what `inferExample` reads (what the sampler returns for a node that gives its own value). */
function inferredOnly(node: Schema): Schema {
  const out: Schema = {};
  for (const key of ["const", "default", "readOnly", "writeOnly"]) if (Object.hasOwn(node, key)) setOwn(out, key, node[key]);
  for (const key of ["examples", "enum"]) if (Array.isArray(node[key])) setOwn(out, key, (node[key] as unknown[]).slice(0, 1));
  return out;
}

/**
 * The sampler's `mergeDeep`: objects present on both sides are merged (lists index by index), anything else is overwritten by the later one.
 * Every key it visits is charged, and the walk over a map is announced first (`announce`).
 */
function mergeDeep(w: Walk, ...objects: unknown[]): Schema {
  const isObject = (v: unknown): v is Schema => Boolean(v) && typeof v === "object";
  const merged: Schema = Array.isArray(objects[objects.length - 1]) ? ([] as unknown as Schema) : {};
  for (const object of objects) {
    const source = (object || {}) as Schema;
    if (typeof source !== "object") continue; // `Object.keys(true)` is empty
    announce(w, widthOf(w, source));
    for (const key of Object.keys(source)) {
      spend(w, 1);
      const before = Object.hasOwn(merged, key) ? merged[key] : undefined;
      setOwn(merged, key, isObject(before) && isObject(source[key]) ? mergeDeep(w, before, source[key]) : source[key]);
    }
  }
  return merged;
}

/**
 * `if` and `then` of a node merged into the rest of it, as the sampler does before it goes on with the result (which may hold `if` and
 * `then` again). Only the readable keys of the three take part: the others are never looked at afterwards.
 */
function mergeIfThen(w: Walk, node: Schema): Schema {
  const { if: condition, then } = node;
  for (const part of [condition, then]) if (part !== true && !isSchema(part)) throw unsupported("`if` and `then` must be schemas");
  return mergeDeep(w, project(node, ["if", "then"]), project(condition), project(then));
}

/**
 * The host of an `allOf` / `oneOf` / `anyOf` as the copy has it (the node without that keyword) must not carry what would make the sampler take
 * another branch for the copy than it took for the original: a reference, an `example`, a value of its own (`const`, `enum`, `examples`,
 * `default`) or an `allOf` (and, for `oneOf` / `anyOf`, the other of the two). The node itself never has them (it would not be here), so they
 * can only come from an `if` / `then` or a `$ref` that brings them in: the one thing that is refused, by name.
 */
function requireHost(host: Schema, keyword: "allOf" | "oneOf" | "anyOf"): void {
  const brings =
    host.$ref !== undefined ? "a reference cycle"
      : host.example !== undefined ? "an `example`"
        : host.allOf !== undefined ? "an `allOf`"
          : inferExample(host) !== undefined ? "a `const`, `enum`, `examples` or `default`"
            : keyword !== "allOf" && (host.oneOf !== undefined || host.anyOf !== undefined) ? "a `oneOf` or `anyOf`"
              : null;
  if (brings !== null) throw unsupported(`\`${keyword}\` on a node whose \`if\` / \`then\` or \`$ref\` brings ${brings} of its own cannot be reproduced`);
}

function pin(node: Schema, how: How, afterRef: boolean): Schema {
  if (node.$ref !== undefined) return node; // the sampler's own "no value": it ignores what sits next to a reference
  if (how.pin === "allOf" && afterRef && !Object.hasOwn(node, "type")) setOwn(node, "type", undefined);
  if (how.pin === "selected") {
    if (!Object.hasOwn(node, "readOnly")) setOwn(node, "readOnly", undefined);
    if (!Object.hasOwn(node, "writeOnly")) setOwn(node, "writeOnly", undefined);
  }
  return node;
}

/** The copy of one schema position, mirroring the order of the sampler's `traverse`. Always a new object. */
function normaliseNode(w: Walk, node: unknown, ctx: Ctx, how: How, level: number): Schema {
  spend(w, 1); // charged first, whatever the position turns out to be (a boolean is a unit of work too)
  if (node === true || node === false) return {}; // the sampler gives null for it, as for `{}`
  if (!isSchema(node)) throw unsupported("a schema must be an object");
  if (level > MAX_NESTING) throw tooLarge("it nests schemas inside schemas too deeply");
  const tracked = ctx !== undefined && !how.fresh;
  const tooDeep = !how.injected && ctx !== undefined && ctx.depth !== undefined && ctx.depth > MAX_SAMPLE_DEPTH;
  if ((tracked && w.onStack.has(node)) || tooDeep) return pin(cut(inferType(node)), how, false);
  if (tracked) w.onStack.add(node);
  const release = (): void => {
    if (tracked) w.onStack.delete(node);
  };
  try {
    return normaliseBody(w, node, ctx, how, level, release);
  } finally {
    release();
  }
}

function normaliseBody(w: Walk, node: Schema, ctx: Ctx, how: How, level: number, release: () => void): Schema {
  // 1. a `$ref`: the node is replaced by what it points at (its other keys are not read)
  if (truthy(node.$ref)) {
    const ref = node.$ref;
    if (typeof ref !== "string" || !ref.startsWith("#")) throw unsupported("only a reference into the schema itself (\"#/...\") can be followed");
    spend(w, Math.floor(ref.length / MAX_NODE_CHARS)); // a long reference text is read, decoded and split again for every use
    let decoded: string;
    try {
      decoded = decodeURIComponent(ref);
    } catch {
      throw unsupported("a reference is malformed");
    }
    const resolved = resolveLocalRef(w.root, decoded);
    if (!resolved.found) throw unsupported(`the reference "${decoded.slice(0, 80)}" goes nowhere`);
    const target = resolved.value;
    if (typeof target !== "boolean" && !isSchema(target)) throw unsupported("a reference does not point at a schema");
    const key = decoded.slice(1);
    let result: Schema;
    if (w.following.has(key)) result = cut(inferType(target));
    else {
      w.following.add(key);
      try {
        result = normaliseNode(w, target, ctx, { pin: how.pin }, level + 1);
      } finally {
        w.following.delete(key);
      }
    }
    release();
    return pin(result, how, true);
  }
  // 2. an `example`: the sampler returns it and looks at nothing else
  if (node.example !== undefined) {
    release();
    const out: Schema = { example: node.example };
    for (const key of ["type", "readOnly", "writeOnly"]) if (node[key] !== undefined) setOwn(out, key, node[key]);
    return out;
  }
  for (const key of ["enum", "examples", "allOf", "oneOf", "anyOf"]) {
    if (node[key] !== undefined && !Array.isArray(node[key])) throw unsupported(`\`${key}\` must be a list`);
  }
  // 3. `allOf`: the node without it (which may still hold `oneOf`, `anyOf`, `if` / `then`: the sampler looks at those inside), then every
  // entry; a value of its own (`const` ...) ends it before that
  if (node.allOf !== undefined) {
    release();
    if (inferExample(node) !== undefined) return inferredOnly(node);
    const rest = normaliseNode(w, project(node, ["allOf"]), undefined, { fresh: true, injected: how.injected, assigned: how.assigned }, level + 1);
    requireHost(rest, "allOf");
    const entryCtx: Ctx = { depth: ctx ? ctx.depth : undefined };
    const entries: Schema[] = [];
    announce(w, (node.allOf as unknown[]).length);
    for (const entry of node.allOf as unknown[]) {
      entries.push(normaliseNode(w, entry, entryCtx, { fresh: true, injected: true, pin: "allOf" }, level + 1));
    }
    return setOwn({ ...rest }, "allOf", entries);
  }
  // 4. `oneOf`, else `anyOf`: the node without them, merged with their FIRST entry (the rest of the entries are never read)
  const keyword = truthy(node.oneOf) && (node.oneOf as unknown[]).length > 0 ? "oneOf" : truthy(node.anyOf) && (node.anyOf as unknown[]).length > 0 ? "anyOf" : null;
  if (keyword !== null) {
    release();
    if (inferExample(node) !== undefined) return inferredOnly(node);
    const local = normaliseNode(w, project(node, ["oneOf", "anyOf"]), ctx, { fresh: true, injected: how.injected }, level + 1);
    requireHost(local, keyword);
    const first = normaliseNode(w, (node[keyword] as unknown[])[0], ctx, { fresh: true, pin: "selected", assigned: true }, level + 1);
    // The sampler gives the first entry `readOnly` / `writeOnly` of the node it is handed (before an `if` / `then` of it is merged), unless
    // the entry says its own. For a node that is itself such an entry, what it is handed already carries its parent's, and the sampler
    // passes that on by itself, as long as the copy says what the original said: not once an `if` / `then` has changed it.
    for (const key of ["readOnly", "writeOnly"]) {
      if (how.assigned) {
        if (Object.hasOwn(local, key) !== Object.hasOwn(node, key) || local[key] !== node[key]) {
          throw unsupported(`\`${key}\` brought in by an \`if\` / \`then\` on a \`${keyword}\` entry that is itself a \`oneOf\` / \`anyOf\` entry cannot be reproduced`);
        }
      } else if (!Object.hasOwn(first, key)) setOwn(first, key, node[key]);
    }
    return setOwn({ ...local }, keyword, [first]);
  }
  // 5. `if` and `then`: merged into the node, which then goes through all of this again
  if (truthy(node.if) && truthy(node.then)) {
    release();
    return normaliseNode(w, mergeIfThen(w, node), ctx, { fresh: true, injected: how.injected, pin: how.pin, assigned: how.assigned }, level + 1);
  }
  return plainCopy(w, node, ctx, how, level, release);
}

/** A node the sampler builds from its own keywords and the schemas under `properties`, `additionalProperties` and the items. */
function plainCopy(w: Walk, node: Schema, ctx: Ctx, how: How, level: number, release: () => void): Schema {
  const out: Schema = {};
  for (const key of COPIED_KEYS) if (Object.hasOwn(node, key)) setOwn(out, key, node[key]);
  for (const key of ["examples", "enum"]) if (Array.isArray(node[key])) setOwn(out, key, (node[key] as unknown[]).slice(0, 1));
  for (const key of PRESENCE_KEYS) if (node[key] !== undefined) setOwn(out, key, {});
  const inner = below(ctx);
  // The sampler reads the properties of an object only and the items of an array only, so what sits under any other type is never visited
  // and is not carried over (`injected`: the type is not known yet, the sampler gets it at run time, so everything is).
  const type = how.injected ? undefined : samplerType(node);
  const asObject = type === undefined || type === "object";
  const asArray = type === undefined || type === "array";

  const properties = node.properties;
  if (typeof properties === "object" && asObject) {
    if (properties === null || Array.isArray(properties)) throw unsupported("`properties` must be an object");
    const map: Schema = {};
    announce(w, widthOf(w, properties)); // each property is charged as it is visited
    for (const [name, child] of Object.entries(properties)) setOwn(map, name, normaliseNode(w, child, inner, {}, level + 1));
    setOwn(out, "properties", map);
  } else if (properties !== undefined) setOwn(out, "properties", typeof properties === "object" ? {} : properties);

  const extra = node.additionalProperties;
  if (typeof extra === "object" && asObject) {
    if (extra === null || Array.isArray(extra)) throw unsupported("`additionalProperties` must be an object or a boolean");
    const child = normaliseNode(w, extra, inner, {}, level + 1);
    // the sampler names the two entries from the node it was given, not from what that node points at (and writes the name twice)
    const name = (extra as Schema)["x-additionalPropertiesName"];
    if (truthy(name) && typeof name !== "string" && typeof name !== "number" && typeof name !== "boolean") throw unsupported("`x-additionalPropertiesName` must be text");
    setOwn(child, "x-additionalPropertiesName", name);
    setOwn(out, "additionalProperties", child);
  } else if (extra !== undefined) setOwn(out, "additionalProperties", typeof extra === "object" ? {} : extra);

  const chosen = ITEM_KEYS.find((key) => truthy(node[key]));
  // an array of no items at all (`maxItems: 0`) visits nothing, unless the items are a tuple (those are all visited)
  const length = Math.min(node.maxItems !== undefined && node.maxItems !== null ? (node.maxItems as number) : Infinity, (node.minItems as number) || 1);
  const visited = asArray && (Array.isArray(chosen ? node[chosen] : undefined) || length > 0);
  for (const key of ITEM_KEYS) {
    if (!Object.hasOwn(node, key)) continue;
    const value = node[key];
    if (key !== chosen || !visited) setOwn(out, key, truthy(value) ? {} : value);
    else if (Array.isArray(value)) {
      announce(w, value.length);
      // a falsy item is `{}` for the sampler: a unit of work like any other
      const copyOf = (item: unknown): Schema => {
        if (item) return normaliseNode(w, item, inner, {}, level + 1);
        spend(w, 1);
        return {};
      };
      setOwn(out, key, value.map(copyOf));
    } else setOwn(out, key, normaliseNode(w, value, inner, {}, level + 1));
  }
  release();
  return out;
}

/** The inlined copy of `root`. Throws a `Refusal` for a schema it cannot copy faithfully or within MAX_EXPANDED_NODES. */
function normalise(root: Schema): Schema {
  return normaliseNode({ root, following: new Set(), onStack: new Set(), nodes: 0, widths: new WeakMap() }, root, undefined, {}, 0);
}

// ── outputWeight: what the sampler would build from the copy ────────────────────────────────────────────────────────────────

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
  const minLength = Number(node.minLength);
  return Math.max(Number.isFinite(minLength) ? minLength : 0, jsonLength(node.example !== undefined ? node.example : inferExample(node)));
}

/**
 * How many nodes sampling the copy `root` builds, counted the way the sampler builds: `minItems` copies of an item (never more than
 * `maxItems`), two samples of `additionalProperties`, a long string or copied value as many nodes as it has characters / MAX_NODE_CHARS,
 * and so is the text of a property name (the sampler writes it into every object it builds) and of the name of the two entries of an
 * `additionalProperties`. All of it is counted per use, before the sampler runs, and stops at the budget.
 */
function outputWeight(root: Schema): number {
  const cap = MAX_EXPANDED_NODES + 1;
  const ofText = (characters: number): number => Math.ceil(characters / MAX_NODE_CHARS);

  function sizeOf(node: Schema): number {
    let total = Math.min(1 + ofText(textLength(node)), cap);
    const add = (size: number): boolean => {
      total = Math.min(total + size, cap);
      return total >= cap;
    };
    if (isSchema(node.properties)) {
      for (const [name, child] of Object.entries(node.properties)) if (isSchema(child) && add(ofText(name.length) + sizeOf(child))) return cap;
    }
    if (isSchema(node.additionalProperties)) {
      const label = node.additionalProperties["x-additionalPropertiesName"];
      // `property1` / `property2`, or the name and a digit
      const named = truthy(label) ? String(label).length + 1 : "property1".length;
      if (add(2 * (ofText(named) + sizeOf(node.additionalProperties)))) return cap;
    }
    if (Array.isArray(node.allOf)) for (const child of node.allOf) if (isSchema(child) && add(sizeOf(child))) return cap;
    const selected = Array.isArray(node.oneOf) ? node.oneOf[0] : Array.isArray(node.anyOf) ? node.anyOf[0] : undefined;
    if (isSchema(selected) && add(sizeOf(selected))) return cap;
    add(itemsWeight(node));
    return total;
  }

  /**
   * What the sampler builds for the array part of `node`: as many copies of the item schema as `minItems` (1 when it is not given, never
   * more than `maxItems`), counted the way the sampler reads the two (a string is coerced, 1e999 is Infinity), or, for a tuple, every
   * element once and one node for each place beyond it. `contains` is sampled like `items`.
   */
  function itemsWeight(node: Schema): number {
    const items = node.prefixItems || node.items || node.contains;
    if (!items) return 0;
    const length = Math.min(node.maxItems != null ? Number(node.maxItems) : Infinity, Number(node.minItems || 1));
    if (Number.isNaN(length)) return 0; // the sampler's loop does not run for NaN
    const places = Math.ceil(length);
    if (Array.isArray(items)) {
      let tuple = 0;
      for (const item of items) {
        tuple = Math.min(tuple + Math.max(1, isSchema(item) ? sizeOf(item) : 1), cap);
        if (tuple >= cap) return cap;
      }
      return Math.min(tuple + Math.max(0, places - items.length), cap);
    }
    return places > 0 ? Math.min(places * Math.max(1, isSchema(items) ? sizeOf(items) : 1), cap) : 0;
  }

  return sizeOf(root);
}

// ── numbers ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

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
 * Errors: `VALIDATION_ERROR` for something that is not a schema object; `EXAMPLE_TOO_LARGE` for a schema that asks for too much (a size
 * keyword over MAX_SIZE_KEYWORD), is more than MAX_EXPANDED_NODES once inlined or would build more than that, or gives an example over
 * MAX_EXAMPLE_CHARS (all but the last are decided before the sampler allocates anything); `EXAMPLE_FAILED` for a schema it cannot copy
 * faithfully for the sampler (a `$ref` that goes nowhere, a remote one or one that is not a string, `properties` that is a list, ...).
 */
export function exampleFromSchema(schema: Record<string, unknown>): Result<unknown> {
  if (!isSchema(schema)) return err({ code: "VALIDATION_ERROR", message: "A JSON Schema object is required" });
  try {
    const oversized = oversizedKeyword(schema);
    if (oversized !== null) {
      return err({ code: "EXAMPLE_TOO_LARGE", message: `${TOO_LARGE}: \`${oversized}\` asks for more than ${MAX_SIZE_KEYWORD.toLocaleString("en-US")}` });
    }
    const inlined = normalise(preferZero(schema));
    if (outputWeight(inlined) > MAX_EXPANDED_NODES) return err({ code: "EXAMPLE_TOO_LARGE", message: TOO_LARGE });
    // `maxSampleDepth` is an option of the sampler that its type declarations leave out. The only document is the fixed one of `cut`: nothing else in the copy refers to one.
    const options = { skipReadOnly: true, quiet: true, maxSampleDepth: MAX_SAMPLE_DEPTH };
    const value = sample(inlined, options, OMITTED_DOCUMENT);
    // Through JSON: drops what JSON cannot hold (undefined, symbols) and hands back plain data nobody else shares.
    const text = JSON.stringify(value);
    if (text !== undefined && text.length > MAX_EXAMPLE_CHARS) {
      return err({ code: "EXAMPLE_TOO_LARGE", message: "The example would be larger than 1 MiB, too large to generate" });
    }
    return ok(text === undefined ? null : (JSON.parse(text) as unknown));
  } catch (e: unknown) {
    if (e instanceof Refusal) return err({ code: e.code, message: e.message });
    if (e instanceof RangeError) {
      // the stack (a schema nested thousands of levels deep: `preferZero`, below the copy's own limit, gives out first) or a string or list too long to build
      return /call stack/i.test(e.message)
        ? err({ code: "EXAMPLE_FAILED", message: "This schema is nested too deeply to generate an example from." })
        : err({ code: "EXAMPLE_TOO_LARGE", message: "The example would be too large to generate." });
    }
    return err({ code: "EXAMPLE_FAILED", message: `An example could not be generated: ${e instanceof Error ? e.message : "unknown error"}` });
  }
}
