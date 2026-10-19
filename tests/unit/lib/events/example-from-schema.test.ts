import { beforeEach, describe, expect, it, vi } from "vitest";
import { sample } from "openapi-sampler";
import { exampleFromSchema } from "@/lib/events/example-from-schema";
import type { Result } from "@/types/result";

// The real sampler, watched: a hostile schema must be refused BEFORE it is called (asserted through the spy, not through memory).
vi.mock("openapi-sampler", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openapi-sampler")>();
  return { ...actual, sample: vi.fn(actual.sample) };
});

type Schema = Record<string, unknown>;

/** The example of `schema`, failing the test (with the error) when there is none. */
function example(schema: Schema): unknown {
  const result = exampleFromSchema(schema);
  if (!result.success) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
}
const failure = (r: Result<unknown>) => (r.success ? null : r.error);

describe("exampleFromSchema", () => {
  it("builds an object from its properties, in the order the schema lists them", () => {
    const value = example({
      type: "object",
      properties: { orderId: { type: "string" }, quantity: { type: "integer" }, total: { type: "number" }, paid: { type: "boolean" } },
      required: ["orderId"],
    });
    expect(value).toEqual({ orderId: "string", quantity: 0, total: 0, paid: true });
    expect(Object.keys(value as object)).toEqual(["orderId", "quantity", "total", "paid"]);
  });

  it("fills nested objects (no $ref) and arrays of objects", () => {
    expect(example({
      type: "object",
      properties: {
        customer: { type: "object", properties: { name: { type: "string" }, address: { type: "object", properties: { zip: { type: "string" } } } } },
        lines: { type: "array", items: { type: "object", properties: { sku: { type: "string" }, qty: { type: "integer" } } } },
        tags: { type: "array", items: { type: "string" } },
      },
    })).toEqual({
      customer: { name: "string", address: { zip: "string" } },
      lines: [{ sku: "string", qty: 0 }],
      tags: ["string"],
    });
  });

  it("takes the first value of an enum, a const, and a default", () => {
    expect(example({
      type: "object",
      properties: {
        status: { type: "string", enum: ["NEW", "PAID", "SHIPPED"] },
        kind: { const: "order" },
        currency: { type: "string", default: "EUR" },
      },
    })).toEqual({ status: "NEW", kind: "order", currency: "EUR" });
  });

  it("gives a plausible value for the usual string formats", () => {
    expect(example({
      type: "object",
      properties: {
        at: { type: "string", format: "date-time" },
        day: { type: "string", format: "date" },
        id: { type: "string", format: "uuid" },
        mail: { type: "string", format: "email" },
        site: { type: "string", format: "uri" },
      },
    })).toEqual({
      at: "2019-08-24T14:15:22Z",
      day: "2019-08-24",
      id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      mail: "user@example.com",
      site: "http://example.com",
    });
  });

  it("is deterministic: the same schema gives the same example every time, uuids included", () => {
    const schema: Schema = { type: "object", properties: { id: { type: "string", format: "uuid" }, at: { type: "string", format: "date-time" } } };
    expect(JSON.stringify(example(schema))).toBe(JSON.stringify(example(schema)));
  });

  it("gives a bounded integer 0, not its lowest bound (every TypeSpec int32 is bounded to its type range)", () => {
    expect(example({
      type: "object",
      properties: {
        qty: { type: "integer", minimum: -2147483648, maximum: 2147483647 },
        big: { type: "integer", format: "int64", minimum: -9007199254740991, maximum: 9007199254740991 },
        capped: { type: "integer", maximum: 100 },
        ratio: { type: "number", minimum: -1, maximum: 1 },
      },
    })).toEqual({ qty: 0, big: 0, capped: 0, ratio: 0 });
  });

  it("still honours a bound that excludes 0, and leaves an unbounded number to the sampler", () => {
    expect(example({
      type: "object",
      properties: {
        page: { type: "integer", minimum: 1 },
        positive: { type: "number", exclusiveMinimum: 0 },
        legacy: { type: "integer", minimum: 0, exclusiveMinimum: true },
        count: { type: "integer" },
        score: { type: "number", format: "float" },
        pinned: { type: "integer", minimum: -5, maximum: 5, default: 3 },
      },
    })).toEqual({ page: 1, positive: 1, legacy: 1, count: 0, score: 0.1, pinned: 3 });
  });

  it("walks schema positions only: a property called `default` is a property, and numbers behind $ref / items get 0 too", () => {
    const value = example({
      type: "object",
      properties: { default: { type: "string" }, list: { type: "array", items: { $ref: "#/definitions/Small" } } },
      definitions: { Small: { type: "integer", minimum: -128, maximum: 127 } },
    }) as Record<string, unknown>;
    expect(value).toEqual({ default: "string", list: [0] });
  });

  it("leaves a read-only property out", () => {
    expect(example({
      type: "object",
      properties: { id: { type: "string", readOnly: true }, name: { type: "string" } },
    })).toEqual({ name: "string" });
  });

  it("follows a local $ref into definitions (the shape the pin schema has) and into $defs", () => {
    expect(example({
      type: "object",
      properties: { shipTo: { $ref: "#/definitions/Address" }, state: { $ref: "#/definitions/State" } },
      definitions: { Address: { type: "object", properties: { zip: { type: "string" } } }, State: { type: "string", enum: ["OPEN", "CLOSED"] } },
    })).toEqual({ shipTo: { zip: "string" }, state: "OPEN" });
    expect(example({
      type: "object",
      properties: { shipTo: { $ref: "#/$defs/Address" } },
      $defs: { Address: { type: "object", properties: { zip: { type: "string" } } } },
    })).toEqual({ shipTo: { zip: "string" } });
  });

  it("merges allOf and takes the first branch of oneOf / anyOf", () => {
    expect(example({
      allOf: [
        { type: "object", properties: { id: { type: "string" } } },
        { type: "object", properties: { qty: { type: "integer" } } },
      ],
    })).toEqual({ id: "string", qty: 0 });
    expect(example({ oneOf: [{ type: "string", enum: ["a"] }, { type: "integer" }] })).toBe("a");
  });

  it("stays bounded for a recursive schema: a node that contains itself ends after a level or two", () => {
    const schema: Schema = {
      $ref: "#/definitions/Node",
      definitions: {
        Node: { type: "object", properties: { name: { type: "string" }, children: { type: "array", items: { $ref: "#/definitions/Node" } }, parent: { $ref: "#/definitions/Node" } } },
      },
    };
    const value = example(schema);
    expect(JSON.stringify(value).length).toBeLessThan(2_000);
    expect(value).toMatchObject({ name: "string" });
  });

  it("stays bounded for a root that refers to itself with $ref: #", () => {
    const value = example({ type: "object", properties: { id: { type: "string" }, next: { $ref: "#" } } });
    expect(JSON.stringify(value).length).toBeLessThan(2_000);
    expect(value).toMatchObject({ id: "string" });
  });

  it("refuses, quickly, an array that must hold an enormous number of items (minItems), however it is spelled", () => {
    const refused = (schema: Schema) => {
      const started = Date.now();
      const result = exampleFromSchema(schema);
      expect(Date.now() - started, JSON.stringify(schema)).toBeLessThan(2_000);
      expect(failure(result), JSON.stringify(schema)).toMatchObject({ code: "EXAMPLE_TOO_LARGE" });
    };
    refused({ type: "array", items: { type: "string" }, minItems: 1_000_000_000 });
    refused({ type: "array", items: { type: "string" }, minItems: "1000000000" }); // the sampler coerces a string
    refused(JSON.parse('{ "type": "array", "items": { "type": "string" }, "minItems": 1e999 }') as Schema); // 1e999 is Infinity: the loop would never end
    refused({ type: "object", properties: { tags: { type: "array", items: { type: "string" }, minItems: 1_000_000_000 } } });
    refused({ type: "array", prefixItems: [{ type: "string" }], minItems: 1_000_000_000 }); // a tuple is padded up to minItems
    refused({ type: "array", contains: { type: "string" }, minItems: 1_000_000_000 }); // `contains` is sampled like `items`
    refused({ $ref: "#/definitions/List", definitions: { List: { type: "array", items: { type: "integer" }, minItems: 1_000_000_000 } } });
  });

  it("refuses minItems that multiply through nesting: 1000 x 1000 nested arrays, 100 x 100 x 100 of an object", () => {
    const started = Date.now();
    expect(failure(exampleFromSchema({
      type: "array", minItems: 1000, items: { type: "array", minItems: 1000, items: { type: "string" } },
    }))).toMatchObject({ code: "EXAMPLE_TOO_LARGE" });
    expect(failure(exampleFromSchema({
      type: "object",
      properties: {
        grid: { type: "array", minItems: 100, items: { type: "array", minItems: 100, items: { type: "array", minItems: 100, items: { type: "object", properties: { v: { type: "string" } } } } } },
      },
    }))).toMatchObject({ code: "EXAMPLE_TOO_LARGE" });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("still builds the array a schema asks for when it is within the budget: minItems copies, never more than maxItems", () => {
    expect(example({ type: "array", items: { type: "string" }, minItems: 3 })).toEqual(["string", "string", "string"]);
    expect(example({ type: "array", items: { type: "string" } })).toEqual(["string"]); // 1 by default
    expect(example({ type: "array", items: { type: "string" }, minItems: 5_000, maxItems: 2 })).toEqual(["string", "string"]);
    expect(example({ type: "array", prefixItems: [{ type: "integer" }, { type: "string" }], minItems: 4 })).toEqual([0, "string", null, null]);
    expect((example({ type: "array", items: { type: "string" }, minItems: 20_000 }) as unknown[]).length).toBe(20_000);
    // 100 x 100 is 10,000 values: allowed
    expect((example({ type: "array", minItems: 100, items: { type: "array", minItems: 100, items: { type: "string" } } }) as unknown[][]).flat()).toHaveLength(10_000);
  });

  it("refuses a schema whose definitions multiply into an enormous example", () => {
    // 40 definitions, each with four properties that all refer to the next one: the sampler stops 10 levels down, which is still 4^10 values.
    const definitions: Record<string, Schema> = {};
    for (let i = 0; i < 40; i++) {
      const next = { $ref: `#/definitions/D${i + 1}` };
      definitions[`D${i}`] = i === 39 ? { type: "string" } : { type: "object", properties: { a: next, b: next, c: next, d: next } };
    }
    const started = Date.now();
    const result = exampleFromSchema({ $ref: "#/definitions/D0", definitions });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(failure(result)).toMatchObject({ code: "EXAMPLE_TOO_LARGE" });
  });

  it("does NOT refuse a fan-out the sampler's own depth limit keeps small: two properties per level over 40 levels is about 2,000 values", () => {
    const definitions: Record<string, Schema> = {};
    for (let i = 0; i < 40; i++) {
      const next = { $ref: `#/definitions/D${i + 1}` };
      definitions[`D${i}`] = i === 39 ? { type: "string" } : { type: "object", properties: { a: next, b: next } };
    }
    const value = example({ $ref: "#/definitions/D0", definitions });
    expect(JSON.stringify(value).length).toBeLessThan(100_000);
    expect(JSON.stringify(value)).toContain('"a":{"a":{"a":');
  });

  it("refuses a doubling that no depth limit stops: two `allOf` entries per level over 40 levels", () => {
    const definitions: Record<string, Schema> = { D0: { type: "object", properties: { id: { type: "string" } } } };
    for (let i = 1; i <= 40; i++) definitions[`D${i}`] = { allOf: [{ $ref: `#/definitions/D${i - 1}` }, { $ref: `#/definitions/D${i - 1}` }] };
    const started = Date.now();
    expect(failure(exampleFromSchema({ $ref: "#/definitions/D40", definitions }))).toMatchObject({ code: "EXAMPLE_TOO_LARGE" });
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("copes with a payload of a thousand properties", () => {
    const properties: Record<string, Schema> = {};
    for (let i = 0; i < 1000; i++) properties[`field${i}`] = { type: i % 2 === 0 ? "string" : "integer" };
    const value = example({ type: "object", properties }) as Record<string, unknown>;
    expect(Object.keys(value)).toHaveLength(1000);
    expect(value.field0).toBe("string");
    expect(value.field1).toBe(0);
  });

  it("answers an error Result, never a throw, for a schema that is not usable", () => {
    for (const bad of [null, undefined, "string", 5, [], [{ type: "string" }]]) {
      expect(failure(exampleFromSchema(bad as unknown as Schema)), JSON.stringify(bad)).toMatchObject({ code: "VALIDATION_ERROR" });
    }
    // a $ref that goes nowhere, a malformed percent escape, a non-object `properties`
    expect(failure(exampleFromSchema({ type: "object", properties: { a: { $ref: "#/definitions/Missing" } } }))).toMatchObject({ code: "EXAMPLE_FAILED" });
    expect(failure(exampleFromSchema({ type: "object", properties: { a: { $ref: "#/definitions/%E0%A4%A" } }, definitions: {} }))).toMatchObject({ code: "EXAMPLE_FAILED" });
    expect(failure(exampleFromSchema({ type: "object", properties: null }))).toMatchObject({ code: "EXAMPLE_FAILED" });
    expect(failure(exampleFromSchema({ $ref: "http://example.com/other.json" }))).toMatchObject({ code: "EXAMPLE_FAILED" });
  });

  it("does not mutate the schema it is given", () => {
    const schema: Schema = { type: "object", properties: { a: { type: "string", enum: ["x"] } }, definitions: {} };
    const before = JSON.stringify(schema);
    example(schema);
    expect(JSON.stringify(schema)).toBe(before);
  });
});

describe("exampleFromSchema: a hostile schema is refused before the sampler builds anything", () => {
  beforeEach(() => {
    vi.mocked(sample).mockClear();
  });

  /** Refused with EXAMPLE_TOO_LARGE in under a second, the sampler never called. */
  function refused(schema: Schema, label = JSON.stringify(schema).slice(0, 120)): void {
    const started = performance.now();
    const result = exampleFromSchema(schema);
    expect(performance.now() - started, label).toBeLessThan(1_000);
    expect(failure(result), label).toMatchObject({ code: "EXAMPLE_TOO_LARGE" });
    expect(sample, label).not.toHaveBeenCalled();
  }

  it("refuses a minLength of 100 million (a 100M-character string), alone or nested", () => {
    refused({ type: "string", minLength: 1e8 });
    refused({ type: "object", properties: { name: { type: "string", minLength: 1e8 } } });
    refused({ type: "string", minLength: "100000000" }); // the sampler coerces a string
  });

  it("refuses the reviewer's case: a minItems that sits under `if`, which the sampler merges into the array", () => {
    refused({ type: "array", items: { type: "string" }, if: { minItems: 3e7 }, then: {} });
  });

  const keywords: Record<string, number> = { minLength: 100_001, minItems: 100_001, minProperties: 100_001 };
  const positions: Record<string, (inner: Schema) => Schema> = {
    "the root": (inner) => inner,
    properties: (inner) => ({ type: "object", properties: { a: inner } }),
    items: (inner) => ({ type: "array", items: inner }),
    additionalProperties: (inner) => ({ type: "object", additionalProperties: inner }),
    patternProperties: (inner) => ({ type: "object", patternProperties: { "^a": inner } }),
    allOf: (inner) => ({ allOf: [{ type: "object" }, inner] }),
    anyOf: (inner) => ({ anyOf: [inner] }),
    oneOf: (inner) => ({ oneOf: [inner] }),
    not: (inner) => ({ not: inner }),
    if: (inner) => ({ type: "array", items: { type: "string" }, if: inner, then: {} }),
    then: (inner) => ({ type: "array", items: { type: "string" }, if: {}, then: inner }),
    else: (inner) => ({ type: "array", items: { type: "string" }, if: {}, then: {}, else: inner }),
    $defs: (inner) => ({ $ref: "#/$defs/Big", $defs: { Big: inner } }),
    definitions: (inner) => ({ $ref: "#/definitions/Big", definitions: { Big: inner } }),
  };

  it("refuses a size keyword over 100,000 wherever it sits in the schema tree", () => {
    for (const [keyword, value] of Object.entries(keywords)) {
      for (const [where, place] of Object.entries(positions)) refused(place({ [keyword]: value }), `${keyword} under ${where}`);
    }
  });

  it("does not refuse at the limit itself: a minLength of exactly 100,000 is a 100,000-character string", () => {
    expect((example({ type: "string", minLength: 100_000 }) as string).length).toBe(100_000);
  });

  it("counts if / then like the sampler does: sizes under the limit that multiply through `if` / `then`", () => {
    const level = (inner: Schema): Schema => ({ type: "array", items: inner, if: { minItems: 90_000 }, then: {} });
    refused(level(level(level({ type: "string" }))));
    const thenLevel = (inner: Schema): Schema => ({ type: "array", if: { type: "array" }, then: { minItems: 90_000, items: inner } });
    refused(thenLevel(thenLevel({ type: "string" })));
  });

  it("counts additionalProperties twice per level: 8 levels over minItems 20,000", () => {
    let schema: Schema = { type: "array", items: { type: "string" }, minItems: 20_000 };
    for (let level = 0; level < 8; level++) schema = { type: "object", additionalProperties: schema };
    refused(schema);
  });

  it("counts long strings and long copied values by their length: they add up", () => {
    const properties: Record<string, Schema> = {};
    for (let i = 0; i < 40; i++) properties[`p${i}`] = { type: "string", minLength: 100_000 };
    refused({ type: "object", properties }, "40 strings of 100,000 characters");
    // one 50,000-character default, used through 2,000 references
    const uses: Record<string, Schema> = {};
    for (let i = 0; i < 2_000; i++) uses[`p${i}`] = { $ref: "#/definitions/Long" };
    refused({ type: "object", properties: uses, definitions: { Long: { type: "string", default: "x".repeat(50_000) } } }, "a long default used 2,000 times");
  });

  it("refuses an example whose text would be over 1 MiB, after building it (it passes the gate: 15 strings of 100,000 characters)", () => {
    const properties: Record<string, Schema> = {};
    for (let i = 0; i < 15; i++) properties[`p${i}`] = { type: "string", minLength: 100_000 };
    const result = exampleFromSchema({ type: "object", properties });
    expect(failure(result)).toMatchObject({ code: "EXAMPLE_TOO_LARGE", message: expect.stringContaining("1 MiB") });
    expect(sample).toHaveBeenCalledTimes(1);
  });

  it("still generates what a real schema asks for: minItems 1,000, minLength 255, and the usual huge maximums", () => {
    const value = example({
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" }, minItems: 1_000 },
        code: { type: "string", minLength: 255 },
        note: { type: "string", maxLength: 1_048_576 },
        log: { type: "array", items: { type: "string" }, maxItems: 1_000_000 },
        minItems: { type: "integer" }, // a property called like a keyword
        sample: { type: "object", default: { minLength: 1e9 } }, // data, not a keyword
      },
    }) as Record<string, unknown>;
    expect(value.tags).toHaveLength(1_000);
    expect((value.code as string).length).toBe(255);
    expect(value.note).toBe("string");
    expect(value.log).toEqual(["string"]);
    expect(value.minItems).toBe(0);
    expect(value.sample).toEqual({ minLength: 1e9 });
  });
});

// The gate and the sampler used to read a schema differently, so a schema could be small to the one and enormous to the other. Now the
// schema is INLINED first (every `$ref` followed by our resolver, `if` / `then` merged until none is left, sizes counted while expanding),
// and the sampler only ever sees that copy. Each shape below got through the old gate (measured: 84 MB - 1.3 GB, 0.5 - 3.4 s).
describe("exampleFromSchema: shapes the sampler reads differently from a gate that counted the original", () => {
  beforeEach(() => {
    vi.mocked(sample).mockClear();
  });

  /** Refused with `code` in under 200 ms, the sampler never called. */
  function refusedAs(code: "EXAMPLE_TOO_LARGE" | "EXAMPLE_FAILED", schema: Schema, label: string): void {
    const started = performance.now();
    const result = exampleFromSchema(schema);
    expect(performance.now() - started, label).toBeLessThan(200);
    expect(failure(result), label).toMatchObject({ code });
    expect(sample, label).not.toHaveBeenCalled();
  }
  /** A definition of 90,000 strings (under the literal limit): cheap to write, a real cost for whoever builds it. */
  const list = (): Schema => ({ type: "array", items: { type: "string" }, minItems: 90_000 });

  it("nested if / then: `then: { if: {}, then: { minItems: 400 } }` on three nested levels (400 x 400 x 400 items)", () => {
    const level = (inner: Schema): Schema => ({ type: "array", items: inner, if: {}, then: { if: {}, then: { minItems: 400 } } });
    refusedAs("EXAMPLE_TOO_LARGE", level(level(level({ type: "string" }))), "three levels");
    // one level on its own is a plain 400-item array and is fine
    expect(example(level({ type: "string" }))).toHaveLength(400);
  });

  it("a `$ref` written as a one-element list (the sampler follows it, the old gate did not)", () => {
    refusedAs("EXAMPLE_FAILED", { type: "object", properties: { big: { $ref: ["#/definitions/L"] } }, definitions: { L: list() } }, "array $ref");
  });

  it("a `$ref` without a leading # (the sampler resolves it, the old resolver found nothing and counted 1)", () => {
    refusedAs("EXAMPLE_FAILED", { type: "object", properties: { big: { $ref: "/definitions/L" } }, definitions: { L: list() } }, "ref without #");
    refusedAs("EXAMPLE_FAILED", { type: "object", properties: { big: { $ref: "%23/definitions/L" } }, definitions: { L: list() } }, "encoded #");
    refusedAs("EXAMPLE_FAILED", { type: "object", properties: { big: { $ref: { x: 1 } } }, definitions: {} }, "object $ref");
  });

  it("`properties` as a list of schemas (the sampler iterates it, the old gate skipped it)", () => {
    const properties = Array.from({ length: 10 }, () => ({ $ref: "#/definitions/L" }));
    refusedAs("EXAMPLE_FAILED", { type: "object", properties, definitions: { L: list() } } as unknown as Schema, "array properties");
    refusedAs("EXAMPLE_FAILED", { type: "object", properties: null } as unknown as Schema, "null properties");
    refusedAs("EXAMPLE_FAILED", { type: "object", properties: { a: { type: "object", additionalProperties: [{ $ref: "#/definitions/L" }] } }, definitions: { L: list() } } as unknown as Schema, "array additionalProperties");
    refusedAs("EXAMPLE_FAILED", { type: "array", items: "#/definitions/L", definitions: { L: list() } } as unknown as Schema, "string items");
  });

  it("an alias used while its target is being followed: R = $ref A, A.back = $ref R, 1,000 uses of R over 5,000 properties", () => {
    const properties: Record<string, Schema> = { back: { $ref: "#/definitions/R" } };
    for (let i = 0; i < 5_000; i++) properties[`p${i}`] = { type: "string" };
    const used: Record<string, Schema> = { x: { $ref: "#/definitions/A" } };
    for (let i = 0; i < 1_000; i++) used[`u${i}`] = { $ref: "#/definitions/R" };
    refusedAs("EXAMPLE_TOO_LARGE", {
      type: "object", properties: used,
      definitions: { R: { $ref: "#/definitions/A" }, A: { type: "object", properties } },
    }, "poisoned alias memo");
  });

  it("an alias chain that leads back to itself ends, and a cycle through allOf does too", () => {
    expect(example({ properties: { a: { $ref: "#/definitions/R1" } }, definitions: { R1: { $ref: "#/definitions/R2" }, R2: { $ref: "#/definitions/R1" } } })).toEqual({});
    expect(JSON.stringify(example({
      type: "object", properties: { n: { $ref: "#/definitions/N" } },
      definitions: { N: { allOf: [{ type: "object", properties: { next: { $ref: "#/definitions/N" }, id: { type: "string" } } }] } },
    })).length).toBeLessThan(500);
  });

  it("a wide schema that fans out through $ref is counted per use while it is inlined, and stops at the budget", () => {
    const definitions: Record<string, Schema> = { D0: { type: "string" } };
    for (let i = 1; i <= 30; i++) {
      const previous = { $ref: `#/definitions/D${i - 1}` };
      definitions[`D${i}`] = { type: "object", properties: { a: previous, b: previous, c: previous } };
    }
    refusedAs("EXAMPLE_TOO_LARGE", { $ref: "#/definitions/D30", definitions }, "3^10 fan-out");
    // what the sampler never visits is not inlined, so it is not counted: an array that holds nothing, over the same fan-out, is just empty
    const started = performance.now();
    expect(example({ type: "array", maxItems: 0, items: { $ref: "#/definitions/D30" }, definitions })).toEqual([]);
    expect(example({ type: "string", properties: { a: { $ref: "#/definitions/D30" } }, definitions })).toBe("string");
    expect(performance.now() - started).toBeLessThan(200);
  });

  it("still generates what real schemas ask for", () => {
    const properties: Record<string, Schema> = {};
    for (let i = 0; i < 300; i++) properties[`field${i}`] = { type: i % 3 === 0 ? "string" : i % 3 === 1 ? "integer" : "boolean" };
    expect(Object.keys(example({ type: "object", properties }) as object)).toHaveLength(300);

    const value = example({
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" }, minItems: 1_000 },
        code: { type: "string", minLength: 255 },
        note: { type: "string", maxLength: 1_048_576 },
        log: { type: "array", items: { type: "string" }, maxItems: 1_000_000 },
        kind: { type: "string", enum: Array.from({ length: 500 }, (_, i) => `K${i}`) },
        home: { $ref: "#/definitions/Address" }, work: { $ref: "#/definitions/Address" }, other: { type: "array", items: { $ref: "#/definitions/Address" } },
      },
      definitions: { Address: { type: "object", properties: { zip: { type: "string" } } } },
    }) as Record<string, unknown>;
    expect(value.tags).toHaveLength(1_000);
    expect((value.code as string).length).toBe(255);
    expect(value.note).toBe("string");
    expect(value.log).toEqual(["string"]);
    expect(value.kind).toBe("K0");
    expect([value.home, value.work, value.other]).toEqual([{ zip: "string" }, { zip: "string" }, [{ zip: "string" }]]);
  });

  it("a recursive tree is cut where it leads back to itself, through properties, items, allOf and oneOf", () => {
    expect(example({
      $ref: "#/definitions/Tree",
      definitions: { Tree: { type: "object", properties: { value: { type: "string" }, left: { $ref: "#/definitions/Tree" }, kids: { type: "array", items: { $ref: "#/definitions/Tree" } } } } },
    })).toEqual({ value: "string", left: {}, kids: [{}] });
    expect(example({
      type: "object", properties: { node: { $ref: "#/definitions/N" } },
      definitions: { N: { oneOf: [{ type: "object", properties: { id: { type: "string" }, next: { $ref: "#/definitions/N" } } }, { type: "null" }] } },
    })).toEqual({ node: { id: "string" } });
  });

  it("merges allOf and oneOf the way the sampler does, and if / then with a small minItems", () => {
    expect(example({
      allOf: [{ $ref: "#/definitions/Base" }, { type: "object", properties: { extra: { type: "integer" } } }],
      definitions: { Base: { type: "object", properties: { id: { type: "string" } } } },
    })).toEqual({ id: "string", extra: 0 });
    expect(example({
      type: "object", properties: { v: { oneOf: [{ $ref: "#/definitions/Str" }, { type: "integer" }] } }, definitions: { Str: { type: "string", enum: ["a"] } },
    })).toEqual({ v: "a" });
    expect(example({ type: "array", items: { type: "string" }, if: { minItems: 2 }, then: { minItems: 3 } })).toEqual(["string", "string", "string"]);
    expect(example({
      type: "object", properties: { a: { type: "string" } },
      if: { properties: { a: { const: "x" } } }, then: { properties: { b: { type: "array", items: { type: "integer" }, minItems: 2 } } }, else: { properties: { c: { type: "string" } } },
    })).toEqual({ a: "x", b: [0, 0] });
  });
});

// Every unit of work of the copy is paid for before it is done, and the weight of what the sampler would build counts the TEXT of names.
// Each hostile shape below got past round 2 (measured there: up to 43 s, 1.3 GB, one a V8 out-of-memory abort).
describe("exampleFromSchema: work and names are charged to the budget before they are done", () => {
  beforeEach(() => {
    vi.mocked(sample).mockClear();
  });

  /** Refused with EXAMPLE_TOO_LARGE inside `ms`, the sampler never called. */
  function refusedFast(schema: Schema, label: string, ms = 200): void {
    const started = performance.now();
    const result = exampleFromSchema(schema);
    expect(performance.now() - started, label).toBeLessThan(ms);
    expect(failure(result), label).toMatchObject({ code: "EXAMPLE_TOO_LARGE" });
    expect(sample, label).not.toHaveBeenCalled();
  }
  const entries = (count: number, value: () => unknown, prefix = "p"): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < count; i++) out[`${prefix}${i}`] = value();
    return out;
  };
  const refs = (count: number, to = "#/definitions/A"): Record<string, Schema> => entries(count, () => ({ $ref: to }), "u") as Record<string, Schema>;
  const used = (count: number, definition: Schema): Schema => ({ type: "object", properties: refs(count), definitions: { A: definition } });

  it("`true` properties: 2,000 of them used through 4,000 references (a boolean is a unit of work like any schema)", () => {
    refusedFast(used(4_000, { type: "object", properties: entries(2_000, () => true) }), "2,000 true x 4,000 refs");
  });

  it("100,000 `true` properties used through 1,000 references: refused at once, not built (it was 32 s and an out-of-memory abort)", () => {
    refusedFast(used(1_000, { type: "object", properties: entries(100_000, () => true) }), "100,000 true x 1,000 refs", 500);
  });

  it("an `allOf` of 2,000 `true` and a tuple of 2,000 `false`, each used through 4,000 references", () => {
    refusedFast(used(4_000, { allOf: Array.from({ length: 2_000 }, () => true) }), "allOf of true");
    refusedFast(used(4_000, { type: "array", items: Array.from({ length: 2_000 }, () => false) }), "tuple of false");
    refusedFast(used(4_000, { type: "array", prefixItems: Array.from({ length: 2_000 }, () => null) }), "tuple of null");
  });

  it("a node of 100,000 `x-` keys under `allOf` / `oneOf` / `anyOf` / `if`, used through 1,000 references, costs what a node costs, whatever its width", () => {
    const wide = (n: number): Record<string, unknown> => entries(n, () => 1, "x-");
    for (const [label, host] of [
      ["allOf", { allOf: [{}] }], ["oneOf", { oneOf: [{}] }], ["anyOf", { anyOf: [{}] }], ["if / then", { type: "object", if: {}, then: { properties: { a: { type: "string" } } } }],
    ] as const) {
      const schema = used(1_000, { ...host, ...wide(100_000) });
      const started = performance.now();
      const result = exampleFromSchema(schema);
      expect(performance.now() - started, label).toBeLessThan(500); // it was 43.6 s, with the sampler running
      expect(result.success, label).toBe(true);
      if (result.success) expect(Object.keys(result.data as object), label).toHaveLength(1_000);
    }
    // the same with fewer keys and more uses
    const started = performance.now();
    expect(exampleFromSchema(used(4_000, { allOf: [{}], ...wide(1_000) })).success).toBe(true);
    expect(exampleFromSchema(used(1_000, { allOf: [{}], ...wide(5_000) })).success).toBe(true);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("a property name of a million characters through 1,000 uses, one of 100 KB through 4,000, and an additionalProperties name of a million at the deepest of nine", () => {
    refusedFast(used(1_000, { type: "object", properties: { ["n".repeat(1 << 20)]: { type: "string" } } }), "1 MiB name x 1,000");
    refusedFast(used(4_000, { type: "object", properties: { ["n".repeat(100_000)]: { type: "string" } } }), "100 KB name x 4,000");
    let deepest: Schema = { type: "string", "x-additionalPropertiesName": "n".repeat(1 << 20) };
    for (let level = 0; level < 9; level++) deepest = { type: "object", additionalProperties: deepest };
    refusedFast(deepest, "x-additionalPropertiesName 1 MiB at the deepest of nine");
  });

  it("still generates what real schemas look like: 30 `x-` keys on a node, 300 properties, 100 properties with 50-character names, a 1,000-character name once", () => {
    expect(example({ type: "object", properties: { a: { type: "string", ...entries(30, () => ({ any: "thing" }), "x-") } }, ...entries(30, () => 1, "x-") })).toEqual({ a: "string" });
    expect(Object.keys(example({ type: "object", properties: entries(300, () => ({ type: "string" })) }) as object)).toHaveLength(300);
    const named: Record<string, Schema> = {};
    for (let i = 0; i < 100; i++) named[`${"p".repeat(48)}${String(i).padStart(2, "0")}`] = { type: "integer" };
    expect(Object.keys(example({ type: "object", properties: named }) as object)).toHaveLength(100);
    expect(Object.keys(example({ type: "object", properties: { ["long".repeat(250)]: { type: "string" } } }) as object)).toEqual(["long".repeat(250)]);
    // a name on `additionalProperties` that is only a few characters
    expect(example({ type: "object", additionalProperties: { type: "string", "x-additionalPropertiesName": "key" } })).toEqual({ key1: "string", key2: "string" });
    expect(failure(exampleFromSchema({ type: "object", additionalProperties: { type: "string", "x-additionalPropertiesName": { not: "text" } } }))).toMatchObject({ code: "EXAMPLE_FAILED" });
  });

  it("answers a schema nested thousands of levels deep with a plain message, not the engine's", () => {
    let schema: Schema = { type: "string" };
    for (let level = 0; level < 20_000; level++) schema = { type: "object", properties: { a: schema } };
    const result = exampleFromSchema(schema);
    expect(failure(result)).toEqual({ code: "EXAMPLE_FAILED", message: "This schema is nested too deeply to generate an example from." });
  });
});

// The sampler builds a lookup from `required` for EVERY object that has `properties` (and walks the list again for `maxProperties`), and the
// copy shares one list across every use, so a long list reused through many references was real work nobody paid for (measured on the
// sampler: 24,999 names x 300 / 1,000 / 3,000 uses 0.45 / 1.4 / 4.3 s, 100,000 names x 1,000 uses 6.7 s and +221 MB). Each use is charged
// ceil(names / 64) units (twice with `maxProperties`) before the sampler runs.
describe("exampleFromSchema: the sampler's walk of a `required` list is charged to the budget, per use", () => {
  beforeEach(() => {
    vi.mocked(sample).mockClear();
  });

  /** Refused with EXAMPLE_TOO_LARGE inside 200 ms, the sampler never called. */
  function refusedFast(schema: Schema, label: string): void {
    const started = performance.now();
    const result = exampleFromSchema(schema);
    expect(performance.now() - started, label).toBeLessThan(200);
    expect(failure(result), label).toMatchObject({ code: "EXAMPLE_TOO_LARGE" });
    expect(sample, label).not.toHaveBeenCalled();
  }
  const names = (count: number): string[] => Array.from({ length: count }, (_, i) => `r${i}`);
  /** An object of one property per use of the definition `A`. */
  const uses = (count: number): Record<string, Schema> => Object.fromEntries(Array.from({ length: count }, (_, i) => [`u${i}`, { $ref: "#/definitions/A" }]));
  /** `uses` references to a definition that has `properties` and a `required` list of `count` names. */
  const reused = (useCount: number, count: number, definition: Schema = {}): Schema => ({
    type: "object",
    properties: uses(useCount),
    definitions: { A: { type: "object", properties: { a: { type: "string" } }, required: names(count), ...definition } },
  });

  it("24,999 names reused through 3,000 references: refused at once, not walked 3,000 times (the sampler took 4.3 s)", () => {
    refusedFast(reused(3_000, 24_999), "24,999 names x 3,000 uses");
  });

  it("24,999 names reused through 300 references (0.45 s of the sampler)", () => {
    refusedFast(reused(300, 24_999), "24,999 names x 300 uses");
  });

  it("100,000 names reused through 1,000 references (6.7 s and 221 MB of the sampler)", () => {
    refusedFast(reused(1_000, 100_000), "100,000 names x 1,000 uses");
  });

  it("the list is charged wherever the sampler reads it, also on a node of an `allOf`", () => {
    refusedFast(reused(1_000, 0, { allOf: [{ type: "object", properties: { b: { type: "string" } }, required: names(24_999) }] }), "allOf entry");
  });

  it("`maxProperties` makes the sampler walk the list a second time, so it is charged twice", () => {
    // 200 uses x 75 units (4,800 names) = 15,000 and the 600 of the schema itself: within the budget once, over it twice
    const fits = exampleFromSchema(reused(200, 4_800));
    expect(fits.success).toBe(true);
    expect(sample).toHaveBeenCalledTimes(1);
    vi.mocked(sample).mockClear();
    refusedFast(reused(200, 4_800, { maxProperties: 5 }), "4,800 names x 200 uses with maxProperties");
  });

  it("still generates what real schemas look like: 50 names x 3,000 uses, 1,000 names x 100 uses, 5,000 names on one object", () => {
    for (const [useCount, count] of [[3_000, 50], [100, 1_000]] as const) {
      const value = example(reused(useCount, count)) as Record<string, unknown>;
      expect(Object.keys(value), `${count} names x ${useCount} uses`).toHaveLength(useCount);
      expect(value.u0).toEqual({ a: "string" });
    }
    const single = example({ type: "object", properties: { a: { type: "string" }, b: { type: "integer" } }, required: names(5_000) });
    expect(single).toEqual({ a: "string", b: 0 });
    expect(example({ type: "object", properties: { a: { type: "string" }, b: { type: "integer" } }, required: ["b"], maxProperties: 1 })).toEqual({ b: 0 });
  });

  it("charges nothing where the sampler reads nothing: a list on a node with no `properties`, or one that is not a list", () => {
    const value = example({
      type: "object",
      properties: uses(3_000),
      definitions: { A: { type: "object", required: names(24_999) } },
    }) as Record<string, unknown>;
    expect(Object.keys(value)).toHaveLength(3_000);
    expect(Object.keys(example(reused(3_000, 0, { required: "not a list" })) as object)).toHaveLength(3_000);
  });
});

// The combinations the sampler handles on ONE node, as real schemas write them: each must give exactly what the sampler gives for the schema as written.
describe("exampleFromSchema: allOf with oneOf / anyOf / if-then on one node, and references that bring their own example", () => {
  beforeEach(() => {
    vi.mocked(sample).mockClear();
  });
  const OPTIONS = { skipReadOnly: true, quiet: true, maxSampleDepth: 10 };
  /** The example, which must be what the sampler gives for the same schema (with its `$ref`s), and which is returned. */
  function sameAsSampler(schema: Schema): unknown {
    const mine = example(schema);
    const theirs = JSON.parse(JSON.stringify(sample(schema as never, OPTIONS, schema))) as unknown;
    expect(mine).toEqual(theirs);
    return mine;
  }

  it("an envelope by allOf with its variants by oneOf (and by anyOf)", () => {
    const definitions = {
      Base: { type: "object", properties: { id: { type: "string" }, kind: { type: "string", enum: ["a", "b"] } } },
      A: { type: "object", properties: { a: { type: "integer" } } },
      B: { type: "object", properties: { b: { type: "string" } } },
    };
    const byOneOf = sameAsSampler({ allOf: [{ $ref: "#/definitions/Base" }], oneOf: [{ $ref: "#/definitions/A" }, { $ref: "#/definitions/B" }], definitions });
    expect(byOneOf).toEqual({ id: "string", kind: "a", a: 0 });
    expect(sameAsSampler({ allOf: [{ $ref: "#/definitions/Base" }], anyOf: [{ $ref: "#/definitions/B" }, { $ref: "#/definitions/A" }], definitions })).toEqual({ id: "string", kind: "a", b: "string" });
    // nested in a property, and all three on one node
    expect(sameAsSampler({ type: "object", properties: { event: { allOf: [{ $ref: "#/definitions/Base" }], oneOf: [{ $ref: "#/definitions/A" }] } }, definitions })).toEqual({ event: { id: "string", kind: "a", a: 0 } });
    sameAsSampler({ type: "object", allOf: [{ $ref: "#/definitions/Base" }], oneOf: [{ $ref: "#/definitions/A" }], anyOf: [{ $ref: "#/definitions/B" }], definitions });
  });

  it("allOf with an if / then on the same node, and oneOf with an if / then", () => {
    expect(sameAsSampler({
      allOf: [{ type: "object", properties: { a: { type: "string" } } }],
      if: { properties: { a: { const: "x" } } }, then: { properties: { b: { type: "string" } } },
    })).toEqual({ a: "string", b: "string" });
    expect(sameAsSampler({
      oneOf: [{ type: "object", properties: { a: { type: "string" } } }],
      if: { properties: { a: { const: "x" } } }, then: { properties: { b: { type: "string" } } },
    })).toEqual({ b: "string", a: "string" });
    sameAsSampler({ type: "object", properties: { x: { type: "integer" } }, allOf: [{ properties: { y: { type: "string" } } }], oneOf: [{ properties: { z: { type: "string" } } }], if: {}, then: { required: ["x"] } });
  });

  it("a reference to a definition with its own example, const, allOf or oneOf, in a property, an entry and a variant", () => {
    const definitions = {
      E: { type: "string", example: "from-ref" },
      C: { const: "fixed" },
      All: { allOf: [{ type: "object", properties: { a: { type: "string" } } }, { properties: { b: { type: "integer" } } }] },
      One: { oneOf: [{ type: "object", properties: { c: { type: "string" } } }, { type: "string" }] },
    };
    expect(sameAsSampler({ type: "object", properties: { e: { $ref: "#/definitions/E" }, c: { $ref: "#/definitions/C" }, all: { $ref: "#/definitions/All" }, one: { $ref: "#/definitions/One" } }, definitions }))
      .toEqual({ e: "from-ref", c: "fixed", all: { a: "string", b: 0 }, one: { c: "string" } });
    sameAsSampler({ allOf: [{ $ref: "#/definitions/All" }, { $ref: "#/definitions/E" }, { $ref: "#/definitions/C" }], definitions });
    sameAsSampler({ type: "object", properties: { v: { oneOf: [{ $ref: "#/definitions/E" }, { $ref: "#/definitions/One" }] } }, allOf: [{ $ref: "#/definitions/One" }], definitions });
  });

  it("a stripe-style event: envelope, variants, nested objects, enums, read-only fields", () => {
    sameAsSampler({
      title: "ChargeCreated",
      allOf: [{ $ref: "#/definitions/Envelope" }, { type: "object", properties: { data: { type: "object", properties: { object: { $ref: "#/definitions/Charge" } }, required: ["object"] } }, required: ["data"] }],
      definitions: {
        Envelope: { type: "object", required: ["id", "type"], properties: { id: { type: "string", examples: ["evt_1"] }, type: { const: "charge.succeeded" }, livemode: { type: "boolean" } } },
        Charge: { allOf: [{ $ref: "#/definitions/Resource" }], oneOf: [{ $ref: "#/definitions/Card" }, { $ref: "#/definitions/Bank" }], properties: { amount: { type: "integer" } }, discriminator: { propertyName: "object" } },
        Resource: { type: "object", properties: { id: { type: "string", readOnly: true }, created: { type: "integer" } } },
        Card: { type: "object", properties: { last4: { type: "string", minLength: 4, maxLength: 4 } } },
        Bank: { type: "object", properties: { routing: { type: "string" } } },
      },
    });
  });

  it("refuses by name what it cannot reproduce: an if / then that brings its own value next to oneOf / anyOf / allOf", () => {
    const broughtIn = failure(exampleFromSchema({ oneOf: [{ type: "object" }], if: {}, then: { const: "c" } }));
    expect(broughtIn).toMatchObject({ code: "EXAMPLE_FAILED", message: expect.stringContaining("`oneOf` on a node whose `if` / `then` or `$ref` brings a `const`, `enum`, `examples` or `default` of its own") });
    expect(failure(exampleFromSchema({ allOf: [{ type: "object" }], if: {}, then: { example: 3 } }))).toMatchObject({ message: expect.stringContaining("`allOf` on a node whose `if` / `then` or `$ref` brings an `example` of its own") });
  });
});
