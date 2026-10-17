// tests/unit/lib/events/example-from-schema-differential.test.ts
// The inlined copy must not change what the sampler makes of a schema. 2,000 small random schemas (seeded, so a failure is repeatable) are
// built from the keywords the sampler understands: `$ref` (cycles included), `if` / `then` / `else`, `allOf` / `oneOf` / `anyOf`, `items`
// (a schema or a tuple), `properties`, `additionalProperties`, `readOnly`, `example` / `enum` / `const` / `default`. For every one that
// `exampleFromSchema` ACCEPTS, its example is compared with what the sampler gives for the very same schema with its `$ref`s resolved
// the sampler's own way. For every one it REFUSES, the reason is checked (and, for the budget, how large the sampler's own output is).
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

  private leaf(): Schema {
    return this.pick<() => Schema>([
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
    ])();
  }

  private ref(): Schema {
    const ref: Schema = { $ref: `#/definitions/D${this.int(this.definitions)}` };
    if (this.chance(0.15)) ref.readOnly = true; // a reference ignores what sits next to it
    if (this.chance(0.1)) ref.type = "string";
    return ref;
  }

  private properties(depth: number): Schema {
    const properties: Schema = {};
    for (let i = 0, n = 1 + this.int(this.heavy ? 6 : 3); i < n; i++) properties[`k${i}`] = this.schema(depth - 1);
    return properties;
  }

  private object(depth: number): Schema {
    const node: Schema = { type: "object", properties: this.properties(depth) };
    if (this.chance(0.25)) node.additionalProperties = this.chance(0.2) ? { ...this.schema(depth - 1), "x-additionalPropertiesName": "extra" } : this.schema(depth - 1);
    if (this.chance(0.15)) node.maxProperties = this.int(4);
    if (this.chance(0.3)) node.required = ["k0"];
    return node;
  }

  private array(depth: number): Schema {
    const node: Schema = { type: "array" };
    // the lengths asked for along one path multiply: they are kept small enough that the sampler's own output stays cheap to build here
    const length = this.chance(0.7) ? this.count() : undefined;
    const outer = this.multiplier;
    this.multiplier *= Math.max(1, length ?? 1);
    const form = this.int(5);
    if (form === 0) node.items = [this.schema(depth - 1), this.schema(depth - 1)];
    else if (form === 1) node.prefixItems = [this.schema(depth - 1)];
    else if (form === 2) node.contains = this.schema(depth - 1);
    else node.items = this.schema(depth - 1);
    this.multiplier = outer;
    if (length !== undefined) node.minItems = length;
    if (this.chance(0.3)) node.maxItems = this.int(4);
    return node;
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

  schema(depth: number): Schema {
    if (depth <= 0) return this.definitions > 0 && this.chance(0.3) ? this.ref() : this.leaf();
    switch (this.int(13)) {
      case 0: case 1: return this.leaf();
      case 2: case 3: return this.object(depth);
      case 4: return this.array(depth);
      case 5: return this.definitions > 0 ? this.ref() : this.leaf();
      case 6: return { allOf: Array.from({ length: 1 + this.int(3) }, () => this.schema(depth - 1)), ...(this.chance(0.4) ? { type: "object" } : {}) };
      case 7: return { oneOf: Array.from({ length: 1 + this.int(3) }, () => this.schema(depth - 1)), ...(this.chance(0.4) ? { type: "object", properties: this.properties(depth) } : {}), ...(this.chance(0.2) ? { readOnly: true } : {}) };
      case 8: return { anyOf: Array.from({ length: 1 + this.int(2) }, () => this.schema(depth - 1)), ...(this.chance(0.3) ? { type: "object", properties: this.properties(depth) } : {}), ...(this.chance(0.1) ? { oneOf: [] } : {}) };
      case 9: return this.conditional(depth);
      case 10: return { type: "object", properties: { a: this.schema(depth - 1), b: this.schema(depth - 1) }, allOf: [this.schema(depth - 1)] };
      case 11: return { ...this.object(depth), not: { type: "string" }, description: "noise", title: "T", "x-extra": { $ref: "#/nowhere" } };
      default: return { oneOf: [this.definitions > 0 && this.chance(0.5) ? this.ref() : this.schema(depth - 1), this.leaf()], ...(this.chance(0.3) ? { readOnly: true } : {}) };
    }
  }

  root(depth: number): Schema {
    this.definitions = this.int(4);
    const definitions: Schema = {};
    // a definition may sit inside a list, so its own lists are kept short
    this.multiplier = 100;
    for (let i = 0; i < this.definitions; i++) definitions[`D${i}`] = this.schema(depth - 1);
    this.multiplier = 1;
    return { ...this.schema(depth), ...(this.definitions > 0 ? { definitions } : {}) };
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

/**
 * How much work the sampler does for the schema as written: how many times it reads `$ref` of a schema (once for every schema it visits, and
 * more for a reference), counted through a proxy that wraps every object of the schema. The size of the example is NOT the measure: the
 * sampler builds what it then throws away (every entry of an `allOf` but the last, a `oneOf` entry that does not merge with its parent, a
 * read-only property). Null when the sampler throws.
 */
function samplerWork(schema: Schema): number | null {
  let reads = 0;
  const wrapped = new WeakMap<object, object>();
  const wrap = (value: unknown): unknown => {
    if (typeof value !== "object" || value === null) return value;
    let proxy = wrapped.get(value);
    if (proxy === undefined) {
      proxy = new Proxy(value, {
        get(target, key, receiver) {
          if (key === "$ref") reads += 1;
          return wrap(Reflect.get(target, key, receiver));
        },
      });
      wrapped.set(value, proxy);
    }
    return proxy;
  };
  try {
    sample(wrap(schema) as never, OPTIONS, wrap(schema) as never);
    return reads;
  } catch {
    return null;
  }
}

const BUDGET = 25_000;
/**
 * The over-refusal bound, measured over 60,000 such schemas (three seeds of 20,000, about 750 of them refused for their size): the least
 * the sampler does for a schema that is refused for its size is 0.16 budgets of schema visits, at worst a factor of about six below the
 * budget (p10 0.7 - 0.8, median 1.2 - 1.4). What is counted although the sampler would not visit it is below an `allOf` entry deeper than
 * the sampler's depth limit (the entry's type is only known at run time) and the visits a depth cut spares. The work is counted by
 * `$ref` reads, so a visit can be one read or three: 0.1 is the floor.
 */
const OVER_REFUSAL_FLOOR = 0.1;
/** 2,000 schemas of each kind, always the same ones; `DIFFERENTIAL_SEED` / `DIFFERENTIAL_SCHEMAS` run other (or more) of them when hunting. */
const SEED = Number(process.env.DIFFERENTIAL_SEED ?? 0);
const SCHEMAS = Number(process.env.DIFFERENTIAL_SCHEMAS ?? 2_000);

// the sampler warns on its own ("allOf: schemas with different types can't be merged") whatever `quiet` says
beforeAll(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe("exampleFromSchema agrees with the sampler on every schema it accepts", () => {
  it("2,000 random small schemas: same example, and only the documented reasons for a refusal", () => {
    const rand = mulberry32(SEED + 20261017);
    const seen = { compared: 0, tooLarge: 0, unsupported: 0, samplerThrew: 0 };
    const reasons = new Map<string, number>();
    for (let i = 0; i < SCHEMAS; i++) {
      const schema = new Generator(rand, false).root(1 + (i % 4));
      const label = `#${i} ${JSON.stringify(schema)}`;
      const mine = exampleFromSchema(schema);
      const theirs = direct(schema);
      if (mine.success) {
        if (theirs === null) { seen.samplerThrew += 1; continue; }
        seen.compared += 1;
        expect(mine.data, label).toEqual(theirs.value);
      } else if (mine.error.code === "EXAMPLE_TOO_LARGE") {
        seen.tooLarge += 1;
      } else {
        seen.unsupported += 1;
        reasons.set(mine.error.message, (reasons.get(mine.error.message) ?? 0) + 1);
        // a refusal is for one of the shapes it cannot copy faithfully, or because the sampler fails on the schema too
        expect(theirs === null || /together with|next to `if`|must be/.test(mine.error.message), label + " -> " + mine.error.message).toBe(true);
      }
    }
    console.info("differential (light):", JSON.stringify(seen), JSON.stringify([...reasons]));
    expect(seen.compared).toBeGreaterThan(1_500);
    expect(seen.tooLarge).toBeLessThan(20);
  });

  it("2,000 random schemas with long lists and wide fan-out: agrees where it accepts, and what it refuses for its size is real work for the sampler", () => {
    const rand = mulberry32(SEED + 8675309);
    const seen = { compared: 0, tooLarge: 0, unsupported: 0, samplerThrew: 0, skipped: 0 };
    const work: number[] = [];
    for (let i = 0; i < SCHEMAS; i++) {
      const schema = new Generator(rand, true).root(2 + (i % 4));
      const label = `#${i} ${JSON.stringify(schema)}`;
      const mine = exampleFromSchema(schema);
      if (mine.success) {
        const theirs = direct(schema);
        if (theirs === null) { seen.samplerThrew += 1; continue; }
        seen.compared += 1;
        expect(mine.data, label).toEqual(theirs.value);
      } else if (mine.error.code === "EXAMPLE_TOO_LARGE") {
        seen.tooLarge += 1;
        // what the sampler itself would do for it (skipped when even that is too much to run here)
        if (JSON.stringify(schema).length > 3_000) { seen.skipped += 1; continue; }
        const reads = samplerWork(schema);
        if (reads === null) { seen.samplerThrew += 1; continue; }
        work.push(reads / BUDGET);
      } else seen.unsupported += 1;
    }
    work.sort((a, b) => a - b);
    const at = (fraction: number): number => work[Math.floor(work.length * fraction)];
    console.info("differential (heavy):", JSON.stringify(seen), "sampler work / budget for the schemas refused for size: min", work[0], "p10", at(0.1), "median", at(0.5));
    expect(seen.compared).toBeGreaterThan(500);
    expect(seen.tooLarge).toBeGreaterThan(10);
    // over-refusal bound: a schema refused for its size costs the sampler at least this fraction of the budget in visited schemas
    expect(work[0]).toBeGreaterThan(OVER_REFUSAL_FLOOR);
  }, 60_000);
});
