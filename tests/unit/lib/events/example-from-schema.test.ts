import { describe, expect, it } from "vitest";
import { exampleFromSchema } from "@/lib/events/example-from-schema";
import type { Result } from "@/types/result";

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
    expect(example({ type: "array", items: { type: "string" }, minItems: 1_000_000_000, maxItems: 2 })).toEqual(["string", "string"]);
    expect(example({ type: "array", prefixItems: [{ type: "integer" }, { type: "string" }], minItems: 4 })).toEqual([0, "string", null, null]);
    expect((example({ type: "array", items: { type: "string" }, minItems: 20_000 }) as unknown[]).length).toBe(20_000);
    // 100 x 100 is 10,000 values: allowed
    expect((example({ type: "array", minItems: 100, items: { type: "array", minItems: 100, items: { type: "string" } } }) as unknown[][]).flat()).toHaveLength(10_000);
  });

  it("refuses a schema whose definitions multiply into an enormous example", () => {
    // 40 definitions, each with two properties that both refer to the next one: 2^40 values if every reference were followed.
    const definitions: Record<string, Schema> = {};
    for (let i = 0; i < 40; i++) {
      definitions[`D${i}`] = i === 39
        ? { type: "string" }
        : { type: "object", properties: { a: { $ref: `#/definitions/D${i + 1}` }, b: { $ref: `#/definitions/D${i + 1}` } } };
    }
    const started = Date.now();
    const result = exampleFromSchema({ $ref: "#/definitions/D0", definitions });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(failure(result)).toMatchObject({ code: "EXAMPLE_TOO_LARGE" });
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
