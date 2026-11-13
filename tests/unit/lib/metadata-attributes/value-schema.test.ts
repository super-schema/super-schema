import { describe, expect, it } from "vitest";
import { checkValueSchema, validateValue } from "@/lib/metadata-attributes/value-schema";

describe("checkValueSchema", () => {
  it("accepts a nested subset schema", () => {
    expect(checkValueSchema({ type: "object", properties: { a: { type: "string", enum: ["x"] } } })).toEqual([]);
  });
  it("rejects oneOf, naming it", () => {
    const p = checkValueSchema({ type: "string", oneOf: [{ type: "string" }] });
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("oneOf");
  });
  it("recurses into items and properties", () => {
    expect(checkValueSchema({ type: "array", items: { type: "string", anyOf: [] } }).join()).toContain("anyOf");
    expect(checkValueSchema({ type: "object", properties: { a: { type: "nope" } } })).not.toEqual([]);
  });
  it("rejects non-objects", () => {
    expect(checkValueSchema(null)).not.toEqual([]);
    expect(checkValueSchema("x")).not.toEqual([]);
  });
});

describe("validateValue", () => {
  it("reports an enum miss at the root", () => {
    const r = validateValue("Partner", { type: "string", enum: ["A"] });
    expect(r).toHaveLength(1);
    expect(r[0].path).toBe("");
  });
  it("reports a pattern miss at /data_class", () => {
    const r = validateValue(
      { data_class: "class9" },
      { type: "object", properties: { data_class: { type: "string", pattern: "^class[1-5]$" } } },
    );
    expect(r.map((x) => x.path)).toEqual(["/data_class"]);
  });
  it("accepts valid values and checks required, ranges, items, types", () => {
    expect(
      validateValue(
        { data_class: "class2" },
        { type: "object", properties: { data_class: { type: "string", pattern: "^class[1-5]$" } }, required: ["data_class"] },
      ),
    ).toEqual([]);
    expect(validateValue({}, { type: "object", required: ["a"] })[0].path).toBe("/a");
    expect(validateValue(5, { type: "integer", minimum: 6 })).toHaveLength(1);
    expect(validateValue(1.5, { type: "integer" })).toHaveLength(1);
    expect(validateValue(["a", 1], { type: "array", items: { type: "string" } })[0].path).toBe("/1");
    expect(validateValue("abc", { type: "string", maxLength: 2 })).toHaveLength(1);
    expect(validateValue(true, { type: "boolean" })).toEqual([]);
  });
});

describe("ReDoS limits (D1)", () => {
  it("rejects a pattern longer than 256 characters", () => {
    expect(checkValueSchema({ type: "string", pattern: "a".repeat(257) }).join()).toContain("256");
    expect(checkValueSchema({ type: "string", pattern: "a".repeat(256) })).toEqual([]);
  });
  it.each(["(a+)+", "(a*)*", "(a|aa)+", "^(\\w+\\s?)*$", "(?:x+y?)+", "((ab)*)+", "(a{1,3})+"])("rejects the nested quantifier %s", (pattern) => {
    expect(checkValueSchema({ type: "string", pattern }).join()).toContain("nested quantifier");
  });
  it.each(["^class[1-5]$", "^[a-z]+$", "(ab)+", "^(foo|bar)$", "\\(a+\\)+", "[(a+)]+", "^x-[A-Za-z0-9]+$"])("accepts the safe pattern %s", (pattern) => {
    expect(checkValueSchema({ type: "string", pattern })).toEqual([]);
  });
  it("limits nesting to depth 10", () => {
    let schema: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 11; i++) schema = { type: "array", items: schema };
    expect(checkValueSchema(schema).join()).toContain("nested more than 10 levels");
    let ok: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 9; i++) ok = { type: "array", items: ok };
    expect(checkValueSchema(ok)).toEqual([]);
  });
  it("skips the pattern test for a string longer than 10,000 characters, and says so", () => {
    const r = validateValue("a".repeat(10_001), { type: "string", pattern: "^b" });
    expect(r).toEqual([{ path: "", message: "value too long to check pattern" }]);
    expect(validateValue("a".repeat(10_000), { type: "string", pattern: "^a+$" })).toEqual([]);
  });
});
