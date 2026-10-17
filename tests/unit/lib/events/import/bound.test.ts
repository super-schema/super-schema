// tests/unit/lib/events/import/bound.test.ts
// WP-I1 fix round 2: nothing document-controlled goes into a warning or an error unbounded, and no document can produce an unbounded list of
// warnings. Unit tests for the helpers, then the probes that found the problem (a recursion warning that echoed a 100 KB key once per message).
import { describe, expect, it } from "vitest";
import {
  boundChain, boundPointer, boundText, createWarningSink, MAX_MESSAGE_LENGTH, MAX_POINTER_LENGTH, MAX_WARNINGS, omittedWarningsMessage, OMITTED_WARNINGS_PATTERN,
} from "@/lib/events/import/bound";
import { MAX_REF_LENGTH } from "@/lib/events/import/limits";
import { extractPayloads } from "@/lib/events/import/payloads";
import { mapAsyncApiToEventDocument } from "@/lib/events/import/map-document";
import { parseAsyncApiSource } from "@/lib/events/import/source";
import type { ImportWarning, RawAsyncApi3 } from "@/lib/events/import/types";

describe("boundText", () => {
  it("leaves text up to the cap alone, exactly at the cap included", () => {
    expect(boundText("abc", 5)).toBe("abc");
    expect(boundText("a".repeat(80))).toBe("a".repeat(80));
    expect(boundText("")).toBe("");
  });

  it("cuts one character over the cap and ends with an ellipsis: the result is the cap long", () => {
    const cut = boundText("a".repeat(81));
    expect(cut).toBe(`${"a".repeat(79)}…`);
    expect(cut).toHaveLength(80);
    expect(boundText("abcdef", 4)).toBe("abc…");
  });

  it("the default cap is 80; very small caps still give a bounded result", () => {
    expect(boundText("x".repeat(1000))).toHaveLength(80);
    expect(boundText("abc", 1)).toBe("…");
    expect(boundText("abc", 0)).toBe("");
    expect(boundText("", 0)).toBe("");
  });

  it("never leaves half of a surrogate pair at the cut", () => {
    const text = `${"a".repeat(78)}😀tail`; // the emoji occupies code units 78 and 79
    const cut = boundText(text, 80);
    expect(cut).toBe(`${"a".repeat(78)}…`);
    expect(cut).toHaveLength(79); // at most the cap: one shorter when the cut would split a pair
    expect(cut).not.toMatch(/[\ud800-\udbff]…$/);
    expect(boundText(`${"a".repeat(77)}😀tail`, 80)).toBe(`${"a".repeat(77)}😀…`);
  });

  it("shows anything that is not a string as text, and never throws", () => {
    expect(boundText(42)).toBe("42");
    expect(boundText(true)).toBe("true");
    expect(boundText(null)).toBe("null");
    expect(boundText(undefined)).toBe("undefined");
    expect(boundText({ a: 1 })).toBe('{"a":1}');
    expect(boundText([1, "two"])).toBe('[1,"two"]');
    expect(boundText(BigInt(10))).toBe("10");
    expect(boundText(Symbol("s"))).toBe("Symbol(s)");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(boundText(circular)).toBe("[object Object]");
    expect(boundText({ big: "z".repeat(10_000) })).toHaveLength(80);
  });

  it("bounds a megabyte of text quickly", () => {
    const started = Date.now();
    for (let i = 0; i < 1000; i += 1) boundText("k".repeat(1_000_000), 80);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe("boundChain", () => {
  const chain = (n: number) => Array.from({ length: n }, (_, i) => `#/s/${i}`);

  it("an empty chain is an empty string", () => {
    expect(boundChain([])).toBe("");
  });

  it("shows a chain of up to five entries whole, exactly five included", () => {
    expect(boundChain(chain(1))).toBe("#/s/0");
    expect(boundChain(chain(5))).toBe("#/s/0 → #/s/1 → #/s/2 → #/s/3 → #/s/4");
  });

  it("one over: the first five and `(1 more)`; many over: the first five and the count", () => {
    expect(boundChain(chain(6))).toBe("#/s/0 → #/s/1 → #/s/2 → #/s/3 → #/s/4 (1 more)");
    expect(boundChain(chain(128))).toBe("#/s/0 → #/s/1 → #/s/2 → #/s/3 → #/s/4 (123 more)");
  });

  it("cuts every entry to the per-entry cap (default 80)", () => {
    const long = ["#/components/schemas/" + "k".repeat(100_000), "#/b"];
    expect(boundChain(long)).toBe(`${long[0].slice(0, 79)}… → #/b`);
    expect(boundChain(long, 5, 10)).toBe("#/compone… → #/b");
  });

  it("takes the entry count, the entry length and the separator as arguments", () => {
    expect(boundChain(["a", "b", "c", "d"], 2, 80, ", ")).toBe("a, b (2 more)");
    expect(boundChain(["a", "b"], 0)).toBe("(2 more)");
    expect(boundChain([], 0)).toBe("");
  });

  it("entries that are not strings are shown as text", () => {
    expect(boundChain([1, null, { a: 1 }])).toBe('1 → null → {"a":1}');
  });

  it("a hostile chain (128 entries of 100 KB) is a short string", () => {
    const hostile = Array.from({ length: 128 }, (_, i) => `#/components/schemas/${i}${"k".repeat(100_000)}`);
    expect(boundChain(hostile).length).toBeLessThan(5 * 80 + 4 * 3 + 20);
  });
});

describe("boundPointer", () => {
  it("keeps a pointer up to 500 characters and cuts a longer one", () => {
    expect(boundPointer("/a/b")).toBe("/a/b");
    expect(boundPointer("/".padEnd(MAX_POINTER_LENGTH, "x"))).toHaveLength(MAX_POINTER_LENGTH);
    expect(boundPointer("/".padEnd(MAX_POINTER_LENGTH + 1, "x"))).toHaveLength(MAX_POINTER_LENGTH);
    expect(boundPointer("/".padEnd(MAX_POINTER_LENGTH + 1, "x")).endsWith("…")).toBe(true);
    expect(boundPointer("/".padEnd(MAX_POINTER_LENGTH, "x")).endsWith("…")).toBe(false);
  });
});

describe("createWarningSink", () => {
  const warning = (i: number, extra: Partial<ImportWarning> = {}): ImportWarning => ({ pointer: `/p/${i}`, code: "SANITIZED_VALUE", message: `m${i}`, ...extra });

  it("keeps every warning up to the cap and adds no summary", () => {
    const sink = createWarningSink(3);
    for (let i = 0; i < 3; i += 1) sink.add(warning(i));
    expect(sink.finish().map((w) => w.message)).toEqual(["m0", "m1", "m2"]);
  });

  it("keeps the FIRST warnings and ends with ONE DROPPED_CONSTRUCT summary of how many were omitted", () => {
    const sink = createWarningSink(3);
    for (let i = 0; i < 10; i += 1) sink.add(warning(i));
    expect(sink.finish()).toEqual([warning(0), warning(1), warning(2), { pointer: "", code: "DROPPED_CONSTRUCT", message: "7 more warnings were omitted" }]);
  });

  it("says `1 more warning was omitted` for one", () => {
    const sink = createWarningSink(1);
    sink.add(warning(0));
    sink.add(warning(1));
    expect(sink.finish().at(-1)?.message).toBe("1 more warning was omitted");
  });

  it("its summary line is exactly what OMITTED_WARNINGS_PATTERN recognises, with the right count (producer and recogniser cannot drift apart)", () => {
    for (const [cap, total] of [[1, 2], [3, 10], [5, 6], [2, 1000]] as const) {
      const sink = createWarningSink(cap);
      for (let i = 0; i < total; i += 1) sink.add(warning(i));
      const summary = sink.finish().at(-1)!;
      expect(summary.code).toBe("DROPPED_CONSTRUCT");
      expect(summary.message).toBe(omittedWarningsMessage(total - cap));
      expect(OMITTED_WARNINGS_PATTERN.exec(summary.message)?.[1]).toBe(String(total - cap));
    }
    // a warning of the document itself is never taken for it
    expect(OMITTED_WARNINGS_PATTERN.test("The channel was omitted")).toBe(false);
    expect(OMITTED_WARNINGS_PATTERN.test("a 3 more warnings were omitted")).toBe(false);
  });

  it("bounds every pointer (500) and every message (600) it keeps", () => {
    const sink = createWarningSink();
    sink.add(warning(0, { pointer: `/${"p".repeat(100_000)}`, message: "w".repeat(100_000) }));
    const [kept] = sink.finish();
    expect(kept.pointer).toHaveLength(MAX_POINTER_LENGTH);
    expect(kept.message).toHaveLength(MAX_MESSAGE_LENGTH);
  });

  it("the default cap is MAX_WARNINGS, and finish can be called again", () => {
    const sink = createWarningSink();
    for (let i = 0; i < MAX_WARNINGS + 5; i += 1) sink.add(warning(i));
    const first = sink.finish();
    expect(first).toHaveLength(MAX_WARNINGS + 1);
    expect(sink.finish()).toEqual(first);
  });
});

// ── the probes ──

const textOf = (warnings: ImportWarning[]) => warnings.reduce((sum, w) => sum + w.message.length + w.pointer.length, 0);
const doc = (rest: Record<string, unknown>): RawAsyncApi3 => ({ asyncapi: "3.0.0", info: { title: "T" }, servers: { s: { host: "h:1", protocol: "kafka" } }, ...rest });

function importRaw(raw: RawAsyncApi3) {
  const extracted = extractPayloads(raw);
  if (!extracted.success) throw new Error(`extract: ${extracted.error.code}: ${extracted.error.message.slice(0, 300)}`);
  const payloadPins = new Map(extracted.data.map((p) => [`${p.messageKey}:${p.role}`, { entityId: `e-${p.messageKey}-${p.role}`, entityVersionId: null }]));
  return mapAsyncApiToEventDocument(raw, { payloadPins, builtInTraitIds: {} });
}
function imported(raw: RawAsyncApi3) {
  const result = importRaw(raw);
  if (!result.success) throw new Error(`${result.error.code}: ${result.error.message.slice(0, 300)}`);
  return result.data;
}

/** `count` messages that all use one schema that refers to itself, wrapped under a key of `keyLength` characters. */
function sharedRecursiveSchema(count: number, keyLength: number): RawAsyncApi3 {
  const bigKey = "k".repeat(keyLength);
  const messages: Record<string, unknown> = {};
  const channelMessages: Record<string, unknown> = {};
  for (let i = 0; i < count; i += 1) {
    messages[`m${i}`] = { payload: { $ref: "#/components/schemas/s" } };
    channelMessages[`m${i}`] = { $ref: `#/components/messages/m${i}` };
  }
  return doc({
    channels: { c: { address: "a", messages: channelMessages } },
    components: {
      messages,
      schemas: {
        [bigKey]: { type: "object", properties: { next: { $ref: `#/components/schemas/${bigKey}` } } },
        s: { $ref: `#/components/schemas/${bigKey}` },
      },
    },
  });
}

/** The longest key a `$ref` can reach: `#/components/schemas/<key>` may be 1,024 characters at most. */
const LONGEST_REACHABLE_KEY = MAX_REF_LENGTH - "#/components/schemas/".length;

describe("the recursion warning of many messages that share one recursive schema under a very long key", () => {
  it(`300 messages, the longest key a $ref can reach (${LONGEST_REACHABLE_KEY} characters): the import still maps and all warning text stays under 30,000 characters (with a 100 KB key it was 60,043,690)`, () => {
    const { document, warnings } = imported(sharedRecursiveSchema(300, LONGEST_REACHABLE_KEY));
    expect(document.messages).toHaveLength(300);
    expect(textOf(warnings)).toBeLessThan(30_000);
    expect(warnings).toHaveLength(MAX_WARNINGS + 1);
    expect(warnings[0]).toMatchObject({ code: "UNSUPPORTED_PAYLOAD_FORMAT", pointer: "/components/messages/m0/payload" });
    expect(warnings[0].message).toMatch(/^The payload of "m0" refers to itself \(#\/components\/schemas\/k+… → #\/components\/schemas\/k+…\) and cannot be imported/);
    expect(warnings.at(-1)).toEqual({ pointer: "", code: "DROPPED_CONSTRUCT", message: `${300 - MAX_WARNINGS} more warnings were omitted` });
  });

  it("the original probe (a 100 KB key) can no longer be built: the key cap refuses it, as text and as an object handed straight to either step", () => {
    const raw = sharedRecursiveSchema(300, 100_000);
    const text = parseAsyncApiSource(JSON.stringify(raw));
    expect(text.success).toBe(false);
    if (!text.success) expect(text.error.message).toContain("1,024");
    const extracted = extractPayloads(raw);
    expect(extracted.success ? "ok" : extracted.error.code).toBe("PARSE_ERROR");
    const mapped = mapAsyncApiToEventDocument(raw, { payloadPins: new Map(), builtInTraitIds: {} });
    expect(mapped.success ? "ok" : mapped.error.code).toBe("PARSE_ERROR");
    expect(mapped.success ? "" : mapped.error.message).toContain("1,024");
  });

  it("thousands of messages (5,000, the longest reachable key): bounded the same way, every message still pinned", () => {
    const { document, warnings } = imported(sharedRecursiveSchema(5000, LONGEST_REACHABLE_KEY));
    expect(document.messages).toHaveLength(5000);
    expect(textOf(warnings)).toBeLessThan(30_000);
    expect(warnings.at(-1)?.message).toBe(`${5000 - MAX_WARNINGS} more warnings were omitted`);
  }, 30_000);

  it("a recursion chain of 20 schemas names the first five and counts the rest", () => {
    const schemas: Record<string, unknown> = {};
    for (let i = 0; i < 20; i += 1) schemas[`S${i}`] = { properties: { next: { $ref: `#/components/schemas/S${(i + 1) % 20}` } } };
    const { warnings } = imported(doc({
      channels: { c: { address: "a", messages: { m: { $ref: "#/components/messages/m" } } } },
      components: { messages: { m: { payload: { $ref: "#/components/schemas/S0" } } }, schemas },
    }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toBe(
      'The payload of "m" refers to itself (#/components/schemas/S0 → #/components/schemas/S1 → #/components/schemas/S2 → #/components/schemas/S3 → #/components/schemas/S4 (16 more)) and cannot be imported; an empty entity was created instead',
    );
  });
});

describe("the number of warnings is bounded", () => {
  it("a document that would produce thousands keeps the first 100 in order, then ONE summary", () => {
    const messages: Record<string, unknown> = {};
    const channelMessages: Record<string, unknown> = {};
    for (let i = 0; i < 3000; i += 1) {
      messages[`m${i}`] = { payload: { type: "object" }, notAProperty: true };
      channelMessages[`m${i}`] = { $ref: `#/components/messages/m${i}` };
    }
    const { warnings } = imported(doc({ channels: { c: { address: "a", messages: channelMessages } }, components: { messages } }));
    expect(warnings).toHaveLength(MAX_WARNINGS + 1);
    expect(warnings.slice(0, MAX_WARNINGS).map((w) => w.pointer)).toEqual(Array.from({ length: MAX_WARNINGS }, (_, i) => `/components/messages/m${i}/notAProperty`));
    expect(warnings.slice(0, MAX_WARNINGS).every((w) => w.code === "DROPPED_CONSTRUCT")).toBe(true);
    expect(warnings.at(-1)).toEqual({ pointer: "", code: "DROPPED_CONSTRUCT", message: `${3000 - MAX_WARNINGS} more warnings were omitted` });
    expect(warnings.filter((w) => /omitted/.test(w.message))).toHaveLength(1);
  });

  it("a document with exactly as many warnings as the cap has no summary", () => {
    const messages: Record<string, unknown> = {};
    const channelMessages: Record<string, unknown> = {};
    for (let i = 0; i < MAX_WARNINGS; i += 1) {
      messages[`m${i}`] = { payload: { type: "object" }, notAProperty: true };
      channelMessages[`m${i}`] = { $ref: `#/components/messages/m${i}` };
    }
    const { warnings } = imported(doc({ channels: { c: { address: "a", messages: channelMessages } }, components: { messages } }));
    expect(warnings).toHaveLength(MAX_WARNINGS);
    expect(warnings.some((w) => /omitted/.test(w.message))).toBe(false);
  });

  it("5,000 inline messages whose keys all need adjusting: the first 100 and a summary", () => {
    const channelMessages: Record<string, unknown> = {};
    for (let i = 0; i < 5000; i += 1) channelMessages[`not valid ${i}`] = { payload: { type: "object" } };
    const { warnings } = imported(doc({ channels: { c: { address: "a", messages: channelMessages } } }));
    expect(warnings).toHaveLength(MAX_WARNINGS + 1);
    expect(warnings.at(-1)?.message).toBe("4900 more warnings were omitted");
  });
});

describe("every other echo of document text is bounded", () => {
  const big = "k".repeat(100_000);

  it("keys, formats, protocols, property names and unused components with 1,000-character names stay short", () => {
    const big = "k".repeat(1000); // legal (the key cap is 1,024), and 12 times longer than anything a message may echo
    const raw = doc({
      servers: { a: { host: "h:1", protocol: `kafka${big}` }, b: { host: "h:2", protocol: `mqtt${big}` } },
      channels: {
        [`${big} bad key`]: { address: `x/{${big}}`, messages: { [`${big} m`]: { payload: { schemaFormat: `application/x-${big}`, schema: { type: "object" } } } } },
      },
      [`x-${big}`]: true,
      components: {
        schemas: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`${i}${big}`, { type: "string" }])),
        messageTraits: { t: { summary: "s", tags: [{ name: "n", [`extra${big}`]: 1 }], [`unknown${big}`]: 1 } },
        securitySchemes: { s1: { type: `mutual${big}` } },
      },
    });
    const { warnings } = imported(raw);
    expect(warnings.length).toBeGreaterThan(5);
    for (const w of warnings) {
      // 400, well under the sink's own 600-character trim: a site that echoes document text unbounded cannot hide behind the trim
      expect(w.message.length, `${w.code}: ${w.message.slice(0, 120)}`).toBeLessThan(400);
      expect(w.message.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
      expect(w.pointer.length).toBeLessThanOrEqual(MAX_POINTER_LENGTH);
    }
    const kinds = new Set(warnings.map((w) => w.code));
    expect(kinds).toEqual(new Set(["KEY_ADJUSTED", "UNSUPPORTED_PAYLOAD_FORMAT", "UNSUPPORTED_EXTENSION", "SANITIZED_VALUE", "DROPPED_CONSTRUCT"]));
    const unused = warnings.find((w) => /nothing refers to/.test(w.message));
    expect(unused?.message).toMatch(/\(\d+k+…, .*\(7 more\)\)/);
  });

  it("a $ref that is a megabyte long: refused by length (REF_TOO_LARGE), named in a few characters and carried bounded", () => {
    const result = mapAsyncApiToEventDocument(
      doc({ components: { messages: { m: { payload: { $ref: `https://example.com/${big}` } } } } }),
      { payloadPins: new Map(), builtInTraitIds: {} },
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe("REF_TOO_LARGE");
    expect(result.error.message.length).toBeLessThan(400);
    expect((result.error.details as { ref: string; pointer: string }).ref.length).toBeLessThanOrEqual(MAX_POINTER_LENGTH);
  });

  it("a reference loop through bindings names its first entries only", () => {
    const keys = Array.from({ length: 12 }, (_, i) => `${i}${"k".repeat(400)}`); // long, but short enough for a $ref
    const bindings = Object.fromEntries(keys.map((k, i) => [k, { kafka: { $ref: `#/components/messageBindings/${keys[(i + 1) % 12]}` } }]));
    const raw = doc({ components: { messages: { m: { payload: { type: "object" }, bindings: { $ref: `#/components/messageBindings/${keys[0]}` } } }, messageBindings: bindings } });
    const result = mapAsyncApiToEventDocument(raw, { payloadPins: new Map([["m:payload", { entityId: "e", entityVersionId: null }]]), builtInTraitIds: {} });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe("REF_CYCLE");
    expect(result.error.message.length).toBeLessThan(900);
    expect(result.error.message).toContain("(8 more)");
  });

  it("a 100 KB key is refused by the key cap with a short message; a forbidden key under a long (but legal) path is bounded", () => {
    // JSON, not YAML: YAML does not allow a simple key longer than 1,024 characters
    const tooLong = parseAsyncApiSource(JSON.stringify({ asyncapi: "3.0.0" }).replace("}", `,"x-${big}":{"__proto__":1}}`));
    expect(tooLong.success).toBe(false);
    if (!tooLong.success) {
      expect(tooLong.error.message).toContain("1,024");
      expect(tooLong.error.message.length).toBeLessThan(400);
      expect((tooLong.error.details as { pointer: string }).pointer.length).toBeLessThanOrEqual(MAX_POINTER_LENGTH);
    }
    // ten levels of 1,000-character keys (each one legal) put `__proto__` under a path of about 10 KB
    let inner = '{"__proto__":1}';
    for (let level = 0; level < 10; level += 1) inner = `{"x${level}${"k".repeat(1000)}":${inner}}`;
    const forbidden = parseAsyncApiSource(`{"asyncapi":"3.0.0","x-wrap":${inner}}`);
    expect(forbidden.success).toBe(false);
    if (!forbidden.success) {
      expect(forbidden.error.message).toContain("__proto__");
      expect(forbidden.error.message.length).toBeLessThan(500);
      expect((forbidden.error.details as { pointer: string }).pointer).toHaveLength(MAX_POINTER_LENGTH);
    }
  });

  it("a server with a 1,000-character key and an invalid host handed straight to the mapper gives short, bounded problems", () => {
    const invalid = mapAsyncApiToEventDocument(doc({ servers: { ["k".repeat(1000)]: { host: "kafka://h:1", protocol: "kafka" } } }), { payloadPins: new Map(), builtInTraitIds: {} });
    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(invalid.error.message.length).toBeLessThan(900);
      for (const p of (invalid.error.details as { problems: Array<{ pointer: string; sourcePointer: string; message: string }> }).problems) {
        expect(p.pointer.length).toBeLessThanOrEqual(MAX_POINTER_LENGTH);
        expect(p.sourcePointer.length).toBeLessThanOrEqual(MAX_POINTER_LENGTH);
        expect(p.message.length).toBeLessThanOrEqual(300);
      }
    }
  });

  it("an unsupported schema version and a parser's own text with a huge value stay short", () => {
    const version = parseAsyncApiSource(`asyncapi: "2.${big}"\n`);
    expect(version.success).toBe(false);
    if (!version.success) expect(version.error.message.length).toBeLessThan(200);
    const json = parseAsyncApiSource(`{ "asyncapi": "3.0.0", "info": ${big} }`);
    expect(json.success).toBe(false);
    if (!json.success) expect(json.error.message.length).toBeLessThan(400);
  });
});
