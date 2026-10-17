// tests/unit/lib/events/import/worst-case.test.ts
// WP-I1 fix round 4: the cost of an import is bounded for EVERY shape a document under 1 MiB can take, not only the ones somebody thought of.
// For each shape below the test builds the largest document of that shape that fits in the limit, runs parseAsyncApiSource + extractPayloads +
// mapAsyncApiToEventDocument, and asserts (1) the total stays within 4 seconds (the measured times are 5 to 20 times lower; the bound is generous on
// purpose, so a slow CI machine does not make it flaky, but a quadratic step cannot hide under it), and (2) the outcome is the one expected for the
// shape: a success, or a clean, bounded error. Set WORST_CASE_LOG=<file> to append the measured times to a file.
import { appendFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAX_IMPORT_CONTENT_BYTES } from "@/lib/compiler/import-limits";
import { mapAsyncApiToEventDocument } from "@/lib/events/import/map-document";
import { extractPayloads } from "@/lib/events/import/payloads";
import { parseAsyncApiSource } from "@/lib/events/import/source";
import type { ExtractedPayload, ImportWarning } from "@/lib/events/import/types";

/** The bound every shape must stay within, in milliseconds (parse + extract + map together). */
const BUDGET_MS = 4000;
/** Characters of text a shape may use: just under the 1 MiB limit (all of it ASCII, so characters are bytes). */
const TEXT_BUDGET = MAX_IMPORT_CONTENT_BYTES - 8_000;

/** The largest `n` for which `build(n)` still fits in the limit, and that text. */
function largest(build: (n: number) => string): { n: number; text: string } {
  let low = 1;
  let high = 2;
  if (build(1).length === build(2).length) throw new Error("this shape does not grow with n: mark it `fixed`");
  while (build(high).length <= TEXT_BUDGET) {
    low = high;
    high *= 2;
  }
  while (high - low > Math.max(1, Math.floor(low / 1000))) {
    const middle = Math.floor((low + high) / 2);
    if (build(middle).length <= TEXT_BUDGET) low = middle;
    else high = middle;
  }
  return { n: low, text: build(low) };
}

interface Run { outcome: string; stageMs: { parse: number; extract: number; map: number }; totalMs: number; warnings: ImportWarning[]; extracted: ExtractedPayload[]; message: string }

/** The whole pure pipeline, the way the importer drives it; stops at the first error. */
function run(text: string): Run {
  const stageMs = { parse: 0, extract: 0, map: 0 };
  const out = (outcome: string, message = "", warnings: ImportWarning[] = [], extracted: ExtractedPayload[] = []): Run => ({
    outcome, stageMs, totalMs: stageMs.parse + stageMs.extract + stageMs.map, warnings, extracted, message,
  });
  let t = performance.now();
  const parsed = parseAsyncApiSource(text);
  stageMs.parse = performance.now() - t;
  if (!parsed.success) return out(parsed.error.code, parsed.error.message);
  t = performance.now();
  const extracted = extractPayloads(parsed.data);
  stageMs.extract = performance.now() - t;
  if (!extracted.success) return out(extracted.error.code, extracted.error.message);
  const payloadPins = new Map(extracted.data.map((p) => [`${p.messageKey}:${p.role}`, { entityId: `e:${p.messageKey}:${p.role}`, entityVersionId: null }]));
  t = performance.now();
  const mapped = mapAsyncApiToEventDocument(parsed.data, { payloadPins, builtInTraitIds: {} });
  stageMs.map = performance.now() - t;
  if (!mapped.success) return out(mapped.error.code, mapped.error.message, [], extracted.data);
  return out("ok", "", mapped.data.warnings, extracted.data);
}

// ── document builders (JSON text unless a shape says otherwise) ──
const json = (value: unknown): string => JSON.stringify(value);
const HEAD = '{"asyncapi":"3.0.0","info":{"title":"T"}';
const SERVER = { s: { host: "h:1", protocol: "kafka" } };
const doc = (parts: Record<string, unknown>, withServer = true): string => json({ asyncapi: "3.0.0", info: { title: "T" }, ...(withServer ? { servers: SERVER } : {}), ...parts });
const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);
const entries = <T>(n: number, key: (i: number) => string, value: (i: number) => T): Record<string, T> => Object.fromEntries(range(n).map((i) => [key(i), value(i)]));
/** `a`, then the digits of `i` written as punctuation: every key is different and all of them slug to `a`. */
const collidingKey = (i: number): string => `a${[...String(i)].map((d) => "!?#$%^&*()"[Number(d)]).join("")}`;
const longKey = (i: number, length: number): string => `${i}`.padEnd(length, "k");
const channelWith = (messages: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ c: { address: "a", messages, ...extra } });
const messageRefs = (n: number, section = "messages") => entries(n, (i) => `m${i}`, (i) => ({ $ref: `#/components/${section}/m${i}` }));

interface Shape { id: string; what: string; build: (n: number) => string; expect: string; /** A shape that does not grow with `n` (it is already the deepest there is). */ fixed?: boolean }
const ok = "ok";

const SHAPES: Shape[] = [
  { id: "a1", what: "one flat JSON object with the most short keys", build: (n) => `${HEAD}${range(n).map((i) => `,"x${i}":1`).join("")}}`, expect: ok },
  { id: "a2", what: "one flat YAML map with the most short keys", build: (n) => `asyncapi: 3.0.0\ninfo:\n  title: T\n${range(n).map((i) => `x${i}: 1`).join("\n")}\n`, expect: ok },
  { id: "b1", what: "the same key, repeated as often as fits (JSON)", build: (n) => `${HEAD}${'"a":1,'.repeat(n)}"b":2}`.replace(`${HEAD}"a"`, `${HEAD},"a"`), expect: "PARSE_ERROR" },
  { id: "b2", what: "the same key, repeated as often as fits (YAML)", build: (n) => `asyncapi: 3.0.0\n${"a: 1\n".repeat(n)}`, expect: "PARSE_ERROR" },
  { id: "c1", what: "the most inline messages whose keys all slug to the same base, in one channel", build: (n) => doc({ channels: channelWith(entries(n, collidingKey, () => ({}))) }), expect: ok },
  { id: "c2", what: "the most component messages whose keys all slug to the same base", build: (n) => doc({ components: { messages: entries(n, collidingKey, () => ({})) } }), expect: ok },
  { id: "d1", what: "the most messages sharing one trait and one payload $ref", build: (n) => doc({
    components: {
      messages: entries(n, (i) => `m${i}`, () => ({ payload: { $ref: "#/components/schemas/s" }, traits: [{ $ref: "#/components/messageTraits/t" }] })),
      schemas: { s: { type: "object" } }, messageTraits: { t: { summary: "t" } },
    },
  }), expect: ok },
  { id: "e1", what: "the most operations referencing the same channel and message", build: (n) => doc({
    channels: channelWith({ m: { $ref: "#/components/messages/m" } }), components: { messages: { m: { payload: { type: "object" } } } },
    operations: entries(n, (i) => `op${i}`, () => ({ action: "send", channel: { $ref: "#/channels/c" }, messages: [{ $ref: "#/channels/c/messages/m" }] })),
  }), expect: ok },
  { id: "f1", what: "the most servers, one channel on all of them", build: (n) => json({
    asyncapi: "3.0.0", info: { title: "T" }, servers: entries(n, (i) => `s${i}`, () => ({ host: "h:1", protocol: "kafka" })),
    channels: channelWith({}, { servers: range(n).map((i) => ({ $ref: `#/servers/s${i}` })) }),
  }), expect: ok },
  { id: "f2", what: "the most servers with different protocols, and the most channels that name no server", build: (n) => json({
    asyncapi: "3.0.0", info: { title: "T" }, servers: entries(n, (i) => `s${i}`, (i) => ({ host: "h:1", protocol: `p${i}` })),
    channels: entries(n, (i) => `c${i}`, () => ({ address: "a" })),
  }), expect: ok },
  { id: "g1", what: "the most channels with the same address", build: (n) => doc({ channels: entries(n, (i) => `c${i}`, () => ({ address: "same" })) }), expect: ok },
  { id: "h1", what: "one huge enum in a payload schema", build: (n) => doc({
    channels: channelWith({ m: { $ref: "#/components/messages/m" } }), components: { messages: { m: { payload: { type: "integer", enum: range(n) } } } },
  }), expect: ok },
  { id: "h2", what: "one message with the most tags", build: (n) => doc({
    channels: channelWith({ m: { $ref: "#/components/messages/m" } }), components: { messages: { m: { payload: {}, tags: range(n).map((i) => ({ name: `t${i}` })) } } },
  }), expect: ok },
  { id: "h3", what: "one message with the most examples", build: (n) => doc({
    channels: channelWith({ m: { $ref: "#/components/messages/m" } }), components: { messages: { m: { payload: {}, examples: range(n).map((i) => ({ payload: i })) } } },
  }), expect: ok },
  { id: "h4", what: "one operation referencing the most messages of one channel", build: (n) => doc({
    channels: channelWith(messageRefs(n)), components: { messages: entries(n, (i) => `m${i}`, () => ({})) },
    operations: { op: { action: "send", channel: { $ref: "#/channels/c" }, messages: range(n).map((i) => ({ $ref: `#/channels/c/messages/m${i}` })) } },
  }), expect: ok },
  { id: "h5", what: "one message with the most trait references (all different)", build: (n) => doc({
    channels: channelWith({ m: { $ref: "#/components/messages/m" } }),
    components: { messages: { m: { payload: {}, traits: range(n).map((i) => ({ $ref: `#/components/messageTraits/t${i}` })) } }, messageTraits: entries(n, (i) => `t${i}`, () => ({})) },
  }), expect: ok },
  { id: "h6", what: "one server with the most security scheme references", build: (n) => json({
    asyncapi: "3.0.0", info: { title: "T" },
    servers: { s: { host: "h:1", protocol: "kafka", security: range(n).map((i) => ({ $ref: `#/components/securitySchemes/s${i}` })) } },
    components: { securitySchemes: entries(n, (i) => `s${i}`, () => ({ type: "userPassword" })) },
  }), expect: ok },
  { id: "h7", what: "one channel address with the most parameters, none defined", build: (n) => doc({ channels: { c: { address: range(n).map((i) => `{p${i}}`).join("."), messages: {} } } }), expect: ok },
  { id: "h8", what: "the most distinct security schemes written in place (operations)", build: (n) => doc({
    channels: channelWith({}), operations: entries(n, (i) => `op${i}`, (i) => ({ action: "send", channel: { $ref: "#/channels/c" }, security: [{ type: "userPassword", description: `d${i}` }] })),
  }), expect: ok },
  { id: "h9", what: "the most distinct message trait objects written in place", build: (n) => doc({ channels: channelWith(entries(n, (i) => `m${i}`, (i) => ({ traits: [{ summary: `s${i}` }] }))) }), expect: ok },
  { id: "i1", what: "the deepest nesting that parses (arrays inside an extension)", build: () => `${HEAD},"x-deep":${"[".repeat(250)}${"]".repeat(250)}}`, expect: ok, fixed: true },
  { id: "i2", what: "the deepest schema that parses (properties inside properties)", build: () => {
    let schema: unknown = { type: "string" };
    for (let i = 0; i < 120; i += 1) schema = { type: "object", properties: { a: schema } };
    return doc({ channels: channelWith({ m: { $ref: "#/components/messages/m" } }), components: { messages: { m: { payload: schema } } } });
  }, expect: ok, fixed: true },
  { id: "j1", what: "a 16-hop wrapper chain referenced by the most messages", build: (n) => doc({
    components: {
      messages: entries(n, (i) => `m${i}`, () => ({ payload: { $ref: "#/components/schemas/w1" } })),
      schemas: entries(16, (i) => `w${i + 1}`, (i) => (i === 15 ? { type: "string" } : { $ref: `#/components/schemas/w${i + 2}` })),
    },
  }), expect: ok },
  { id: "m1", what: "one big schema referenced by as many messages as fit (a clean REF_TOO_LARGE, not a slow import)", build: (n) => doc({
    components: {
      messages: entries(n, (i) => `m${i}`, () => ({ payload: { $ref: "#/components/schemas/big" } })),
      schemas: { big: { type: "integer", enum: range(30_000) } },
    },
  }), expect: "REF_TOO_LARGE" },
  { id: "n1", what: "the most messages that each refer to a schema of their own", build: (n) => doc({
    components: { messages: entries(n, (i) => `m${i}`, (i) => ({ payload: { $ref: `#/components/schemas/s${i}` } })), schemas: entries(n, (i) => `s${i}`, () => ({ type: "string" })) },
  }), expect: ok },
  { id: "p1", what: "one payload schema with the most properties", build: (n) => doc({
    channels: channelWith({ m: { $ref: "#/components/messages/m" } }),
    components: { messages: { m: { payload: { type: "object", properties: entries(n, (i) => `p${i}`, () => ({ type: "string" })) } } } },
  }), expect: ok },
  { id: "k1", what: "the most security schemes", build: (n) => doc({ components: { securitySchemes: entries(n, (i) => `s${i}`, () => ({ type: "userPassword" })) } }), expect: ok },
  { id: "k2", what: "the most component parameters", build: (n) => doc({ components: { parameters: entries(n, (i) => `p${i}`, () => ({ description: "d" })) } }), expect: ok },
  { id: "k3", what: "the most component correlation ids", build: (n) => doc({ components: { correlationIds: entries(n, (i) => `r${i}`, () => ({ location: "$message.header#/id" })) } }), expect: ok },
  { id: "l1", what: "the most component keys of 1,024 characters (messages, schemes, traits, parameters)", build: (n) => doc({
    components: {
      messages: entries(n, (i) => longKey(i, 1024), () => ({})), securitySchemes: entries(n, (i) => longKey(i, 1024), () => ({ type: "userPassword" })),
      messageTraits: entries(n, (i) => longKey(i, 1024), () => ({})), parameters: entries(n, (i) => longKey(i, 1024), () => ({})),
    },
  }), expect: ok },
  { id: "l2", what: "the most 1,024-character keys that differ only at the end (they slug to the same 64 characters)", build: (n) => doc({
    components: { messages: entries(n, (i) => `${"k".repeat(1000)}${String(i).padStart(24, "0")}`, () => ({})) },
  }), expect: ok },
  { id: "l3", what: "the most 990-character message keys, each referenced by a channel and an operation", build: (n) => {
    const key = (i: number) => longKey(i, 990);
    return doc({
      channels: channelWith(entries(n, key, (i) => ({ $ref: `#/components/messages/${key(i)}` }))), components: { messages: entries(n, key, () => ({})) },
      operations: { op: { action: "send", channel: { $ref: "#/channels/c" }, messages: range(n).map((i) => ({ $ref: `#/channels/c/messages/${key(i)}` })) } },
    });
  }, expect: ok },
];

describe("worst case: the largest document of each shape that fits in 1 MiB", () => {
  // WORST_CASE_ONLY=j1,c1 runs just those shapes (for profiling); without it every shape runs
  const only = process.env.WORST_CASE_ONLY?.split(",");
  it.each(only ? SHAPES.filter((shape) => only.includes(shape.id)) : SHAPES)("$id: $what", ({ id, what, build, expect: expected, fixed }) => {
    const { n, text } = fixed ? { n: 0, text: build(0) } : largest(build);
    expect(text.length).toBeLessThanOrEqual(MAX_IMPORT_CONTENT_BYTES);
    const result = run(text);
    const line = `${id.padEnd(3)} n=${String(n).padStart(7)} ${(text.length / 1024).toFixed(0).padStart(5)} KiB  parse ${result.stageMs.parse.toFixed(0).padStart(5)} ms  extract ${result.stageMs.extract.toFixed(0).padStart(5)} ms  map ${result.stageMs.map.toFixed(0).padStart(5)} ms  total ${result.totalMs.toFixed(0).padStart(5)} ms  ${result.outcome}  ${what}`;
    if (process.env.WORST_CASE_LOG) appendFileSync(process.env.WORST_CASE_LOG, `${line}\n`);
    // (1) bounded time
    expect(result.totalMs, line).toBeLessThan(BUDGET_MS);
    // (2) the expected outcome: a success, or a clean bounded error
    expect(result.outcome, `${line}\n${result.message.slice(0, 300)}`).toBe(expected);
    if (expected !== ok) expect(result.message.length).toBeLessThan(600);
    // (3) a success is also bounded in what it reports
    expect(result.warnings.length).toBeLessThanOrEqual(101);
    for (const w of result.warnings) {
      expect(w.message.length).toBeLessThanOrEqual(600);
      expect(w.pointer.length).toBeLessThanOrEqual(500);
    }
  }, 60_000);

  it("the matrix has a row for every shape in the review (a to l)", () => {
    const letters = new Set(SHAPES.map((s) => s.id[0]));
    for (const letter of "abcdefghijkl") expect(letters.has(letter), letter).toBe(true);
  });
});
