// tests/unit/lib/events/example-from-schema-differential.test.ts
// The inlined copy must not change what the sampler makes of a schema. 2,000 small random schemas (seeded, so a failure is repeatable) are
// built from the keywords the sampler understands: `$ref` (cycles, aliases and targets with an `example` / `const` / `allOf` included),
// `if` / `then` / `else`, `allOf` / `oneOf` / `anyOf` (also two of them, or one with an `if` / `then`, on the same node), `items` (a schema
// or a tuple with falsy places), boolean schemas, `properties` (some with long names), `additionalProperties`, `readOnly`, `example` /
// `enum` / `const` / `default`, and nodes carrying dozens of `x-` keys. For every one that `exampleFromSchema` ACCEPTS, its example is
// compared with what the sampler gives for the very same schema with its `$ref`s resolved the sampler's own way. For every one it
// REFUSES, the reason must be one of the few named constructs it cannot reproduce. A third population is made only of realistic
// combinations (an envelope by `allOf`, its variants by `oneOf`, ...): none of those may be refused.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sample } from "openapi-sampler";
import { exampleFromSchema } from "@/lib/events/example-from-schema";

type Schema = Record<string, unknown>;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random schemas. `heavy` allows long lists and wide fan-out (some of them over the budget). */
class Generator {
  /** The lengths of the lists around the schema being built, multiplied: bounds what the sampler makes of it. */
  private multiplier = 1;
  constructor(private readonly rand: () => number, private readonly heavy: boolean, private definitions = 0) {}
  private int(n: number): number { return Math.floor(this.rand() * n); }
  private chance(p: number): boolean { return this.rand() < p; }
  private pick<T>(list: readonly T[]): T { return list[this.int(list.length)]; }
  private count(): number {
    return this.heavy ? this.pick([1, 2, 3, 8, 40, 160, 500].filter((n) => n * this.multiplier <= 2_000)) : this.int(4);
  }
  /** A property name: now and then a long one. */
  private name(i: number): string {
    return this.chance(0.08) ? `k${i}${"n".repeat(1 + this.int(this.heavy ? 400 : 100))}` : `k${i}`;
  }
  /** `x-` keys the sampler never reads: a node can carry dozens of them. */
  private noisy(node: Schema): Schema {
    if (!this.chance(0.08)) return node;
    for (let i = 0, n = 1 + this.int(60); i < n; i++) node[`x-${i}`] = this.chance(0.3) ? { $ref: "#/nowhere", enum: [i] } : i;
    return node;
  }

  private leaf(): Schema {
    return this.noisy(this.pick<() => Schema>([
      () => ({ type: "string" }),
      () => ({ type: "string", format: this.pick(["uuid", "date-time", "email", "uri"]) }),
      () => ({ type: "string", minLength: this.int(6), ...(this.chance(0.3) ? { maxLength: 3 + this.int(6) } : {}) }),
      () => ({ type: "integer" }),
      () => ({ type: "number" }),
      () => ({ type: "boolean" }),
      () => ({ type: "null" }),
      () => ({ type: ["string", "null"] }),
      () => ({ enum: ["a", "b"] }),
      () => ({ const: 7 }),
      () => ({ type: "string", default: "dflt" }),
      () => ({ type: "string", example: "ex" }),
      () => ({ type: "string", readOnly: true }),
      () => ({ type: "object", readOnly: true, properties: { x: { type: "string" } } }),
      () => ({}),
      () => ({ minLength: 2 }),
    ])());
  }

  private ref(): Schema {
    const ref: Schema = { $ref: `#/definitions/D${this.int(this.definitions)}` };
    if (this.chance(0.15)) ref.readOnly = true; // a reference ignores what sits next to it
    if (this.chance(0.1)) ref.type = "string";
    return ref;
  }

  /** A schema in a place that also takes `true` and `false`. */
  private child(depth: number): unknown {
    return this.chance(0.06) ? this.pick([true, false]) : this.schema(depth);
  }

  private properties(depth: number): Schema {
    const properties: Schema = {};
    for (let i = 0, n = 1 + this.int(this.heavy ? 6 : 3); i < n; i++) properties[this.name(i)] = this.child(depth - 1);
    return properties;
  }

  private object(depth: number): Schema {
    const node: Schema = { type: "object", properties: this.properties(depth) };
    if (this.chance(0.25)) node.additionalProperties = this.chance(0.2) ? { ...this.schema(depth - 1), "x-additionalPropertiesName": this.chance(0.3) ? "e".repeat(1 + this.int(200)) : "extra" } : this.schema(depth - 1);
    if (this.chance(0.15)) node.maxProperties = this.int(4);
    if (this.chance(0.3)) node.required = ["k0"];
    return this.noisy(node);
  }

  private array(depth: number): Schema {
    const node: Schema = { type: "array" };
    // the lengths asked for along one path multiply: they are kept small enough that the sampler's own output stays cheap to build here
    const length = this.chance(0.7) ? this.count() : undefined;
    const outer = this.multiplier;
    this.multiplier *= Math.max(1, length ?? 1);
    const form = this.int(5);
    if (form === 0) node.items = Array.from({ length: 1 + this.int(3) }, () => (this.chance(0.2) ? this.pick([null, false, 0]) : this.child(depth - 1)));
    else if (form === 1) node.prefixItems = [this.schema(depth - 1)];
    else if (form === 2) node.contains = this.schema(depth - 1);
    else node.items = this.child(depth - 1);
    this.multiplier = outer;
    if (length !== undefined) node.minItems = length;
    if (this.chance(0.3)) node.maxItems = this.int(4);
    return this.noisy(node);
  }

  /** `if` / `then` (/ `else`) around a host that is an object, an array or a leaf; `then` may itself hold an `if` / `then`. */
  private conditional(depth: number): Schema {
    const host = this.pick([() => this.object(depth), () => this.array(depth), () => this.leaf()])();
    const then: Schema = this.chance(0.5) ? { properties: this.properties(depth) } : this.chance(0.5) ? { minItems: this.count() } : this.leaf();
    if (this.chance(0.3)) {
      then.if = {};
      then.then = this.chance(0.5) ? { minItems: this.count() } : { properties: this.properties(depth) };
    }
    const node: Schema = { ...host, if: this.chance(0.5) ? {} : { properties: { k0: { const: "x" } } }, then };
    if (this.chance(0.4)) node.else = this.schema(depth - 1);
    if (this.chance(0.1)) {
      node.if = true;
      node.then = true;
    }
    return node;
  }

  /** Two of `allOf` / `oneOf` / `anyOf` / `if` + `then` on ONE node, in every order the sampler can meet them. */
  private combined(depth: number): Schema {
    const entries = (n: number): unknown[] => Array.from({ length: 1 + this.int(n) }, () => (this.definitions > 0 && this.chance(0.4) ? this.ref() : this.child(depth - 1)));
    const node: Schema = this.chance(0.5) ? { type: "object", properties: this.properties(depth) } : {};
    switch (this.int(6)) {
      case 0: return { ...node, allOf: entries(3), oneOf: entries(3) };
      case 1: return { ...node, allOf: entries(3), anyOf: entries(2) };
      case 2: return { ...node, allOf: entries(2), if: {}, then: { properties: this.properties(depth) } };
      case 3: return { ...node, oneOf: entries(3), if: {}, then: { properties: this.properties(depth) }, ...(this.chance(0.4) ? { readOnly: true } : {}) };
      case 4: return { ...node, allOf: entries(2), oneOf: entries(2), anyOf: entries(2), ...(this.chance(0.3) ? { readOnly: true } : {}) };
      default: return { ...node, anyOf: entries(3), if: {}, then: this.chance(0.5) ? { properties: this.properties(depth) } : this.leaf(), ...(this.chance(0.4) ? { writeOnly: true } : {}) };
    }
  }

  schema(depth: number): Schema {
    if (depth <= 0) return this.definitions > 0 && this.chance(0.3) ? this.ref() : this.leaf();
    switch (this.int(16)) {
      case 0: case 1: return this.leaf();
      case 2: case 3: return this.object(depth);
      case 4: return this.array(depth);
      case 5: return this.definitions > 0 ? this.ref() : this.leaf();
      case 6: return { allOf: Array.from({ length: 1 + this.int(3) }, () => this.child(depth - 1)), ...(this.chance(0.4) ? { type: "object" } : {}) };
      case 7: return { oneOf: Array.from({ length: 1 + this.int(3) }, () => this.child(depth - 1)), ...(this.chance(0.4) ? { type: "object", properties: this.properties(depth) } : {}), ...(this.chance(0.2) ? { readOnly: true } : {}) };
      case 8: return { anyOf: Array.from({ length: 1 + this.int(2) }, () => this.schema(depth - 1)), ...(this.chance(0.3) ? { type: "object", properties: this.properties(depth) } : {}), ...(this.chance(0.1) ? { oneOf: [] } : {}) };
      case 9: return this.conditional(depth);
      case 10: return { type: "object", properties: { a: this.schema(depth - 1), b: this.schema(depth - 1) }, allOf: [this.schema(depth - 1)] };
      case 11: return { ...this.object(depth), not: { type: "string" }, description: "noise", title: "T", "x-extra": { $ref: "#/nowhere" } };
      case 12: case 13: return this.combined(depth);
      case 14: return { oneOf: [this.definitions > 0 && this.chance(0.5) ? this.ref() : this.schema(depth - 1), this.leaf()], ...(this.chance(0.3) ? { readOnly: true } : {}) };
      default: return { oneOf: [{ oneOf: [this.child(depth - 1)], ...(this.chance(0.3) ? { readOnly: true } : {}) }, this.leaf()], ...(this.chance(0.4) ? { readOnly: true } : {}) };
    }
  }

  /** A definition: anything, or one of the shapes a reference "brings in" (its own example, a value, an `allOf`, an alias). */
  private definition(depth: number): Schema {
    switch (this.int(8)) {
      case 0: return { type: "string", example: "from-ref" };
      case 1: return { const: "c" };
      case 2: return { allOf: [this.schema(depth - 1), this.schema(depth - 1)] };
      case 3: return { oneOf: [this.schema(depth - 1), this.leaf()] };
      case 4: return this.definitions > 1 ? { $ref: `#/definitions/D${this.int(this.definitions)}` } : this.leaf();
      default: return this.schema(depth);
    }
  }

  root(depth: number): Schema {
    this.definitions = this.int(4);
    const definitions: Schema = {};
    // a definition may sit inside a list, so its own lists are kept short
    this.multiplier = 100;
    for (let i = 0; i < this.definitions; i++) definitions[`D${i}`] = this.definition(depth - 1);
    this.multiplier = 1;
    return { ...this.schema(depth), ...(this.definitions > 0 ? { definitions } : {}) };
  }

  /** Properties as a payload has them: a few leaves, a reference, a list of leaves. */
  private plainProperties(): Schema {
    const properties: Schema = {};
    for (let i = 0, n = 1 + this.int(4); i < n; i++) {
      properties[`k${i}`] = this.chance(0.2) && this.definitions > 0 ? this.ref() : this.chance(0.2) ? { type: "array", items: this.leaf(), minItems: this.int(3) } : this.leaf();
    }
    return properties;
  }

  private plainObject(): Schema {
    return { type: "object", properties: this.plainProperties(), ...(this.chance(0.3) ? { required: ["k0"] } : {}) };
  }

  /**
   * What real schemas do: an envelope by `allOf` and its variants by `oneOf` / `anyOf` on one node, an `allOf` with an `if` / `then`, a
   * `oneOf` with an `if` / `then`, a reference to a definition with its own `example`, and these inside properties. The `if` / `then` only
   * ever add `properties` or `required`, as they do in practice.
   */
  private realisticNode(depth: number): Schema {
    const part = (): unknown => (this.chance(0.5) ? this.ref() : this.plainObject());
    const more = (): Schema => ({ properties: this.plainProperties(), ...(this.chance(0.5) ? { required: ["k0"] } : {}) });
    const variants = (): unknown[] => Array.from({ length: 1 + this.int(3) }, part);
    switch (this.int(8)) {
      case 0: return { type: "object", allOf: [part(), this.plainObject()], oneOf: variants() };
      case 1: return { allOf: [part()], anyOf: variants(), ...(this.chance(0.3) ? { type: "object" } : {}) };
      case 2: return { type: "object", properties: this.plainProperties(), allOf: [part()], if: { properties: { k0: { const: "x" } } }, then: more() };
      case 3: return { oneOf: variants(), if: { properties: { k0: { const: "x" } } }, then: more() };
      case 4: return { type: "object", properties: { a: this.ref(), b: { type: "string", example: "e" } }, allOf: [this.plainObject()] };
      case 5: return { type: "object", allOf: [part()], oneOf: variants(), if: {}, then: more() };
      case 6: return { allOf: [part(), part()], discriminator: { propertyName: "kind" }, oneOf: variants() };
      default: return { type: "object", properties: { payload: depth > 1 ? this.realisticNode(depth - 1) : this.plainObject(), meta: this.ref() }, allOf: [part()] };
    }
  }

  realistic(depth: number): Schema {
    this.definitions = 1 + this.int(3);
    const definitions: Schema = {};
    this.multiplier = 100;
    for (let i = 0; i < this.definitions; i++) {
      definitions[`D${i}`] = this.chance(0.3) ? { type: "string", example: "from-ref" } : this.chance(0.3) ? { allOf: [this.plainObject(), this.plainObject()], oneOf: [this.plainObject()] } : this.plainObject();
    }
    this.multiplier = 1;
    return { ...this.realisticNode(depth), definitions };
  }
}

const OPTIONS = { skipReadOnly: true, quiet: true, maxSampleDepth: 10 };

/** What the sampler gives for the schema as written, `$ref`s and all, through JSON like `exampleFromSchema`; null when the sampler throws. */
function direct(schema: Schema): { value: unknown } | null {
  try {
    const text = JSON.stringify(sample(schema as never, OPTIONS, schema));
    return { value: text === undefined ? null : JSON.parse(text) };
  } catch {
    return null;
  }
}

/** 2,000 schemas of each kind, always the same ones; `DIFFERENTIAL_SEED` / `DIFFERENTIAL_SCHEMAS` run other (or more) of them when hunting. */
const SEED = Number(process.env.DIFFERENTIAL_SEED ?? 0);
const SCHEMAS = Number(process.env.DIFFERENTIAL_SCHEMAS ?? 2_000);
/** The constructs `exampleFromSchema` refuses by name (see `requireHost` and the malformed shapes), and nothing else. */
const NAMED_REFUSAL = /cannot be reproduced|must be (an object|a list|text|schemas)/;

/** The refusal rate of each reason, for the log. */
const category = (message: string): string => message.replace(/^An example could not be generated: /, "").replace(/`[^`]*` brought in by.*/, "readOnly / writeOnly brought in below an entry").slice(0, 90);

// the sampler warns on its own ("allOf: schemas with different types can't be merged") whatever `quiet` says
beforeAll(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterAll(() => {
  vi.restoreAllMocks();
});

/** Runs `count` schemas of one population: same example wherever it accepts; which reasons it refuses for; how many it refused for size. */
function compareAll(rand: () => number, heavy: boolean, depthOf: (i: number) => number, root: (g: Generator, depth: number) => Schema): { compared: number; tooLarge: number; refused: Map<string, number>; first: Map<string, string> } {
  const seen = { compared: 0, tooLarge: 0, refused: new Map<string, number>(), first: new Map<string, string>() };
  for (let i = 0; i < SCHEMAS; i++) {
    const schema = root(new Generator(rand, heavy), depthOf(i));
    const label = `#${i} ${JSON.stringify(schema)}`;
    const mine = exampleFromSchema(schema);
    if (mine.success) {
      const theirs = direct(schema);
      if (theirs === null) continue;
      seen.compared += 1;
      expect(mine.data, label).toEqual(theirs.value);
    } else if (mine.error.code === "EXAMPLE_TOO_LARGE") {
      seen.tooLarge += 1;
    } else {
      const reason = category(mine.error.message);
      seen.refused.set(reason, (seen.refused.get(reason) ?? 0) + 1);
      if (!seen.first.has(reason)) seen.first.set(reason, label); // the first schema refused for each reason, for a failure message
      // a refusal is for one of the named constructs, or because the sampler fails on the schema too
      expect(direct(schema) === null || NAMED_REFUSAL.test(mine.error.message), `${label} -> ${mine.error.message}`).toBe(true);
    }
  }
  return seen;
}

describe("exampleFromSchema agrees with the sampler on every schema it accepts", () => {
  it("2,000 random small schemas: same example, and only the named reasons for a refusal", () => {
    const seen = compareAll(mulberry32(SEED + 20261017), false, (i) => 1 + (i % 4), (g, depth) => g.root(depth));
    console.info("differential (light):", seen.compared, "compared,", seen.tooLarge, "too large, refused:", JSON.stringify([...seen.refused]));
    expect(seen.compared).toBeGreaterThan(1_800);
    expect(seen.tooLarge).toBeLessThan(20);
  }, 60_000);

  it("2,000 random schemas with long lists, long names and wide fan-out: same example wherever it accepts", () => {
    const seen = compareAll(mulberry32(SEED + 8675309), true, (i) => 2 + (i % 4), (g, depth) => g.root(depth));
    console.info("differential (heavy):", seen.compared, "compared,", seen.tooLarge, "too large, refused:", JSON.stringify([...seen.refused]));
    expect(seen.compared).toBeGreaterThan(1_500);
    expect(seen.tooLarge).toBeGreaterThan(10);
  }, 60_000);

  it("2,000 realistic schemas (an envelope by allOf, variants by oneOf / anyOf, allOf or oneOf with an if / then, references with their own example): none is refused", () => {
    const seen = compareAll(mulberry32(SEED + 31337), false, (i) => 1 + (i % 3), (g, depth) => g.realistic(depth));
    console.info("differential (realistic):", seen.compared, "compared,", seen.tooLarge, "too large, refused:", JSON.stringify([...seen.refused]));
    expect([...seen.refused], JSON.stringify([...seen.first])).toEqual([]);
    expect(seen.tooLarge).toBe(0);
    expect(seen.compared).toBe(SCHEMAS);
  }, 60_000);
});
