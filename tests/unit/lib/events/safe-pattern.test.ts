// A catastrophic pattern is NEVER run in these tests, not even to show that it is slow: they only look at the verdict of the helper
// (`isLinearSafePattern` compiles a pattern it accepts structurally, it never matches one).
import { describe, expect, it } from "vitest";
import type { JsonObject } from "@/lib/event-specs/types";
import { isLinearSafePattern, MAX_SAFE_PATTERN_LENGTH, sanitizeSchemaPatterns } from "@/lib/events/safe-pattern";

describe("isLinearSafePattern: what is handed to the browser", () => {
  it.each([
    "^[A-Z]{2}-\\d{4}$",
    "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    "^\\+?[0-9]{7,15}$",
    "^[a-z0-9-]+$",
    "^(ab|cd)-\\d{4}$",
  ])("keeps the usual pattern %s", (pattern) => {
    expect(isLinearSafePattern(pattern)).toBe(true);
  });

  it.each([
    "^(a+)+$",
    "^(a|aa)+$",
    "^(.*a){20}$",
    "^([a-z])+(\\.[a-z]+)*$",
    "^(?=.*[a-z]).+$",
    "^(a)\\1$",
    "^a*a*a*$",
    "[a-z]+",
    "^[a-z]+",
    "^(abc)+$",
    "^[a-$",
  ])("removes %s", (pattern) => {
    expect(isLinearSafePattern(pattern)).toBe(false);
  });

  it("removes a pattern of 201 characters and keeps one of exactly 200", () => {
    expect(MAX_SAFE_PATTERN_LENGTH).toBe(200);
    expect(isLinearSafePattern(`^${"a".repeat(198)}$`)).toBe(true);
    expect(isLinearSafePattern(`^${"a".repeat(199)}$`)).toBe(false);
  });

  it("wants both anchors, the last one a real `$`: not escaped, not inside a class, not inside a group, not followed by anything", () => {
    for (const pattern of ["abc$", "^abc", "^abc\\$", "^[abc$]", "^(abc$)", "^a$b", "^", "$", "", "^$^"]) {
      // `^$^` anchors at both ends but ends with `^`, and `^` / `$` alone are no pattern of ours
      expect(isLinearSafePattern(pattern), pattern).toBe(false);
    }
    expect(isLinearSafePattern("^$")).toBe(true);
    expect(isLinearSafePattern("^a$$")).toBe(true);
  });

  it("removes every back reference and lookaround", () => {
    for (const pattern of ["^(a)\\1$", "^(a)(b)\\2$", "^(?<x>a)\\k<x>$", "^(?=a)a$", "^(?!a)b$", "^(?<=a)b$", "^(?<!a)b$", "^(a)\\10$"]) {
      expect(isLinearSafePattern(pattern), pattern).toBe(false);
    }
  });

  it("removes a quantified group, whatever the quantifier, and keeps the groups themselves", () => {
    for (const pattern of ["^(a)*$", "^(a)+$", "^(a)?$", "^(a){2}$", "^(a){2,}$", "^(a){2,3}$", "^(?:a)+$", "^(?<n>a)*$", "^(a|b)+?$", "^((a))+$"]) {
      expect(isLinearSafePattern(pattern), pattern).toBe(false);
    }
    for (const pattern of ["^(a)$", "^(?:ab|cd)-\\d{4}$", "^(?<year>\\d{4})-(?<month>\\d{2})$", "^((a|b)c)d$", "^()$", "^(|a)$"]) {
      expect(isLinearSafePattern(pattern), pattern).toBe(true);
    }
  });

  it("allows ONE unbounded quantifier (`*`, `+`, `{n,}`, lazy or not) and bounded ones freely", () => {
    for (const pattern of ["^a*$", "^a+$", "^a{2,}$", "^a+?$", "^[a-z]{2,}-\\d{4}$", "^\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}$", "^a?b{2}c{1,3}.+$", "^\\p{L}+$", "^\\u{1F600}$", "^.$"]) {
      expect(isLinearSafePattern(pattern), pattern).toBe(true);
    }
    for (const pattern of ["^a+b+$", "^a*b{2,}$", "^a{1,}b{1,}$", "^.*.*$", "^a+?b*?$", "^\\d+\\.\\d+\\.\\d+$"]) {
      expect(isLinearSafePattern(pattern), pattern).toBe(false);
    }
  });

  it("removes what has no choice-free reading either: a top-level `|`, a quantifier with nothing to repeat, two quantifiers on one atom", () => {
    for (const pattern of ["^a$|^b$", "^a|b$", "^*a$", "^+$", "^?$", "^(*a)$", "^a|$", "^a**$", "^a+*$", "^(a|*)$", "^a{2}{3}$", "^\\b+$", "^a$*"]) {
      expect(isLinearSafePattern(pattern), pattern).toBe(false);
    }
  });

  it("removes what the `u` flag does not compile or the tokenizer cannot read", () => {
    for (const pattern of [
      "^[a-$", "^(a$", "^a)$", "^a{$", "^a{2,1}$", "^a{,3}$", "^a]$", "^a}$", "^{2}$", "^[[a-z]]$", "^[z-a]$", "^\\p{Nope}$", "^\\p$", "^\\k<a>$",
      "^\\$", "^a\\", "^\\a$", "^\\-$", "^(?i:a)$", "^(?<=a)$", "^[\\1]$",
    ]) {
      expect(isLinearSafePattern(pattern), pattern).toBe(false);
    }
  });

  it("limits what the choices multiply to: `a?` x 30 and `(a|a)` x 30 have no quantified group and are still exponential", () => {
    expect(isLinearSafePattern(`^${"a?".repeat(30)}${"a".repeat(30)}$`)).toBe(false);
    expect(isLinearSafePattern(`^${"(a|a)".repeat(30)}$`)).toBe(false);
    expect(isLinearSafePattern("^a{0,999}a{0,999}$")).toBe(false);
    expect(isLinearSafePattern("^[a-z]{1,1000}$")).toBe(true);
    expect(isLinearSafePattern("^[a-z]{1,1001}$")).toBe(false);
    // 2^9 = 512 is within the limit, 2^10 = 1,024 is over it
    expect(isLinearSafePattern(`^${"a?".repeat(9)}$`)).toBe(true);
    expect(isLinearSafePattern(`^${"a?".repeat(10)}$`)).toBe(false);
    // what a phone number, an address and a short alternation of words need
    for (const pattern of ["^\\+?\\d{1,3}[- ]?\\d{3,4}[- ]?\\d{4}$", "^(gmail|yahoo|outlook)\\.com$", "^(a|b)(c|d)(e|f)(g|h)$"]) {
      expect(isLinearSafePattern(pattern), pattern).toBe(true);
    }
  });
});

describe("sanitizeSchemaPatterns", () => {
  const BAD = "^(a+)+$";
  const GOOD = "^[a-z]{3}$";
  const withPatterns = (): JsonObject => ({ type: "string", pattern: BAD, description: "kept" });

  it("keeps a safe pattern and removes an unsafe one, at the root and in every schema position", () => {
    const keep = (node: JsonObject): JsonObject => ({ ...node, pattern: GOOD });
    const schema: JsonObject = {
      type: "object",
      pattern: BAD,
      properties: { a: withPatterns(), b: keep({ type: "string" }) },
      patternProperties: { "^x-": withPatterns() },
      additionalProperties: withPatterns(),
      items: withPatterns(),
      additionalItems: withPatterns(),
      contains: withPatterns(),
      propertyNames: withPatterns(),
      allOf: [withPatterns(), keep({})],
      anyOf: [withPatterns()],
      oneOf: [withPatterns()],
      prefixItems: [withPatterns()],
      not: withPatterns(),
      if: withPatterns(),
      then: withPatterns(),
      else: withPatterns(),
      definitions: { D: withPatterns() },
      $defs: { E: withPatterns() },
      dependencies: { a: withPatterns(), b: ["a"] },
      dependentSchemas: { a: withPatterns() },
    };
    const out = sanitizeSchemaPatterns(schema);
    const text = JSON.stringify(out);
    expect(text).not.toContain(BAD);
    expect(text.split(GOOD)).toHaveLength(3); // the safe pattern is still there twice: on `b` and on the second entry of `allOf`
    expect(out.properties).toEqual({ a: { type: "string", description: "kept" }, b: { type: "string", pattern: GOOD } });
    expect((out.allOf as JsonObject[])[1]).toEqual({ pattern: GOOD });
    expect(out.dependencies).toEqual({ a: { type: "string", description: "kept" }, b: ["a"] });
    expect(out.definitions).toEqual({ D: { type: "string", description: "kept" } });
    expect(out.$defs).toEqual({ E: { type: "string", description: "kept" } });
    expect(out.prefixItems).toEqual([{ type: "string", description: "kept" }]);
    expect(out).not.toHaveProperty("pattern");
    expect(Object.keys(out).sort()).toEqual(Object.keys(schema).filter((key) => key !== "pattern").sort());
  });

  it("leaves a schema without a bad pattern as it was, including every other keyword", () => {
    const schema: JsonObject = {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      required: ["id", "code"],
      properties: { id: { type: "string", format: "uuid" }, code: { type: "string", pattern: GOOD, minLength: 3 }, tags: { type: "array", items: [{ type: "string" }, { type: "number" }] } },
      definitions: { Status: { type: "string", enum: ["NEW", "PAID"] } },
      "x-note": { anything: [1, 2, { nested: true }] },
    };
    expect(sanitizeSchemaPatterns(schema)).toEqual(schema);
  });

  it("removes a `pattern` whose value is not a string", () => {
    for (const pattern of [5, true, null, ["^a$"], { x: 1 }, {}]) {
      const out = sanitizeSchemaPatterns({ type: "string", properties: { a: { type: "string", pattern } as JsonObject } });
      expect(out, JSON.stringify(pattern)).toEqual({ type: "string", properties: { a: { type: "string" } } });
    }
  });

  it("removes a `patternProperties` entry whose KEY is unsafe, with the schema under it, and keeps the others", () => {
    const out = sanitizeSchemaPatterns({
      type: "object",
      patternProperties: { [BAD]: { type: "string" }, "^(a|aa)+$": { type: "number" }, "^x-[a-z]+$": { type: "string", pattern: BAD }, "not anchored": { type: "string" }, "^id_[0-9]{4}$": { type: "integer" } },
    });
    expect(out).toEqual({ type: "object", patternProperties: { "^x-[a-z]+$": { type: "string" }, "^id_[0-9]{4}$": { type: "integer" } } });
  });

  it("does not mistake a NAME for a keyword: a property, definition or dependency called `pattern` or `patternProperties` stays", () => {
    const schema: JsonObject = {
      type: "object",
      properties: { pattern: { type: "string", pattern: BAD }, patternProperties: { type: "object", properties: { pattern: { type: "string" } } } },
      definitions: { pattern: { type: "string" } },
      $defs: { pattern: { type: "string" } },
      dependencies: { pattern: ["x"], other: { properties: { pattern: { type: "string" } } } },
    };
    expect(sanitizeSchemaPatterns(schema)).toEqual({
      type: "object",
      properties: { pattern: { type: "string" }, patternProperties: { type: "object", properties: { pattern: { type: "string" } } } },
      definitions: { pattern: { type: "string" } },
      $defs: { pattern: { type: "string" } },
      dependencies: { pattern: ["x"], other: { properties: { pattern: { type: "string" } } } },
    });
  });

  it("copies the data keywords as they are (an enum member or a default may hold a key called `pattern`)", () => {
    const schema: JsonObject = {
      type: "object",
      properties: { a: { enum: [{ pattern: "abc" }], default: { pattern: "abc" } }, b: { const: { pattern: BAD } }, c: { examples: [{ pattern: "x" }], example: { pattern: "y" } } },
    };
    expect(sanitizeSchemaPatterns(schema)).toEqual(schema);
  });

  it("also cleans a schema under an unknown or `x-` keyword: a `$ref` may point anywhere", () => {
    const out = sanitizeSchemaPatterns({ $ref: "#/x-hidden", "x-hidden": { type: "string", pattern: BAD }, nested: { deeper: [{ pattern: BAD }] } });
    expect(out).toEqual({ $ref: "#/x-hidden", "x-hidden": { type: "string" }, nested: { deeper: [{}] } });
  });

  it("returns a copy and never changes its input", () => {
    const schema: JsonObject = {
      type: "object",
      pattern: BAD,
      properties: { a: withPatterns() },
      patternProperties: { [BAD]: { type: "string" } },
      allOf: [withPatterns()],
      definitions: { E: { enum: [{ pattern: "x" }] } },
    };
    const before = JSON.stringify(schema);
    const out = sanitizeSchemaPatterns(schema);
    expect(JSON.stringify(schema)).toBe(before);
    expect(out).not.toBe(schema);
    expect(out.properties).not.toBe(schema.properties);
    expect((out.properties as JsonObject).a).not.toBe((schema.properties as JsonObject).a);
    expect(out.allOf).not.toBe(schema.allOf);
    expect(((out.definitions as JsonObject).E as JsonObject).enum).not.toBe(((schema.definitions as JsonObject).E as JsonObject).enum);
  });

  it("keeps a key called __proto__ as the own property it is", () => {
    const schema = JSON.parse(`{"type":"object","properties":{"__proto__":{"type":"string","pattern":"^(a+)+$"},"ok":{"type":"string"}}}`) as JsonObject;
    const out = sanitizeSchemaPatterns(schema);
    const properties = out.properties as JsonObject;
    expect(Object.keys(properties)).toEqual(["__proto__", "ok"]);
    expect(Object.getOwnPropertyDescriptor(properties, "__proto__")?.value).toEqual({ type: "string" });
    expect(Object.getPrototypeOf(properties)).toBe(Object.prototype);
  });

  it("handles a sub-object shared by many places once: a chain that doubles 60 times is not unfolded", () => {
    // each level uses the one below it twice; walked as a tree that is 2^60 visits
    let level: JsonObject = withPatterns();
    for (let i = 0; i < 60; i++) level = { type: "object", properties: { left: level, right: level }, pattern: BAD };
    const started = performance.now();
    const out = sanitizeSchemaPatterns(level);
    expect(performance.now() - started).toBeLessThan(500);
    let node = out;
    for (let i = 0; i < 60; i++) {
      expect(node).not.toHaveProperty("pattern");
      const { left, right } = node.properties as JsonObject;
      expect(left).toBe(right); // shared again, not duplicated
      node = left as JsonObject;
    }
    expect(node).toEqual({ type: "string", description: "kept" });
  });

  it("copes with a cycle (the schema is JSON, so it has none, but it must not hang)", () => {
    const schema: JsonObject = { type: "object", pattern: BAD };
    (schema as Record<string, unknown>).properties = { self: schema };
    const out = sanitizeSchemaPatterns(schema);
    expect(out).not.toHaveProperty("pattern");
    expect(((out.properties as JsonObject).self) as JsonObject).toBe(out);
  });

  it("is iterative: a schema nested 50,000 levels deep does not overflow the stack", () => {
    let schema: JsonObject = { type: "string", pattern: BAD };
    for (let i = 0; i < 50_000; i++) schema = { type: "object", properties: { a: schema } };
    let node = sanitizeSchemaPatterns(schema);
    for (let i = 0; i < 50_000; i++) node = (node.properties as JsonObject).a as JsonObject;
    expect(node).toEqual({ type: "string" });
  });

  it("costs the size of the schema: 100,000 properties, each with a pattern, many of them the same", () => {
    const properties: JsonObject = {};
    for (let i = 0; i < 100_000; i++) properties[`p${i}`] = { type: "string", pattern: i % 2 === 0 ? BAD : GOOD, "x-n": i };
    const started = performance.now();
    const out = sanitizeSchemaPatterns({ type: "object", properties });
    expect(performance.now() - started).toBeLessThan(2_000);
    const copied = out.properties as Record<string, JsonObject>;
    expect(Object.keys(copied)).toHaveLength(100_000);
    expect(copied.p0).toEqual({ type: "string", "x-n": 0 });
    expect(copied.p1).toEqual({ type: "string", pattern: GOOD, "x-n": 1 });
  });

  it("does not look at a pattern longer than the limit twice, and never at a million-character one", () => {
    const huge = `^${"a".repeat(1_000_000)}$`;
    const started = performance.now();
    const out = sanitizeSchemaPatterns({ type: "object", pattern: huge, patternProperties: { [huge]: { type: "string" } }, properties: { a: { pattern: huge } } });
    expect(performance.now() - started).toBeLessThan(200);
    expect(out).toEqual({ type: "object", patternProperties: {}, properties: { a: {} } });
  });
});
