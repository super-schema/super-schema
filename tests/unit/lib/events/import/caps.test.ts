// tests/unit/lib/events/import/caps.test.ts
// WP-I1 fix round 3: a crafted import cannot block the server. The work of every later step grows with the LENGTH of the keys and references
// a document uses (each use is split, decoded and resolved again), so object keys, `$ref`s and chains of `$ref` wrappers are capped. Probes from
// the review: one 150 KB channel key with 5,000 inline messages took 140 s and about 1 GB; a 150 KB `$ref` key with 5,000 messages 12 s; a
// `$ref` path of 200 segments of 1 KB keys 7.6 s; a 60-hop wrapper chain on 10,000 messages 5 s.
import { describe, expect, it } from "vitest";
import { MAX_KEY_LENGTH, MAX_REF_LENGTH } from "@/lib/events/import/limits";
import { extractPayloads } from "@/lib/events/import/payloads";
import { mapAsyncApiToEventDocument } from "@/lib/events/import/map-document";
import { createRefResolver, resolveLocalRefs } from "@/lib/events/import/refs";
import { assertDocumentBounds, parseAsyncApiSource } from "@/lib/events/import/source";
import type { RawAsyncApi3 } from "@/lib/events/import/types";

const SCHEMAS = "#/components/schemas/";

function parsed(text: string): RawAsyncApi3 {
  const result = parseAsyncApiSource(text);
  if (!result.success) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data;
}
function sourceFailure(text: string) {
  const result = parseAsyncApiSource(text);
  if (result.success) throw new Error("expected the source to be rejected");
  return result.error;
}
/** A document whose one message has `payload` and whose schemas are `schemas`; every other part is minimal. */
const withPayload = (payload: unknown, schemas: Record<string, unknown>): string => JSON.stringify({
  asyncapi: "3.0.0", info: { title: "T" }, servers: { s: { host: "h:1", protocol: "kafka" } },
  channels: { c: { address: "a", messages: { m: { $ref: "#/components/messages/m" } } } },
  components: { messages: { m: { payload } }, schemas },
});
const failureOfExtract = (raw: RawAsyncApi3) => {
  const result = extractPayloads(raw);
  if (result.success) throw new Error("expected extractPayloads to fail");
  return result.error;
};

describe("object keys are capped at 1,024 characters (source)", () => {
  it("the original probe: a 331 KiB document with one 150 KB channel key and 5,000 inline messages is rejected fast, with a short message", { timeout: 30_000 }, () => {
    const messages = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`m${i}`, { payload: { type: "object" } }]));
    const text = JSON.stringify({ asyncapi: "3.0.0", info: { title: "T" }, channels: { [`k${"k".repeat(149_999)}`]: { address: "a", messages } } });
    expect(text.length).toBeGreaterThan(300 * 1024);
    expect(text.length).toBeLessThan(1024 * 1024);
    const started = Date.now();
    const error = sourceFailure(text);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(error.code).toBe("PARSE_ERROR");
    expect(error.message).toContain("1,024");
    expect(error.message).toContain("150,000");
    expect(error.message.length).toBeLessThan(400);
    const details = error.details as { pointer: string; length: number; limit: number };
    expect(details).toMatchObject({ length: 150_000, limit: MAX_KEY_LENGTH });
    expect(details.pointer.length).toBeLessThanOrEqual(500);
  });

  it("the same, as YAML (an explicit key: a simple one is limited by the YAML parser itself)", () => {
    const error = sourceFailure(`asyncapi: 3.0.0\n? ${"k".repeat(5000)}\n: 1\n`);
    expect(error.code).toBe("PARSE_ERROR");
    expect(error.message).toContain("1,024");
    expect(error.message.length).toBeLessThan(400);
  });

  it.each([
    ["at the top", (key: string) => `{"asyncapi":"3.0.0","${key}":1}`],
    ["in a nested object", (key: string) => `{"asyncapi":"3.0.0","x-a":{"b":{"${key}":1}}}`],
    ["in an object inside a list", (key: string) => `{"asyncapi":"3.0.0","x-a":[1,{"${key}":1}]}`],
  ])("a key of exactly 1,024 characters is accepted and one of 1,025 rejected, %s", (_where, build) => {
    expect(MAX_KEY_LENGTH).toBe(1024);
    expect(parseAsyncApiSource(build("k".repeat(1024))).success).toBe(true);
    const error = sourceFailure(build("k".repeat(1025)));
    expect(error.code).toBe("PARSE_ERROR");
    expect(error.message).toContain("1,025");
    expect((error.details as { length: number }).length).toBe(1025);
  });

  it("the cap counts UTF-16 characters, not bytes: 1,024 CJK characters pass, 1,025 do not", () => {
    const build = (length: number) => `{"asyncapi":"3.0.0","x-${"漢".repeat(length - 2)}":1}`;
    expect(parseAsyncApiSource(build(1024)).success).toBe(true);
    const error = sourceFailure(build(1025));
    expect(error.code).toBe("PARSE_ERROR");
    expect(error.message).toContain("1,025");
  });

  it("the length is the key's, not the value's: a huge value under a short key is fine", () => {
    expect(parseAsyncApiSource(`{"asyncapi":"3.0.0","x-note":"${"v".repeat(200_000)}"}`).success).toBe(true);
  });

  it("a key longer than the cap that is also forbidden is reported once, as too long (nothing echoes it whole)", () => {
    const error = sourceFailure(`{"asyncapi":"3.0.0","${"__proto__".repeat(200)}":1}`);
    expect(error.message).toContain("1,024");
    expect(error.message.length).toBeLessThan(400);
  });
});

describe("a $ref is capped at 1,024 characters (refs)", () => {
  /** A resolvable ref of exactly `length` characters: `#/components/schemas/<key>`. */
  const refOfLength = (length: number) => ({ key: "k".repeat(length - SCHEMAS.length), ref: `${SCHEMAS}${"k".repeat(length - SCHEMAS.length)}` });

  it("a ref of 1,024 characters is followed; one of 1,025 is REF_TOO_LARGE, named in a few characters", () => {
    expect(MAX_REF_LENGTH).toBe(1024);
    const ok = refOfLength(1024);
    expect(ok.ref).toHaveLength(1024);
    expect(parseAsyncApiSource(withPayload({ $ref: ok.ref }, { [ok.key]: { type: "string" } })).success).toBe(true);
    const accepted = extractPayloads(parsed(withPayload({ $ref: ok.ref }, { [ok.key]: { type: "string" } })));
    expect(accepted.success && accepted.data[0]).toMatchObject({ format: "json-schema", raw: { type: "string" } });

    const tooLong = refOfLength(1025);
    expect(tooLong.ref).toHaveLength(1025);
    const raw = parsed(withPayload({ $ref: tooLong.ref }, { [tooLong.key]: { type: "string" } })); // the key itself is fine: 1,004 characters
    const error = failureOfExtract(raw);
    expect(error.code).toBe("REF_TOO_LARGE");
    expect(error.message).toContain("1,025");
    expect(error.message.length).toBeLessThan(500);
    expect((error.details as { ref: string }).ref.length).toBeLessThanOrEqual(500);
  });

  it("the same limit for the strict resolver, the mapper and a ref that is not resolvable", () => {
    const tooLong = refOfLength(1025);
    const strict = resolveLocalRefs({ a: { $ref: tooLong.ref }, components: { schemas: { [tooLong.key]: {} } } });
    expect(strict.success ? "ok" : strict.error.code).toBe("REF_TOO_LARGE");
    const mapped = mapAsyncApiToEventDocument(parsed(withPayload({ $ref: tooLong.ref }, { [tooLong.key]: { type: "string" } })), { payloadPins: new Map(), builtInTraitIds: {} });
    expect(mapped.success ? "ok" : mapped.error.code).toBe("REF_TOO_LARGE");
    const missing = resolveLocalRefs({ a: { $ref: `#/${"x".repeat(2000)}` } });
    expect(missing.success ? "ok" : missing.error.code).toBe("REF_TOO_LARGE"); // refused before it is even looked up
    const deref = createRefResolver({}).deref({ $ref: `#/${"x".repeat(2000)}` }, "/start");
    expect(deref.success ? "ok" : deref.error.code).toBe("REF_TOO_LARGE");
  });

  it("a ref of 1,025 characters that points outside the document is also refused by length first (a megabyte-long URL is never examined)", () => {
    const result = resolveLocalRefs({ a: { $ref: `https://example.com/${"u".repeat(1_000_000)}` } });
    expect(result.success ? "ok" : result.error.code).toBe("REF_TOO_LARGE");
    const short = resolveLocalRefs({ a: { $ref: "https://example.com/x.json" } });
    expect(short.success ? "ok" : short.error.code).toBe("EXTERNAL_REF");
  });

  it("a path of 200 segments of 1 KB keys (each key passes the key cap) is refused by the ref cap, fast, whatever the number of messages", () => {
    // components.schemas.<k0>.<k1>…<k199> = a schema; a wrapper refers to it once, 4,000 messages refer to the wrapper
    const keys = Array.from({ length: 200 }, (_, i) => `${i}`.padEnd(1000, "k"));
    let leaf: unknown = { type: "string" };
    for (let i = keys.length - 1; i >= 0; i -= 1) leaf = { [keys[i]]: leaf };
    const ref = `${SCHEMAS}${keys.join("/")}`;
    expect(ref.length).toBeGreaterThan(200_000);
    const messages = Object.fromEntries(Array.from({ length: 4000 }, (_, i) => [`m${i}`, { payload: { $ref: `${SCHEMAS}s` } }]));
    const channelMessages = Object.fromEntries(Object.keys(messages).map((k) => [k, { $ref: `#/components/messages/${k}` }]));
    const text = JSON.stringify({
      asyncapi: "3.0.0", info: { title: "T" }, channels: { c: { address: "a", messages: channelMessages } },
      components: { messages, schemas: { ...(leaf as object), s: { $ref: ref } } },
    });
    expect(text.length).toBeLessThan(1024 * 1024);
    const raw = parsed(text); // every key is at most 1,024 characters and nothing nests deeper than 256 levels
    const started = Date.now();
    expect(failureOfExtract(raw).code).toBe("REF_TOO_LARGE");
    expect(mapAsyncApiToEventDocument(raw, { payloadPins: new Map(), builtInTraitIds: {} })).toMatchObject({ success: false, error: { code: "REF_TOO_LARGE" } });
    expect(Date.now() - started).toBeLessThan(2000);
  }, 30_000);

  it("a deep path of SHORT keys is still a normal ref: 200 one-character segments work", () => {
    const keys = Array.from({ length: 200 }, (_, i) => String.fromCharCode(97 + (i % 26)));
    let leaf: unknown = { type: "string" };
    for (let i = keys.length - 1; i >= 0; i -= 1) leaf = { [keys[i] + i]: leaf }; // distinct names a0, b1, … so the path is unambiguous
    const path = keys.map((k, i) => `${k}${i}`).join("/");
    const result = extractPayloads(parsed(withPayload({ $ref: `${SCHEMAS}${path}` }, leaf as Record<string, unknown>)));
    expect(result.success && result.data[0]).toMatchObject({ format: "json-schema", raw: { type: "string" } });
  });
});

describe("a chain of $ref wrappers is capped at 16 hops (deref)", () => {
  /** w1 -> w2 -> … -> wN (a plain schema), the refs written with `prefix`: dereferencing `${prefix}w1` takes N hops. */
  const chain = (hops: number, prefix = "#/"): Record<string, unknown> => {
    const value: Record<string, unknown> = {};
    for (let i = 1; i < hops; i += 1) value[`w${i}`] = { $ref: `${prefix}w${i + 1}` };
    value[`w${hops}`] = { type: "string" };
    return value;
  };

  it("16 hops are followed, 17 are REF_TOO_LARGE", () => {
    const sixteen = createRefResolver(chain(16)).deref({ $ref: "#/w1" }, "/start");
    expect(sixteen).toEqual({ success: true, data: { value: { type: "string" }, pointer: "/w16" } });
    const seventeen = createRefResolver(chain(17)).deref({ $ref: "#/w1" }, "/start");
    expect(seventeen.success ? "ok" : seventeen.error.code).toBe("REF_TOO_LARGE");
    expect(seventeen.success ? "" : seventeen.error.message).toContain("more than 16 references");
    // it names where the chain began, not the hop it stopped at (/w16)
    expect(seventeen.success ? "" : seventeen.error.message).toContain('starting at "/start"');
    expect(seventeen.success ? {} : seventeen.error.details).toMatchObject({ pointer: "/start" });
  });

  it("a payload that is a chain of 16 wrappers imports, one of 17 does not (the error names the limit)", () => {
    const doc = (hops: number) => parsed(withPayload({ $ref: `${SCHEMAS}w1` }, chain(hops, SCHEMAS)));
    const sixteen = extractPayloads(doc(16));
    expect(sixteen.success && sixteen.data[0]).toMatchObject({ format: "json-schema", raw: { type: "string" } });
    const error = failureOfExtract(doc(17));
    expect(error.code).toBe("REF_TOO_LARGE");
    expect(error.message).toContain("more than 16 references");
    expect(error.message).toContain('starting at "/components/messages/m/payload"');
    expect(error.details).toMatchObject({ pointer: "/components/messages/m/payload" });
  });

  it("the review's shape (a 60-hop chain, short names, 10,000 messages) is refused at the first message, fast", () => {
    const messages = Object.fromEntries(Array.from({ length: 10_000 }, (_, i) => [`m${i}`, { payload: { $ref: `${SCHEMAS}w1` } }]));
    const channelMessages = Object.fromEntries(Object.keys(messages).map((k) => [k, { $ref: `#/components/messages/${k}` }]));
    const raw = parsed(JSON.stringify({
      asyncapi: "3.0.0", info: { title: "T" }, channels: { c: { address: "a", messages: channelMessages } },
      components: { messages, schemas: chain(60, SCHEMAS) },
    }));
    const started = Date.now();
    expect(failureOfExtract(raw).code).toBe("REF_TOO_LARGE");
    expect(Date.now() - started).toBeLessThan(2000);
  }, 30_000);
});

describe("the same bounds hold for an object handed straight to extractPayloads or the mapper (they do not rely on the caller having parsed text)", () => {
  const noPins = { payloadPins: new Map(), builtInTraitIds: {} };
  const channelWithKey = (key: string, messages: number): RawAsyncApi3 => ({
    asyncapi: "3.0.0", info: { title: "T" },
    channels: { [key]: { address: "a", messages: Object.fromEntries(Array.from({ length: messages }, (_, i) => [`m${i}`, { payload: { type: "object" } }])) } },
  });

  it("the original probe as an object (a 150 KB key, 5,000 inline messages; 158 s and 956 MB before) is PARSE_ERROR from both, in milliseconds", () => {
    const raw = channelWithKey("k".repeat(150_000), 5000);
    const started = Date.now();
    const extracted = extractPayloads(raw);
    const mapped = mapAsyncApiToEventDocument(raw, noPins);
    expect(Date.now() - started).toBeLessThan(2000);
    for (const result of [extracted, mapped]) {
      expect(result.success).toBe(false);
      if (result.success) continue;
      expect(result.error.code).toBe("PARSE_ERROR");
      expect(result.error.message).toContain("1,024");
      expect(result.error.message.length).toBeLessThan(400);
    }
  }, 30_000);

  it("nesting deeper than 256 levels and more than 2 million values are refused too", () => {
    let nested: unknown = 1;
    for (let i = 0; i < 300; i += 1) nested = [nested];
    const deep = { asyncapi: "3.0.0", info: { title: "T" }, "x-deep": nested } as RawAsyncApi3;
    const huge = { asyncapi: "3.0.0", info: { title: "T" }, "x-list": new Array(2_100_000).fill(0) } as RawAsyncApi3;
    for (const raw of [deep, huge]) {
      const extracted = extractPayloads(raw);
      const mapped = mapAsyncApiToEventDocument(raw, noPins);
      expect(extracted.success ? "ok" : extracted.error.code).toBe("PARSE_ERROR");
      expect(mapped.success ? "ok" : mapped.error.code).toBe("PARSE_ERROR");
    }
  }, 30_000);

  it("assertDocumentBounds accepts an ordinary document and a key like __proto__ (those are stored safely later, and refused only when text is parsed)", () => {
    expect(assertDocumentBounds({ asyncapi: "3.0.0", info: { title: "T" }, channels: { c: { address: "a" } } }).success).toBe(true);
    expect(assertDocumentBounds(JSON.parse('{"asyncapi":"3.0.0","__proto__":{"x":1}}')).success).toBe(true);
    expect(assertDocumentBounds({ k: "k".repeat(1025) }).success).toBe(true); // a long VALUE is not a long key
    const refused = assertDocumentBounds({ ["k".repeat(1025)]: 1 });
    expect(refused.success ? "ok" : refused.error.code).toBe("PARSE_ERROR");
  });
});

