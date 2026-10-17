import { describe, expect, it } from "vitest";
import { resolveLocalRefs, type ExtractedPayload } from "@/lib/events/import";
import {
  MAX_EXPANDED_DOCUMENT_BYTES, MAX_FIELDS_PER_ENTITY, MAX_FIELDS_PER_IMPORT, MAX_IMPORT_ENTITIES, MAX_IMPORT_PAYLOADS, MAX_JSON_PAYLOAD_BYTES,
  MAX_PROTOBUF_PAYLOAD_BYTES, MAX_TOTAL_PAYLOAD_BYTES, MAX_TOTAL_PROTOBUF_BYTES, boundText, checkExpandedSize, checkPayloadLimits, checkPlanLimits,
  expandedSizeUpTo, sizeUpTo, type PlanShape,
} from "@/services/events/import-limits";

// The bounds of the AsyncAPI import (WP-I2 fix round 1): every cap at its boundary, exactly at the cap = fine, one over = refused.
// Pure functions, so these are instant; the end-to-end refusals (nothing created, importers not called) are in the integration test.

const json = (value: unknown, messageKey = "m", role: "payload" | "headers" = "payload"): ExtractedPayload =>
  ({ messageKey, role, sourcePointer: `/components/messages/${messageKey}/${role}`, format: "json-schema", raw: value, suggestedName: "M" });
const proto = (source: string, messageKey = "m"): ExtractedPayload =>
  ({ messageKey, role: "payload", sourcePointer: `/components/messages/${messageKey}/payload`, format: "protobuf", raw: source, suggestedName: "M" });
const avro = (value: unknown): ExtractedPayload => ({ ...json(value), format: "avro" });

/** A JSON Schema object whose JSON text is EXACTLY `bytes` long (a description pads it). */
function schemaOfSize(bytes: number): Record<string, unknown> {
  const frame = JSON.stringify({ type: "object", description: "" }).length;
  const schema = { type: "object", description: "x".repeat(bytes - frame) };
  expect(JSON.stringify(schema).length).toBe(bytes);
  return schema;
}
const failureOf = (result: ReturnType<typeof checkPayloadLimits>) => (result.success ? null : result.error);

describe("the limits are the ones the review asked for", () => {
  it("names them in one place", () => {
    expect([MAX_IMPORT_ENTITIES, MAX_IMPORT_PAYLOADS]).toEqual([500, 500]);
    expect([MAX_JSON_PAYLOAD_BYTES, MAX_PROTOBUF_PAYLOAD_BYTES, MAX_TOTAL_PAYLOAD_BYTES]).toEqual([256 * 1024, 64 * 1024, 2 * 1024 * 1024]);
    expect([MAX_FIELDS_PER_ENTITY, MAX_FIELDS_PER_IMPORT]).toEqual([2_000, 10_000]);
    expect(MAX_TOTAL_PROTOBUF_BYTES).toBe(96 * 1024);
    expect(MAX_EXPANDED_DOCUMENT_BYTES).toBe(4 * 1024 * 1024);
  });
});

describe("sizeUpTo", () => {
  it("is the length of the JSON text for plain values, and the length of a string (Protobuf source)", () => {
    for (const value of [{}, [], { a: 1 }, [1, 2, 3], { a: [{ b: "text" }, null, true], c: { d: -1.5 } }, "x".repeat(40), [[], {}], { "": 0 }]) {
      const expected = typeof value === "string" ? value.length : JSON.stringify(value).length;
      expect(sizeUpTo(value, Number.MAX_SAFE_INTEGER), JSON.stringify(value)).toBe(expected);
    }
  });

  it("stops counting once the limit is passed, so a huge value costs about `limit` steps (and a deep one cannot overflow the stack)", () => {
    const wide = Array.from({ length: 200_000 }, (_, i) => ({ key: `value ${i}` }));
    const started = performance.now();
    expect(sizeUpTo(wide, 1_000)).toBeGreaterThan(1_000);
    expect(performance.now() - started).toBeLessThan(500);
    let deep: unknown = "leaf";
    for (let i = 0; i < 100_000; i += 1) deep = { next: deep };
    expect(sizeUpTo(deep, Number.MAX_SAFE_INTEGER)).toBeGreaterThan(100_000);
  });
});

describe("checkPayloadLimits: how many payloads", () => {
  const many = (count: number) => Array.from({ length: count }, (_, i) => json({ type: "object" }, `m${i}`));

  it("500 payloads are fine, 501 are refused naming the limit", () => {
    expect(checkPayloadLimits(many(500)).success).toBe(true);
    expect(failureOf(checkPayloadLimits(many(501)))).toMatchObject({ code: "VALIDATION_ERROR", details: { payloads: 501, limit: 500 }, message: expect.stringContaining("501 message payloads") });
  });

  it("counts payloads and importable headers, not headers an importer cannot read", () => {
    const unreadable: ExtractedPayload[] = Array.from({ length: 600 }, (_, i) => ({ ...json(undefined, `h${i}`, "headers"), format: "unsupported" }));
    expect(checkPayloadLimits([...many(500), ...unreadable]).success).toBe(true);
    expect(checkPayloadLimits([...many(500), json({ type: "object" }, "h", "headers")]).success).toBe(false);
  });
});

describe("checkPayloadLimits: how big each payload is", () => {
  it("a JSON Schema payload of exactly 256 KiB is fine, one character more is refused, naming the message and the limit", () => {
    expect(checkPayloadLimits([json(schemaOfSize(MAX_JSON_PAYLOAD_BYTES))]).success).toBe(true);
    const over = failureOf(checkPayloadLimits([json(schemaOfSize(MAX_JSON_PAYLOAD_BYTES + 1), "orderCreated")]));
    expect(over).toMatchObject({
      code: "VALIDATION_ERROR", message: 'The payload of message "orderCreated" is larger than 256 KiB, the most an import reads from one JSON Schema or Avro schema',
      details: { messageKey: "orderCreated", role: "payload", limit: MAX_JSON_PAYLOAD_BYTES },
    });
  });

  it("an Avro payload has the same 256 KiB limit, headers are named as headers", () => {
    expect(checkPayloadLimits([avro(schemaOfSize(MAX_JSON_PAYLOAD_BYTES))]).success).toBe(true);
    expect(failureOf(checkPayloadLimits([avro(schemaOfSize(MAX_JSON_PAYLOAD_BYTES + 1))]))?.message).toContain("larger than 256 KiB");
    expect(failureOf(checkPayloadLimits([json(schemaOfSize(MAX_JSON_PAYLOAD_BYTES + 1), "m", "headers")]))?.message).toContain('The headers of message "m"');
  });

  it("a Protobuf payload of exactly 64 KiB is fine, one character more is refused", () => {
    expect(checkPayloadLimits([proto("x".repeat(MAX_PROTOBUF_PAYLOAD_BYTES))]).success).toBe(true);
    expect(failureOf(checkPayloadLimits([proto("x".repeat(MAX_PROTOBUF_PAYLOAD_BYTES + 1), "big")]))).toMatchObject({
      message: 'The payload of message "big" is larger than 64 KiB, the most an import reads from one Protobuf schema', details: { limit: MAX_PROTOBUF_PAYLOAD_BYTES },
    });
  });

  it("a payload that is not an importer's input (unsupported, none) costs nothing", () => {
    const none: ExtractedPayload = { ...json(undefined), format: "none" };
    expect(checkPayloadLimits([none, { ...none, format: "unsupported" }]).success).toBe(true);
  });
});

describe("checkPayloadLimits: how big they are together", () => {
  const each = MAX_JSON_PAYLOAD_BYTES; // 8 payloads of 256 KiB are exactly 2 MiB

  it("exactly 2 MiB is fine, one more character is refused, and says where it stopped", () => {
    const eight = Array.from({ length: 8 }, (_, i) => json(schemaOfSize(each), `m${i}`));
    expect(checkPayloadLimits(eight).success).toBe(true);
    const over = failureOf(checkPayloadLimits([...eight, json(schemaOfSize(60), "last")]));
    expect(over).toMatchObject({ code: "VALIDATION_ERROR", details: { limit: MAX_TOTAL_PAYLOAD_BYTES, messageKey: "last" } });
    expect(over?.message).toContain("add up to more than 2 MiB");
    expect(over?.message).toContain('message "last"');
  });

  it("a schema used by many messages counts once per use (the same object listed 11 times is over 2 MiB)", () => {
    const shared = schemaOfSize(200 * 1024);
    const uses = (n: number) => Array.from({ length: n }, (_, i) => json(shared, `m${i}`));
    expect(checkPayloadLimits(uses(10)).success).toBe(true); // 2,000 KiB
    expect(failureOf(checkPayloadLimits(uses(11)))?.message).toContain("a schema that several messages share counts once per message");
  });

  it("distinct Protobuf sources are capped at 96 KiB together (each is parsed once, and parsing is quadratic); a reused source counts once", () => {
    const a = `a${"x".repeat(MAX_PROTOBUF_PAYLOAD_BYTES - 1)}`; // 64 KiB
    const b = `b${"x".repeat(MAX_TOTAL_PROTOBUF_BYTES - MAX_PROTOBUF_PAYLOAD_BYTES - 1)}`; // 32 KiB
    expect(checkPayloadLimits([proto(a, "m1"), proto(b, "m2")]).success).toBe(true); // exactly 96 KiB
    expect(checkPayloadLimits([proto(a, "m1"), proto(a, "m2"), proto(a, "m3"), proto(b, "m4")]).success).toBe(true); // the reuse is free
    expect(failureOf(checkPayloadLimits([proto(a, "m1"), proto(b, "m2"), proto("c", "m3")]))).toMatchObject({
      message: expect.stringContaining("add up to more than 96 KiB"), details: { limit: MAX_TOTAL_PROTOBUF_BYTES, messageKey: "m3" },
    });
    // two maximal sources are over (each is within its own cap)
    expect(failureOf(checkPayloadLimits([proto(a, "m1"), proto(`c${"x".repeat(MAX_PROTOBUF_PAYLOAD_BYTES - 1)}`, "m2")]))?.details).toMatchObject({ limit: MAX_TOTAL_PROTOBUF_BYTES, messageKey: "m2" });
  });
});

describe("checkPlanLimits", () => {
  const entity = (fields: number, requestedName = "E") => ({ requestedName, fields: new Array<unknown>(fields).fill(null) });
  const plan = (entities: PlanShape["entities"], pinKey = "m:payload"): PlanShape => ({ pinKey, entities });

  it("500 entities are fine, 501 are refused", () => {
    expect(checkPlanLimits([plan(Array.from({ length: 500 }, () => entity(0)))]).success).toBe(true);
    const over = checkPlanLimits([plan(Array.from({ length: 501 }, () => entity(0)))]);
    expect(over.success ? null : over.error).toMatchObject({ code: "VALIDATION_ERROR", details: { entities: 501, limit: 500 } });
  });

  it("2,000 fields in an entity are fine, 2,001 are refused naming the entity and the limit", () => {
    expect(checkPlanLimits([plan([entity(2000)])]).success).toBe(true);
    const over = checkPlanLimits([plan([entity(2001, "Order")], "orderCreated:payload")]);
    expect(over.success ? null : over.error).toMatchObject({
      code: "VALIDATION_ERROR", message: 'The entity "Order" (from orderCreated:payload) would have 2,001 fields; one entity may have at most 2,000',
      details: { entity: "Order", pin: "orderCreated:payload", fields: 2001, limit: 2000 },
    });
  });

  it("10,000 fields in an import are fine (a plan listed five times counts five times), 10,001 are refused", () => {
    const five = Array.from({ length: 5 }, (_, i) => plan([entity(2000, `E${i}`)], `m${i}:payload`));
    expect(checkPlanLimits(five).success).toBe(true);
    const over = checkPlanLimits([...five, plan([entity(1, "Last")], "last:payload")]);
    expect(over.success ? null : over.error).toMatchObject({ details: { entity: "Last", limit: 10_000 }, message: expect.stringContaining("more than 10,000 fields") });
  });
});

describe("boundText", () => {
  it("shortens, flattens control characters and never throws", () => {
    expect(boundText("short")).toBe("short");
    expect(boundText("x".repeat(600))).toHaveLength(500);
    expect(boundText("x".repeat(600)).endsWith("…")).toBe(true);
    expect(boundText("a\nb\tc")).toBe("a b c");
    expect(boundText(undefined)).toBe("undefined");
    expect(boundText("x".repeat(30), 10)).toBe(`${"x".repeat(9)}…`);
  });
});

// ── the size of the document once its references are replaced (what the AsyncAPI parser is handed) ──

/** `levels` schemas that each refer to the one before TWICE: the expansion doubles at every level, the file barely grows. */
function doublingDocument(levels: number, tail?: Record<string, unknown>): Record<string, unknown> {
  const schemas: Record<string, unknown> = { s0: { type: "string" }, ...tail };
  for (let i = 1; i <= levels; i += 1) {
    const previous = { $ref: `#/components/schemas/s${i - 1}` };
    schemas[`s${i}`] = { type: "object", properties: { a: previous, b: previous } };
  }
  return { asyncapi: "3.0.0", info: { title: "t", version: "1.0.0" }, components: { schemas } };
}
const expandedLength = (document: unknown): number => JSON.stringify((resolveLocalRefs(document) as { data: unknown }).data).length;

describe("expandedSizeUpTo / checkExpandedSize", () => {
  it("is exactly the length of the JSON text of the document with every reference replaced (checked against the pure layer's own expansion)", () => {
    const plain = { a: [1, { b: "text" }], c: null };
    expect(expandedSizeUpTo(plain, Number.MAX_SAFE_INTEGER)).toBe(JSON.stringify(plain).length);
    for (const levels of [0, 1, 2, 5, 9]) {
      const document = doublingDocument(levels);
      expect(expandedSizeUpTo(document, Number.MAX_SAFE_INTEGER), `K=${levels}`).toBe(expandedLength(document));
    }
    const chained = { r: { $ref: "#/b" }, a: { x: [{ $ref: "#/c" }, { $ref: "#/c" }] }, b: { $ref: "#/a" }, c: "leaf" }; // a reference to a reference
    expect(expandedSizeUpTo(chained, Number.MAX_SAFE_INTEGER)).toBe(expandedLength(chained));
  });

  it("measures a doubling chain of 60 levels (2^60 bytes) instantly, by stopping at the limit", () => {
    const started = performance.now();
    expect(expandedSizeUpTo(doublingDocument(60), MAX_EXPANDED_DOCUMENT_BYTES)).toBe(MAX_EXPANDED_DOCUMENT_BYTES + 1);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it("refuses K=17 (about 15 MB expanded from a 2.5 KB file) well under a second and lets K=10 through", () => {
    const started = performance.now();
    const refused = checkExpandedSize(doublingDocument(17));
    expect(performance.now() - started).toBeLessThan(500);
    expect(refused.success ? null : refused.error).toMatchObject({
      code: "VALIDATION_ERROR", details: { limit: MAX_EXPANDED_DOCUMENT_BYTES },
      message: "The document is too large once its references are resolved (limit 4 MiB): every place that refers to a shared definition counts a full copy of it",
    });
    expect(JSON.stringify(doublingDocument(17)).length).toBeLessThan(3_000);
    expect(checkExpandedSize(doublingDocument(10)).success).toBe(true);
  });

  it("one trait of 1,000 properties used by 400 messages is 10 MB expanded (40 MB with the channel and operations that refer to the messages) from a 111 KB file: refused by the gate alone, in milliseconds", () => {
    const messages = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`m${i}`, { payload: { type: "object" }, traits: [{ $ref: "#/components/messageTraits/big" }] }]));
    const big = { headers: { type: "object", properties: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`p${i}`, { type: "string" }])) } };
    const document = { asyncapi: "3.0.0", info: { title: "t", version: "1.0.0" }, components: { messages, messageTraits: { big } } };
    expect(JSON.stringify(document).length).toBeLessThan(120_000);
    const started = performance.now();
    const refused = checkExpandedSize(document);
    expect(performance.now() - started).toBeLessThan(500);
    expect(refused.success).toBe(false);
    expect(expandedSizeUpTo(document, Number.MAX_SAFE_INTEGER)).toBeGreaterThan(10_000_000);
  });

  it("the limit itself: a document of exactly 4 MiB expanded is fine, one more character is refused", () => {
    const padded = (extra: number) => ({ pad: "x".repeat(MAX_EXPANDED_DOCUMENT_BYTES - JSON.stringify({ pad: "" }).length + extra) });
    expect(checkExpandedSize(padded(0)).success).toBe(true);
    expect(JSON.stringify(padded(0)).length).toBe(MAX_EXPANDED_DOCUMENT_BYTES);
    expect(checkExpandedSize(padded(1)).success).toBe(false);
  });

  it("a recursive schema is not an error and does not let the measure be skipped: the recursion is counted once, the rest is still measured", () => {
    const recursive = { Node: { type: "object", properties: { child: { $ref: "#/components/schemas/Tree" } } }, Tree: { type: "object", properties: { root: { $ref: "#/components/schemas/Node" } } } };
    const alone = doublingDocument(0, recursive);
    expect(checkExpandedSize(alone).success).toBe(true);
    expect(expandedSizeUpTo(alone, MAX_EXPANDED_DOCUMENT_BYTES)).toBeLessThan(1_000);
    expect(checkExpandedSize(doublingDocument(17, recursive)).success).toBe(false); // a cycle next to a doubling chain: still refused
    const selfReference = { a: { $ref: "#/a" }, b: { x: { $ref: "#/b" } } };
    expect(expandedSizeUpTo(selfReference, MAX_EXPANDED_DOCUMENT_BYTES)).toBeGreaterThan(0);
  });

  it("dangling and unusual references count as themselves and never throw; a very deep chain is simply over the limit", () => {
    expect(() => expandedSizeUpTo({ a: { $ref: "#/missing" }, b: { $ref: "https://example.com/x.json" }, c: { $ref: "#anchor" }, d: { $ref: 5 } }, 1_000)).not.toThrow();
    const chain: Record<string, unknown> = { use: { $ref: "#/r4999" }, leaf: "x" }; // `use` comes first: the whole chain is followed from there
    for (let i = 0; i < 5_000; i += 1) chain[`r${i}`] = { $ref: i === 0 ? "#/leaf" : `#/r${i - 1}` };
    expect(expandedSizeUpTo(chain, MAX_EXPANDED_DOCUMENT_BYTES)).toBe(MAX_EXPANDED_DOCUMENT_BYTES + 1);
  });

  it("keywords beside a $ref refine an object target (counted as the target plus the extra members), and are ignored beside a non-object target", () => {
    const refined = { s: { type: "object", properties: {} }, use: { $ref: "#/s", description: "more" } };
    expect(expandedSizeUpTo(refined, 1_000_000)).toBe(expandedLength(refined));
    const beside = { s: "text", use: { $ref: "#/s", description: "ignored" } };
    expect(expandedSizeUpTo(beside, 1_000_000)).toBe(expandedLength(beside));
  });
});
