import { afterEach, describe, expect, it } from "vitest";
import {
  budgetPreservedValues,
  createResolveBudget,
  parseJsonSchemaDocument,
  setResolveWorkLimitForTests,
  MAX_RESOLVE_WORK,
} from "@/lib/importers/jsonschema.importer";
import type { ParsedEntity } from "@/lib/importers/types";

/**
 * The visit budget counted visits, not the work of a visit. N `oneOf` / `items` / property references to ONE shared definition each got
 * their own view of the definition's keys, re-serialised its values to compare them, and `budgetPreservedValues` concatenated a new copy of
 * the value per entry: 790 KB blocked the loop for 17 s, 652 KB took 24.6 s and 2.7 GB, 1.4 MB aborted the process on the heap limit.
 *
 * The budget now measures UNIQUE content: a definition's keys are viewed once per import, folded once per field however many members name it,
 * a value is compared by identity first and serialised once, and a work counter (keys and bytes processed, not only visits) refuses what is
 * still too large. These documents are scaled-down copies of the reported shapes; each took seconds before the fix.
 */
const BIG = 100_000;
const FAST_MS = 1500;

function refsTo(def: string, count: number): Array<{ $ref: string }> {
  return Array.from({ length: count }, () => ({ $ref: `#/$defs/${def}` }));
}

function run(doc: unknown) {
  const budget = createResolveBudget();
  const started = Date.now();
  const result = parseJsonSchemaDocument(JSON.stringify(doc), budget);
  return { result, budget, ms: Date.now() - started };
}

afterEach(() => setResolveWorkLimitForTests(undefined));

describe("one definition referenced by thousands of oneOf members", () => {
  it("a 100 KB vendor key on the definition is folded once: a bounded work counter, kept once, no stall", () => {
    const { result, budget, ms } = run({
      type: "object",
      properties: { f: { oneOf: refsTo("Big", 8000) } },
      $defs: { Big: { type: "string", "x-big": "x".repeat(BIG) } },
    });
    expect(ms).toBeLessThan(FAST_MS);
    expect(budget.work).toBeLessThan(100_000);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const f = result.data.entities[0]!.fields[0]!;
    expect((f.extensions?.["x-big"] as string).length).toBe(BIG);
  });

  it("1000 small vendor keys on the definition: the keys are processed once, not once per member", () => {
    const def: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 1000; i++) def[`x-k${i}`] = "v";
    const { result, budget, ms } = run({ type: "object", properties: { f: { oneOf: refsTo("Big", 4000) } }, $defs: { Big: def } });
    expect(ms).toBeLessThan(FAST_MS);
    expect(budget.work).toBeLessThan(100_000);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(Object.keys(result.data.entities[0]!.fields[0]!.extensions ?? {})).toHaveLength(1000);
  });

  it("a 50 KB description (an element key, kept per site) is kept once, not once per member: a small response, bounded memory", () => {
    const { result, budget, ms } = run({
      type: "object",
      properties: { f: { oneOf: refsTo("Big", 3000) } },
      $defs: { Big: { type: "string", description: "d".repeat(50_000) } },
    });
    expect(ms).toBeLessThan(FAST_MS);
    expect(budget.work).toBeLessThan(100_000);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(JSON.stringify(result.data).length).toBeLessThan(500_000);
    const f = result.data.entities[0]!.fields[0]!;
    expect(Object.keys(f.extensions ?? {}).filter((k) => k.endsWith("-description"))).toHaveLength(1);
  });

  it("the same for `items`: a field per reference, a 100 KB value on the definition", () => {
    const props: Record<string, unknown> = {};
    for (let i = 0; i < 3000; i++) props[`p${i}`] = { type: "array", items: { $ref: "#/$defs/Big" } };
    const { result, budget, ms } = run({ type: "object", properties: props, $defs: { Big: { type: "string", "x-big": "x".repeat(BIG) } } });
    expect(ms).toBeLessThan(FAST_MS);
    expect(budget.work).toBeLessThan(200_000);
    expect(result.success).toBe(true);
    if (!result.success) return;
    // the budget on preserved values keeps the first copies and says it dropped the rest
    expect(result.data.warnings.some((w) => /x-big.*not repeated/i.test(w))).toBe(true);
    expect(JSON.stringify(result.data).length).toBeLessThan(4_000_000);
  });

  it("the same for property references: a field per reference, a 100 KB value on the definition", () => {
    const props: Record<string, unknown> = {};
    for (let i = 0; i < 3000; i++) props[`p${i}`] = { $ref: "#/$defs/Big" };
    const { result, budget, ms } = run({ type: "object", properties: props, $defs: { Big: { type: "string", "x-big": "x".repeat(BIG) } } });
    expect(ms).toBeLessThan(FAST_MS);
    expect(budget.work).toBeLessThan(200_000);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.warnings.some((w) => /x-big.*not repeated/i.test(w))).toBe(true);
  });

  it("two members naming one definition report its keys once (the repeat adds nothing: same definition, same values)", () => {
    const { result } = run({
      type: "object",
      properties: { u: { oneOf: [{ $ref: "#/$defs/Tag" }, { $ref: "#/$defs/Tag" }, { type: "integer" }] } },
      $defs: { Tag: { type: "string", "x-tag": { a: 1 }, description: "a tag" } },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const keys = Object.keys(result.data.entities[0]!.fields[0]!.extensions ?? {});
    expect(keys.filter((k) => k === "x-tag")).toHaveLength(1);
    expect(keys.filter((k) => k.endsWith("-description"))).toHaveLength(1);
  });
});

describe("the work counter", () => {
  it("refuses, with the importer's own error, a schema that needs more work than the limit (keys copied onto fields)", () => {
    setResolveWorkLimitForTests(1000);
    const def: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 50; i++) def[`x-k${i}`] = "v";
    const props: Record<string, unknown> = {};
    for (let i = 0; i < 100; i++) props[`p${i}`] = { $ref: "#/$defs/Big" };
    const { result } = run({ type: "object", properties: props, $defs: { Big: def } });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe("PARSE_ERROR");
    expect(result.error.message).toMatch(/too large to resolve/i);
  });

  it("is a work limit of its own: well above what the largest accepted document spends (about 250,000), far below a stall", () => {
    expect(MAX_RESOLVE_WORK).toBeGreaterThanOrEqual(500_000);
    expect(MAX_RESOLVE_WORK).toBeLessThanOrEqual(2_000_000);
  });

  it("refuses ONE definition with thousands of keys referenced by thousands of properties, in about a second (22 s before)", () => {
    const def: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 2000; i++) def[`x-k${i}`] = "v";
    const props: Record<string, unknown> = {};
    for (let i = 0; i < 6000; i++) props[`p${i}`] = { $ref: "#/$defs/Big" };
    const { result, ms } = run({ type: "object", properties: props, $defs: { Big: def } });
    expect(ms).toBeLessThan(3000);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toMatch(/too large to resolve/i);
  });

  it("still imports a legitimate large schema in full: 300 properties, 40 shared definitions each referenced 5 times, every extension kept", () => {
    const defs: Record<string, unknown> = {};
    for (let d = 0; d < 40; d++) {
      defs[`D${d}`] = {
        type: "string",
        maxLength: 20 + d,
        description: `definition ${d}`,
        "x-owner": `team-${d}`,
        "x-pii": { level: d % 3, tags: ["a", "b"] },
        default: `d${d}`,
      };
    }
    const props: Record<string, unknown> = {};
    for (let i = 0; i < 300; i++) {
      const d = i % 40;
      props[`p${i}`] =
        i % 3 === 0
          ? { $ref: `#/$defs/D${d}` }
          : i % 3 === 1
            ? { type: "array", items: { $ref: `#/$defs/D${d}` } }
            : { oneOf: [{ $ref: `#/$defs/D${d}` }, { $ref: `#/$defs/D${(d + 1) % 40}` }] };
    }
    const { result, budget, ms } = run({ title: "Wide", type: "object", properties: props, $defs: defs });
    expect(ms).toBeLessThan(FAST_MS);
    expect(budget.work).toBeLessThan(MAX_RESOLVE_WORK / 10);
    expect(result.success).toBe(true);
    if (!result.success) return;
    const fields = result.data.entities[0]!.fields;
    expect(fields).toHaveLength(300);
    expect(result.data.warnings.filter((w) => /not repeated|too large/i.test(w))).toEqual([]);
    for (let i = 0; i < 300; i++) {
      const d = i % 40;
      const ext = fields[i]!.extensions ?? {};
      expect(ext["x-owner"], `p${i} x-owner`).toBe(`team-${d}`);
      expect(ext["x-pii"], `p${i} x-pii`).toEqual({ level: d % 3, tags: ["a", "b"] });
      expect(ext.default, `p${i} default`).toBe(`d${d}`);
    }
  });
});

describe("budgetPreservedValues is linear in the entries, with no copy of a value per entry", () => {
  it("2000 entries holding one 100 KB value under distinct keys: no stall, no per-entry copy, a bounded warning list", () => {
    const value = "v".repeat(BIG);
    const fields = Array.from({ length: 2000 }, (_, i) => ({ name: `f${i}`, extensions: { [`x-site-${i}`]: value } }));
    const entities = [{ name: "E", fields }] as unknown as ParsedEntity[];
    const warnings: string[] = [];
    const before = process.memoryUsage().heapUsed;
    const started = Date.now();
    budgetPreservedValues(entities, warnings);
    expect(Date.now() - started).toBeLessThan(1000);
    // the old code kept a new 100 KB string per entry (200 MB here)
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(60_000_000);
    expect(warnings.length).toBeLessThanOrEqual(25);
    // the budget is spent on the first copies; the rest is dropped
    const kept = fields.filter((f) => f.extensions !== undefined).length;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(50);
  });

  it("a value repeated under the SAME key is dropped after the budget exactly as before (first copy kept, one warning per key)", () => {
    const value = "v".repeat(BIG);
    const fields = Array.from({ length: 100 }, (_, i) => ({ name: `f${i}`, extensions: { "x-big": value } }));
    const warnings: string[] = [];
    budgetPreservedValues([{ name: "E", fields }] as unknown as ParsedEntity[], warnings);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/x-big.*not repeated/i);
    expect((fields[0]!.extensions as Record<string, string>)["x-big"]).toHaveLength(BIG);
  });
});
