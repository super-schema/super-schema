// tests/unit/lib/events/import/source.test.ts
// WP-I1: text → plain object, with every hostile input rejected before anything else touches it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_IMPORT_CONTENT_BYTES } from "@/lib/compiler/import-limits";
import { MAX_ALIAS_COUNT, MAX_NESTING_DEPTH, parseAsyncApiSource } from "@/lib/events/import/source";

const fixture = (name: string): string => readFileSync(path.join(process.cwd(), "tests/fixtures/asyncapi-import", name), "utf8");

function failure(text: string) {
  const result = parseAsyncApiSource(text);
  if (result.success) throw new Error("expected the source to be rejected");
  return result.error;
}

describe("parseAsyncApiSource: accepts", () => {
  it("YAML", () => {
    const result = parseAsyncApiSource("asyncapi: 3.0.0\ninfo:\n  title: T\n  version: '1'\n");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ asyncapi: "3.0.0", info: { title: "T", version: "1" } });
  });

  it("JSON, also when it starts with a byte order mark", () => {
    const result = parseAsyncApiSource(`\uFEFF{ "asyncapi": "3.0.0", "info": { "title": "T", "version": "1" } }`);
    expect(result.success).toBe(true);
  });

  it("any AsyncAPI 3.x version", () => {
    for (const version of ["3.0.0", "3.1.0", "3.0.0-rc1"]) expect(parseAsyncApiSource(`asyncapi: ${version}`).success).toBe(true);
  });

  it("ordinary YAML anchors and aliases below the limit", () => {
    const lines = ["asyncapi: 3.0.0", "x-base: &b {a: 1}"];
    for (let i = 0; i < 50; i += 1) lines.push(`x-copy${i}: *b`);
    expect(parseAsyncApiSource(lines.join("\n")).success).toBe(true);
  });

  it("a document just inside the size limit", () => {
    const filler = "x".repeat(MAX_IMPORT_CONTENT_BYTES - 100);
    expect(parseAsyncApiSource(`asyncapi: 3.0.0\nx-note: ${filler}\n`).success).toBe(true);
  });
});

describe("parseAsyncApiSource: rejects", () => {
  it("text over 1 MiB (TOO_LARGE), counted in bytes not characters", () => {
    expect(failure("a".repeat(MAX_IMPORT_CONTENT_BYTES + 1)).code).toBe("TOO_LARGE");
    // 400,000 three-byte characters are 1.2 MB of UTF-8 although only 400,000 characters long
    const error = failure(`asyncapi: 3.0.0\nx-note: ${"€".repeat(400_000)}\n`);
    expect(error.code).toBe("TOO_LARGE");
    expect(error.message).toMatch(/too large/i);
  });

  it("a YAML alias bomb, without expanding it", () => {
    const started = Date.now();
    const error = failure(fixture("negative-alias-bomb.yaml"));
    expect(error.code).toBe("PARSE_ERROR");
    expect(error.message).toMatch(/alias/i);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it(`more than ${MAX_ALIAS_COUNT} aliases even when each one is small`, () => {
    const lines = ["asyncapi: 3.0.0", "x-base: &b {a: 1}"];
    for (let i = 0; i < MAX_ALIAS_COUNT + 50; i += 1) lines.push(`x-copy${i}: *b`);
    expect(failure(lines.join("\n")).code).toBe("PARSE_ERROR");
  });

  it("a 2.x document (UNSUPPORTED_VERSION) with a message that says what to do", () => {
    const error = failure(fixture("negative-asyncapi-2x.yaml"));
    expect(error.code).toBe("UNSUPPORTED_VERSION");
    expect(error.message).toContain("2.6.0");
    expect(error.message).toMatch(/only AsyncAPI 3\.0/);
    expect(error.suggestedFix).toMatch(/convert/);
  });

  it("an asyncapi field that is not a version string", () => {
    expect(failure("asyncapi: 3\n").code).toBe("UNSUPPORTED_VERSION");
    expect(failure("asyncapi: [3.0.0]\n").code).toBe("UNSUPPORTED_VERSION");
  });

  it("a document without an asyncapi field, and an OpenAPI document by name", () => {
    expect(failure("info:\n  title: T\n").message).toMatch(/"asyncapi" field is missing/);
    expect(failure("openapi: 3.0.0\ninfo:\n  title: T\n").message).toMatch(/OpenAPI/);
  });

  it("text that is not an object: a list, a number, a string, nothing", () => {
    expect(failure("- a\n- b\n").code).toBe("PARSE_ERROR");
    expect(failure("42").code).toBe("PARSE_ERROR");
    expect(failure("just some words").code).toBe("PARSE_ERROR");
    expect(failure("   \n").message).toMatch(/empty/i);
    expect(failure("null").code).toBe("PARSE_ERROR");
  });

  it("broken YAML and broken JSON, naming where", () => {
    const yaml = failure("asyncapi: 3.0.0\ninfo: [unclosed\n");
    expect(yaml.code).toBe("PARSE_ERROR");
    expect(yaml.message).toMatch(/line \d+/);
    const json = failure('{ "asyncapi": "3.0.0", ');
    expect(json.code).toBe("PARSE_ERROR");
    expect(json.message).toMatch(/JSON/);
  });

  it("two YAML documents in one file", () => {
    expect(failure("asyncapi: 3.0.0\n---\nasyncapi: 3.0.0\n").message).toMatch(/more than one/);
  });

  it("a repeated key, in YAML and in JSON", () => {
    expect(failure("asyncapi: 3.0.0\ninfo:\n  title: A\n  title: B\n").message).toMatch(/unique|duplicate/i);
    const json = failure('{ "asyncapi": "3.0.0", "info": { "title": "A", "title": "B" } }');
    expect(json.code).toBe("PARSE_ERROR");
    expect(json.message).toMatch(/unique|duplicate/i);
  });

  it("a __proto__ key anywhere, naming its place", () => {
    const error = failure(fixture("negative-proto-key.yaml"));
    expect(error.code).toBe("PARSE_ERROR");
    expect(error.message).toContain("__proto__");
    expect(error.message).toContain("/channels/orders/messages/orderCreated/payload/properties/__proto__");
  });

  it("__proto__ in JSON text, which JSON.parse turns into an own property", () => {
    const error = failure('{ "asyncapi": "3.0.0", "components": { "messages": { "__proto__": { "payload": {} } } } }');
    expect(error.message).toContain("__proto__");
  });

  it("constructor and prototype keys", () => {
    expect(failure("asyncapi: 3.0.0\nx-a:\n  constructor: 1\n").message).toContain("constructor");
    expect(failure("asyncapi: 3.0.0\nx-a:\n  - prototype: 1\n").message).toContain("/x-a/0/prototype");
  });

  it("nesting deeper than the limit, built iteratively (no stack overflow), in JSON and YAML", () => {
    const depth = MAX_NESTING_DEPTH + 50;
    const json = `{"asyncapi":"3.0.0","x-deep":${"[".repeat(depth)}${"]".repeat(depth)}}`;
    const error = failure(json);
    expect(error.code).toBe("PARSE_ERROR");
    expect(error.message).toMatch(/nested/);
    const yaml = `asyncapi: 3.0.0\nx-deep: ${"[".repeat(depth)}${"]".repeat(depth)}\n`;
    expect(failure(yaml).code).toBe("PARSE_ERROR");
    // far deeper than a recursive parser survives
    expect(failure(`{"asyncapi":"3.0.0","x-deep":${"[".repeat(150_000)}${"]".repeat(150_000)}}`).code).toBe("PARSE_ERROR");
  });

  it("a YAML anchor that contains itself (a cyclic structure), without looping", () => {
    const started = Date.now();
    for (const text of ["asyncapi: 3.0.0\nx-a: &a [*a, *a]\n", "asyncapi: 3.0.0\nx-a: &a {b: *a, c: *a}\n"]) {
      const result = parseAsyncApiSource(text);
      expect(result.success).toBe(false);
    }
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("a document whose aliases expand it past the value limit", () => {
    // 98 aliases of one 25,000-value list stay below the alias limit but expand to ~2.5 million values
    const list = `[${Array.from({ length: 25_000 }, (_, i) => i).join(",")}]`;
    const lines = ["asyncapi: 3.0.0", `x-base: &b ${list}`];
    for (let i = 0; i < 98; i += 1) lines.push(`x-copy${i}: *b`);
    const result = parseAsyncApiSource(lines.join("\n"));
    expect(result.success).toBe(false);
  });
});

describe("parseAsyncApiSource: the cost of keys is linear (a repeated-key check that compares every key with every other one took 42 s for 90,000 keys)", () => {
  const flatJson = (keys: number) => `{"asyncapi":"3.0.0",${Array.from({ length: keys }, (_, i) => `"k${i}":1`).join(",")}}`;
  const flatYaml = (keys: number) => `asyncapi: 3.0.0\n${Array.from({ length: keys }, (_, i) => `k${i}: 1`).join("\n")}\n`;
  const timed = <T,>(body: () => T): { value: T; ms: number } => {
    const started = performance.now();
    const value = body();
    return { value, ms: performance.now() - started };
  };

  it("a flat JSON object of 90,000 keys (about 1 MB) is read in a couple of seconds at most", () => {
    const text = flatJson(90_000);
    expect(text.length).toBeGreaterThan(900_000);
    expect(text.length).toBeLessThan(1024 * 1024);
    const { value, ms } = timed(() => parseAsyncApiSource(text));
    expect(value.success).toBe(true);
    expect(ms).toBeLessThan(3000);
  }, 30_000);

  it("a flat YAML map of 100,000 keys likewise", () => {
    const text = flatYaml(100_000);
    expect(text.length).toBeLessThan(1024 * 1024);
    const { value, ms } = timed(() => parseAsyncApiSource(text));
    expect(value.success).toBe(true);
    expect(ms).toBeLessThan(3000);
  }, 30_000);

  it("150,000 copies of one key are REJECTED fast, in JSON and in YAML, naming the key", () => {
    const json = `{"asyncapi":"3.0.0"${',"a":1'.repeat(150_000)}}`;
    const yaml = `asyncapi: 3.0.0\n${"a: 1\n".repeat(150_000)}`;
    for (const text of [json, yaml]) {
      const { value, ms } = timed(() => parseAsyncApiSource(text));
      expect(value.success).toBe(false);
      if (!value.success) {
        expect(value.error.code).toBe("PARSE_ERROR");
        expect(value.error.message).toMatch(/unique/);
        expect(value.error.message).toContain('"a"');
        expect(value.error.message.length).toBeLessThan(300);
      }
      expect(ms).toBeLessThan(3000);
    }
  }, 30_000);

  it("a repeat is found wherever it is, and says where in YAML", () => {
    expect(failure('{"asyncapi":"3.0.0","info":{"title":"A","version":"1","title":"B"}}').message).toMatch(/unique.*"title"/);
    expect(failure('{"asyncapi":"3.0.0","x":[{"a":1},{"b":1,"b":2}]}').message).toMatch(/"b"/);
    expect(failure("asyncapi: 3.0.0\nx:\n  - a: 1\n  - b: 1\n    b: 2\n").message).toMatch(/"b".*line 5, column 5/);
    expect(failure("asyncapi: 3.0.0\ninfo:\n  title: A\n  title: B\n").message).toMatch(/"title".*line 4, column 3/);
  });

  it("the same key in DIFFERENT maps, and keys that look alike, are not repeats", () => {
    expect(parseAsyncApiSource('{"asyncapi":"3.0.0","a":{"x":1},"b":{"x":2},"c":[{"x":1},{"x":2}]}').success).toBe(true);
    expect(parseAsyncApiSource("asyncapi: 3.0.0\na: {x: 1}\nb: {x: 2}\nc:\n  - x: 1\n  - x: 2\n").success).toBe(true);
    expect(parseAsyncApiSource('{"asyncapi":"3.0.0","a":1,"A":2,"a ":3}').success).toBe(true);
  });

  it("a repeat inside a YAML anchor that is used again is reported once, and aliases are not walked", () => {
    expect(failure("asyncapi: 3.0.0\nx-a: &a\n  k: 1\n  k: 2\nx-b: *a\n").message).toMatch(/unique/);
    expect(parseAsyncApiSource("asyncapi: 3.0.0\nx-a: &a\n  k: 1\nx-b: *a\nx-c: *a\n").success).toBe(true);
  });
});

