import { afterEach, describe, expect, it, vi } from "vitest";
import { Parser } from "@asyncapi/parser";
import { PARSER_UNSAFE_KEYS, RESERVED_KEYS, setOwn } from "@/lib/event-specs/own-property";
import type { Diagnostic, JsonObject } from "@/lib/event-specs/types";
import {
  AsyncApiParserValidator,
  findParserUnsafeKeys,
  isParserCrashDiagnostic,
  mapParserDiagnostic,
  sanitizeParserDiagnostics,
} from "@/lib/event-specs/validation/asyncapi-parser-validator";
import { createAsyncApiParser } from "@/lib/event-specs/validation/parser-core";
import { baseDocument, parserInput } from "./fixtures/unsafe-key-documents";

/**
 * The choke point for keys `@asyncapi/parser` cannot read (`hasOwnProperty`): every document that passes through
 * `AsyncApiParserValidator.validate` is refused with a clear error naming the key and its pointer, never with the parser's crash text
 * (an exception with a stack and absolute server paths), and a crash of the parser for ANY reason is replaced by one generic error.
 */

const validator = new AsyncApiParserValidator();

/**
 * The parser-unsafe name these tests use, taken from the one list (`PARSER_UNSAFE_KEYS`): the first name that is not also one of the
 * `Object.prototype` collisions (those need special care to write as a key). When the list is lifted down to nothing there is no name left to
 * test with: delete or rewrite this file then (the sweep test tells you).
 */
const UNSAFE = [...PARSER_UNSAFE_KEYS].find((key) => !RESERVED_KEYS.has(key)) as string;

async function validate(document: object): Promise<Diagnostic[]> {
  const res = await validator.validate(document);
  if (!res.success) throw new Error(`${res.error.code}: ${res.error.message}`);
  return res.data;
}

const GENERIC =
  "The AsyncAPI parser could not process this document. Nothing is wrong that you can fix here: try again, and contact an administrator if it keeps happening.";
const advice = (key: string) => `The key "${key}" is a built-in JavaScript name that AsyncAPI tools cannot read, so this document cannot be published with it. Rename it.`;

/** A string that must never reach a user: a stack line or an absolute server path. */
const LEAKS = /\n\s+at \S+ \(|node_modules|\/Users\/|\/home\/|[A-Za-z]:\\|uncaught-error|TypeError/;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/**
 * The parser normally runs in a worker process, where a test cannot replace or watch it: a test that does (a spy on `Parser.prototype`) runs
 * the job in THIS process (`ASYNCAPI_PARSER_IN_PROCESS`, the runner's debugging switch) first.
 */
const inProcess = () => vi.stubEnv("ASYNCAPI_PARSER_IN_PROCESS", "1");

describe("AsyncApiParserValidator — parser-unsafe keys", () => {
  it(`refuses a channel named ${UNSAFE} with one clear error at its pointer, and never calls the parser`, async () => {
    inProcess();
    const parse = vi.spyOn(Parser.prototype, "parse");
    const doc = baseDocument();
    setOwn(doc.channels as JsonObject, UNSAFE, { address: "x.v1" });
    const found = await validate(doc);
    expect(found).toEqual([{ severity: "error", code: "PARSER_UNSAFE_KEY", message: advice(UNSAFE), pointer: `/channels/${UNSAFE}` }]);
    expect(parse).not.toHaveBeenCalled();
  });

  it("without the guard the parser's own report is a ~1,200 character crash with a stack and a server path (the reason for it)", async () => {
    const doc = baseDocument();
    setOwn(doc.channels as JsonObject, UNSAFE, { address: "x.v1" });
    const raw = await createAsyncApiParser().validate(parserInput(doc));
    const crash = raw.find((d) => String(d.code) === "uncaught-error");
    expect(crash?.message).toMatch(/target\.hasOwnProperty is not a function/);
    expect(crash?.message).toMatch(LEAKS);
  });

  it("finds the key wherever it sits: an array item, a nested map, a server variable, a binding, an x- map", async () => {
    const doc = baseDocument();
    doc["x-ext"] = { deep: { deeper: { [UNSAFE]: 1 } } };
    (doc.info as JsonObject).tags = [{ name: "a" }, { name: "b", [UNSAFE]: true }];
    ((doc.servers as JsonObject).prod as JsonObject).variables = { [UNSAFE]: { default: "1" } };
    (doc.operations as JsonObject).sendCreated = { ...((doc.operations as JsonObject).sendCreated as JsonObject), bindings: { kafka: { [UNSAFE]: "x" } } };
    const found = await validate(doc);
    expect(found.every((d) => d.code === "PARSER_UNSAFE_KEY" && d.severity === "error" && d.message === advice(UNSAFE))).toBe(true);
    expect(found.map((d) => d.pointer).sort()).toEqual(
      [
        `/info/tags/1/${UNSAFE}`,
        `/operations/sendCreated/bindings/kafka/${UNSAFE}`,
        `/servers/prod/variables/${UNSAFE}`,
        `/x-ext/deep/deeper/${UNSAFE}`,
      ].sort(),
    );
  });

  it("escapes ~ and / in the pointer (RFC 6901)", () => {
    const doc = { channels: { "a/b~c": { [UNSAFE]: 1 } } };
    expect(findParserUnsafeKeys(doc).map((d) => d.pointer)).toEqual([`/channels/a~1b~0c/${UNSAFE}`]);
  });

  it("says field, message and where to fix it for a JSON Schema property of a message payload (an entity field)", () => {
    const doc = {
      components: { messages: { "order-created": { payload: { schemaFormat: "application/schema+json;version=draft-07", schema: { type: "object", properties: { [UNSAFE]: { type: "string" } } } } } } },
    };
    expect(findParserUnsafeKeys(doc)).toEqual([
      {
        severity: "error",
        code: "PARSER_UNSAFE_KEY",
        message:
          `The field "${UNSAFE}" in the payload of the message "order-created" is a built-in JavaScript name that AsyncAPI tools cannot read, so this document cannot be published with it. Rename the field in its entity.`,
        pointer: `/components/messages/order-created/payload/schema/properties/${UNSAFE}`,
      },
    ]);
  });

  it.each(["definitions", "$defs"])("a key in the %s map of a payload schema, or a component schema name, is the NAME of an entity or model", (map) => {
    const doc = {
      components: {
        schemas: { [UNSAFE]: {} },
        messages: { "order-created": { payload: { schema: { type: "object", [map]: { [UNSAFE]: { type: "object" } } } } } },
      },
    };
    const name = `The name "${UNSAFE}" is a built-in JavaScript name that AsyncAPI tools cannot read, so this document cannot be published with it. Rename the entity (or model).`;
    expect(findParserUnsafeKeys(doc).map((d) => [d.code, d.pointer, d.message])).toEqual([
      ["PARSER_UNSAFE_KEY", `/components/schemas/${UNSAFE}`, name],
      ["PARSER_UNSAFE_KEY", `/components/messages/order-created/payload/schema/${map}/${UNSAFE}`, name],
    ]);
  });

  it("a nested object's property inside a payload is a field too; the same key elsewhere (headers) is just a key", () => {
    const doc = {
      components: {
        messages: {
          m: {
            payload: { schema: { properties: { address: { properties: { [UNSAFE]: {} } } } } },
            headers: { properties: { [UNSAFE]: {} } },
          },
        },
      },
    };
    const found = findParserUnsafeKeys(doc);
    expect(found.map((d) => [d.pointer, d.message.split(" ").slice(0, 2).join(" ")])).toEqual([
      [`/components/messages/m/payload/schema/properties/address/properties/${UNSAFE}`, 'The field'],
      [`/components/messages/m/headers/properties/${UNSAFE}`, 'The key'],
    ]);
  });

  it("is about KEYS: a value, a lower-case name, a different case and the other Object.prototype names are fine", async () => {
    const doc = baseDocument();
    (doc.info as JsonObject).description = UNSAFE;
    doc["x-ext"] = { a: UNSAFE, b: [UNSAFE], hasownproperty: 1, HasOwnProperty: 2, valueOf: 3, toString: 4, isPrototypeOf: 5, constructor: 6 };
    expect(findParserUnsafeKeys(doc)).toEqual([]);
    const found = await validate(doc);
    expect(found.some((d) => d.code === "PARSER_UNSAFE_KEY")).toBe(false);
    expect(found.some((d) => d.code === "ASYNCAPI_PARSER_CRASHED")).toBe(false);
  });

  it("reads own keys only: a __proto__ own key (as JSON.parse creates it) does not throw; it is flagged itself, and what is under it is checked", () => {
    const doc = JSON.parse(`{"x-ext":{"__proto__":{"${UNSAFE}":1},"ok":2}}`) as object;
    expect(Object.keys((doc as { "x-ext": object })["x-ext"])).toEqual(["__proto__", "ok"]);
    expect(findParserUnsafeKeys(doc).map((d) => d.pointer)).toEqual(["/x-ext/__proto__", `/x-ext/__proto__/${UNSAFE}`]);
    expect(findParserUnsafeKeys(setOwn({}, "__proto__", { fine: true })).map((d) => d.pointer)).toEqual(["/__proto__"]);
    // the prototype is never read: an object that INHERITS a member called hasOwnProperty has no such own key
    expect(findParserUnsafeKeys(Object.create({ [UNSAFE]: 1 }))).toEqual([]);
  });

  it("reports at most 20 problems", async () => {
    const doc = baseDocument();
    for (let i = 0; i < 50; i += 1) setOwn(doc.channels as JsonObject, `c${i}`, { [UNSAFE]: 1 });
    const found = await validate(doc);
    expect(found).toHaveLength(20);
    expect(new Set(found.map((d) => d.pointer)).size).toBe(20);
  });

  it("is iterative: a document 100,000 levels deep neither overflows the stack nor throws", () => {
    let deep: Record<string, unknown> = { [UNSAFE]: 1 };
    for (let i = 0; i < 100_000; i += 1) deep = { n: deep };
    const found = findParserUnsafeKeys(deep);
    expect(found).toHaveLength(1);
    expect(found[0].pointer.startsWith("/n/n/n/")).toBe(true);
    expect(found[0].pointer.endsWith(`/n/${UNSAFE}`)).toBe(true);
  });

  it("is bounded: past two million values it stops looking (the parser is the next line) and never throws", () => {
    const big = new Array<number>(2_100_000).fill(0);
    expect(findParserUnsafeKeys({ list: big, tail: { [UNSAFE]: 1 } })).toEqual([]);
  });

  it("does not throw on anything: null, a string, a number, an array", () => {
    for (const value of [null, undefined, UNSAFE, 1, [], [{ a: 1 }], {}]) expect(findParserUnsafeKeys(value)).toEqual([]);
  });

  describe("validate() never throws, however deep the document is (every walk before the parser is iterative)", () => {
    const deepAround = (leaf: Record<string, unknown>, levels: number): Record<string, unknown> => {
      let node = leaf;
      for (let i = 0; i < levels; i += 1) node = { n: node };
      return node;
    };

    it.each([5_000, 100_000])("a document %i levels deep with a remote $ref at the bottom comes back as a REMOTE_REF diagnostic", async (levels) => {
      const found = await validate(deepAround({ $ref: "https://example.com/schema.json" }, levels));
      expect(found.map((d) => d.code)).toEqual(["REMOTE_REF"]);
      expect(found[0].pointer.startsWith("/n/n/n")).toBe(true);
      expect(found[0].pointer.split("/")).toHaveLength(levels + 1);
    });

    it.each([5_000, 100_000])("a document %i levels deep with a parser-unsafe key at the bottom comes back as a PARSER_UNSAFE_KEY diagnostic", async (levels) => {
      const found = await validate(deepAround({ [UNSAFE]: 1 }, levels));
      expect(found.map((d) => d.code)).toEqual(["PARSER_UNSAFE_KEY"]);
    });

    it.each([5_000, 100_000])("a plain document %i levels deep is answered (diagnostics or the generic failure), never a thrown RangeError", async (levels) => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      await expect(validator.validate(deepAround({ x: 1 }, levels))).resolves.toBeDefined();
    });
  });

  it("does not follow a $ref and does not flag its text", () => {
    const doc = baseDocument();
    ((doc.components as JsonObject).schemas as JsonObject).a = { $ref: `#/components/schemas/${UNSAFE}` };
    expect(findParserUnsafeKeys(doc)).toEqual([]);
  });
});

describe("sanitising a crash of the parser", () => {
  const STACK = `Error thrown during AsyncAPI document validation. Name: TypeError, message: target.hasOwnProperty is not a function, stack: TypeError: target.hasOwnProperty is not a function\n    at ResolveCrawler.computeGraph (/Users/someone/src/app/node_modules/@stoplight/json-ref-resolver/crawler.js:35:33)\n    at ResolveCrawler.computeGraph (/Users/someone/src/app/node_modules/@stoplight/json-ref-resolver/crawler.js:41:22)`;
  const crash = (message = STACK, code = "uncaught-error"): Diagnostic => ({ severity: "error", code, message, pointer: "/channels" });

  it("replaces the crash with one generic error, and logs the full text once", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const other: Diagnostic = { severity: "warning", code: "x", message: "a normal problem", pointer: "/info" };
    const out = sanitizeParserDiagnostics([crash(), other, crash()]);
    expect(out).toEqual([other, { severity: "error", code: "ASYNCAPI_PARSER_CRASHED", message: GENERIC, pointer: "" }]);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain("[asyncapi-parser]");
    expect(log.mock.calls[0][1]).toBe(STACK);
  });

  it.each([
    ["a stack-frame line with a function name", "Something broke\n    at Object.run (file.js:1:2)"],
    ["a stack-frame line without one", "Something broke\n    at /srv/app/src/run.js:41:9"],
    ["an async stack frame", "Something broke\n    at async Parser.parse (file:///srv/app/node_modules/@asyncapi/parser/cjs/parser.js:50:21)"],
    ["a node_modules path with its position", "failed in /srv/app/node_modules/ajv/dist/core.js:10:5"],
    ["a macOS path with its position", "cannot read /Users/someone/project/file.js:10:5"],
    ["a Linux path with its line", "cannot read /home/ci/work/file.js:10"],
    ["a Windows path with its position", "cannot read C:\\Users\\ci\\file.js:3:4"],
  ])("replaces a diagnostic with %s, whatever its code", (_label, message) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const out = sanitizeParserDiagnostics([crash(message, "some-rule")]);
    expect(out.map((d) => d.code)).toEqual(["ASYNCAPI_PARSER_CRASHED"]);
    expect(JSON.stringify(out)).not.toMatch(LEAKS);
  });

  it.each([
    ["a pointer with the words home and nope", "\"#/channels/home/messages/nope\" does not exist."],
    ["a pointer through node_modules", "\"#/components/schemas/node_modules\" does not exist."],
    ["the word Users in a name", "Channel /Users/orders is declared twice"],
    ["a path with no file position", "cannot read /home/ci/work/file.json"],
    ["the words at the", "Message must be at the root of the channel: look at the address"],
    ["an address that looks like a time", "Address orders.v1 at 12:30:45 is not a path"],
  ])("is NOT a crash: %s", (_label, message) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(isParserCrashDiagnostic({ code: "invalid-ref", message })).toBe(false);
    const list = [crash(message, "invalid-ref")];
    expect(sanitizeParserDiagnostics(list)).toBe(list);
    expect(log).not.toHaveBeenCalled();
  });

  it("a dangling $ref through the real parser stays an ordinary invalid-ref diagnostic, not a crash (words that look like paths in the pointer)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const ref of ["#/channels/home/messages/nope", "#/components/schemas/node_modules", "#/channels/Users/messages/m"]) {
      const doc = baseDocument();
      ((doc.operations as JsonObject).sendCreated as JsonObject).messages = [{ $ref: ref }];
      const found = await validate(doc);
      const refs = found.filter((d) => d.code === "invalid-ref");
      expect(refs.length, ref).toBeGreaterThan(0);
      expect(refs.some((d) => d.message.includes(ref)), ref).toBe(true);
      expect(found.some((d) => d.code === "ASYNCAPI_PARSER_CRASHED"), ref).toBe(false);
    }
  });

  it("leaves ordinary diagnostics alone (the same array, nothing logged)", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const list: Diagnostic[] = [
      { severity: "error", code: "asyncapi3-schema", message: '"address" property must be string', pointer: "/channels/a/address" },
      { severity: "warning", code: "asyncapi3-channel-no-query-nor-fragment", message: "Channel address /home/page should not include a query", pointer: "/channels/a" },
    ];
    expect(sanitizeParserDiagnostics(list)).toBe(list);
    expect(log).not.toHaveBeenCalled();
  });

  it("isParserCrashDiagnostic accepts the parser's own diagnostics (numeric severity, code as string or number)", () => {
    expect(isParserCrashDiagnostic({ code: "uncaught-error", message: "x" })).toBe(true);
    expect(isParserCrashDiagnostic({ code: 12, message: "fine" })).toBe(false);
  });

  it("the real parser's crash, run through mapParserDiagnostic and the sanitiser, holds no stack and no path", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const doc = baseDocument();
    setOwn(doc.channels as JsonObject, UNSAFE, { address: "x.v1" });
    const raw = await createAsyncApiParser().validate(parserInput(doc));
    expect(raw.some(isParserCrashDiagnostic)).toBe(true);
    const out = sanitizeParserDiagnostics(raw.map(mapParserDiagnostic));
    expect(out.filter((d) => d.code === "ASYNCAPI_PARSER_CRASHED")).toHaveLength(1);
    expect(JSON.stringify(out)).not.toMatch(LEAKS);
  });

  it("validate() turns a crash of the parser for ANY reason into the generic error (the parser is stubbed to crash)", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    inProcess();
    vi.spyOn(Parser.prototype, "parse").mockResolvedValue({
      document: undefined,
      diagnostics: [{ code: "uncaught-error", message: STACK, path: [], severity: 0, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } }],
    } as unknown as Awaited<ReturnType<Parser["parse"]>>);
    const found = await validate(baseDocument());
    expect(found.filter((d) => d.severity === "error")).toEqual([{ severity: "error", code: "ASYNCAPI_PARSER_CRASHED", message: GENERIC, pointer: "" }]);
    expect(JSON.stringify(found)).not.toMatch(LEAKS);
    expect(log.mock.calls.filter((c) => String(c[0]).includes("[asyncapi-parser]"))).toHaveLength(1);
  });

  it("a normal document still validates clean (no crash, no unsafe key)", async () => {
    const found = await validate(baseDocument());
    expect(found.filter((d) => d.severity === "error")).toEqual([]);
  });
});
