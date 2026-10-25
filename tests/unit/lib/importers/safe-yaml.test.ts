import { describe, expect, it } from "vitest";
import {
  YAML_MAX_ALIAS_COUNT,
  expandedBudgetFor,
  expandedSizeExceeds,
  parseYamlBounded,
} from "@/lib/importers/safe-yaml";
import { parseJsonSchemaDocument } from "@/lib/importers/jsonschema.importer";
import { resolveJsonSchemaRefs } from "@/lib/importers/jsonschema-ref-resolver";
import { importJsonSchemaFromUrl } from "@/lib/importers/jsonschema-url-import";
import { detectFormat } from "@/lib/importers/format-detector";
import { parseAsyncApiSource } from "@/lib/events/import/source";

/**
 * YAML aliases share one parsed node, so a small file can name a huge value many times: `x-big: &b [1, 1, ... x900k]` plus
 * `x-many: [*b x40]` is 1.8 MB of text that every later `JSON.stringify` / walk expands to 36 million values (the 4 GB heap abort of the
 * final review). These tests use the same shape scaled down (the limits are relative to the text, so the proportions are the same).
 */
const ones = (n: number): string => `[${Array.from({ length: n }, () => "1").join(",")}]`;
/** A list of empty lists: the parser scales its alias count to 0 for an anchor that holds only empty collections, so its guard never fires. */
const emptyLists = (n: number): string => `[${Array.from({ length: n }, () => "[]").join(",")}]`;
const aliases = (n: number): string => `[${Array.from({ length: n }, () => "*b").join(",")}]`;
const hostile = (elements: number, aliasCount: number, head = "title: Hostile\ntype: object\nproperties:\n  a:\n    type: string\n"): string =>
  `${head}x-big: &b ${ones(elements)}\nx-many: ${aliases(aliasCount)}\n`;

const PUBLIC = async () => ["93.184.216.34"];

describe("parseYamlBounded", () => {
  it("parses ordinary YAML, aliases included", () => {
    const r = parseYamlBounded("base: &b {a: 1, b: [x, y]}\ncopy: *b\nlist: [*b, *b]\n");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ base: { a: 1, b: ["x", "y"] }, copy: { a: 1, b: ["x", "y"] }, list: [{ a: 1, b: ["x", "y"] }, { a: 1, b: ["x", "y"] }] });
  });

  it("allows many aliases of a small anchor", () => {
    const lines = ["x-base: &b {a: 1}"];
    for (let i = 0; i < YAML_MAX_ALIAS_COUNT - 2; i++) lines.push(`x-copy${i}: *b`);
    expect(parseYamlBounded(lines.join("\n")).ok).toBe(true);
  });

  it("rejects 40 aliases of one big anchor (the final review's shape), fast, without expanding it", () => {
    const text = hostile(20_000, 40);
    const started = Date.now();
    const before = process.memoryUsage().heapUsed;
    const r = parseYamlBounded(text);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("aliases");
      expect("message" in r && r.message).toMatch(/alias/i);
    }
    expect(Date.now() - started).toBeLessThan(1000);
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(64 * 1024 * 1024);
  });

  it("rejects aliases the parser's own guard lets through when the expanded document dwarfs the text (the size walk, not the alias count)", () => {
    // An anchor holding only empty lists scales the parser's count to 0, so 40 aliases of it pass the alias guard; 41 x 5,000 values is
    // far more than 5x the 15 KB of text
    const text = `x-big: &b ${emptyLists(5_000)}\nx-many: ${aliases(40)}\n`;
    const started = Date.now();
    const r = parseYamlBounded(text);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("expansion");
      expect("message" in r && r.message).toMatch(/expands to more than/i);
    }
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("rejects a billion-laughs ladder", () => {
    const lines = ["a: &a [x, x, x, x, x, x, x, x, x]"];
    for (const [prev, next] of [["a", "b"], ["b", "c"], ["c", "d"], ["d", "e"], ["e", "f"], ["f", "g"]]) {
      lines.push(`${next}: &${next} [${Array.from({ length: 9 }, () => `*${prev}`).join(", ")}]`);
    }
    const r = parseYamlBounded(lines.join("\n"));
    expect(r.ok).toBe(false);
  });

  it("accepts a large document with no aliases at all (no ratio applies to text that is simply big)", () => {
    const r = parseYamlBounded(`x-data: ${ones(200_000)}\n`);
    expect(r.ok).toBe(true);
  });

  it("reports malformed YAML as a syntax failure carrying the parser's error", () => {
    const r = parseYamlBounded("a: [1, 2\nb: :");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("syntax");
  });

  it("budget: 5x the text, at least 10,000 values, at most 5 million", () => {
    expect(expandedBudgetFor(100)).toBe(10_000);
    expect(expandedBudgetFor(100_000)).toBe(500_000);
    expect(expandedBudgetFor(50_000_000)).toBe(5_000_000);
  });

  it("the walk counts every visit (a shared node is counted once per use) and stops at the limit", () => {
    const shared = Array.from({ length: 1000 }, (_, i) => i);
    const doc = { a: shared, b: shared, c: shared };
    expect(expandedSizeExceeds(doc, 4_000)).toBe(false);
    expect(expandedSizeExceeds(doc, 2_500)).toBe(true);
  });

  it("charges long strings by length: a 1 MB string named 11 times is not free", () => {
    const text = "x".repeat(1_000_000);
    const doc = { items: Array.from({ length: 200 }, () => text) };
    expect(expandedSizeExceeds(doc, 10_000)).toBe(true);
  });

  it("walks a cyclic structure without hanging", () => {
    const loop: unknown[] = [1];
    loop.push(loop);
    expect(expandedSizeExceeds(loop, 10_000)).toBe(true);
  });
});

describe("every YAML parse site rejects the alias fan-out", () => {
  it("the JSON Schema importer (paste path): a clear PARSE_ERROR, not 'Invalid JSON'", () => {
    const started = Date.now();
    const r = parseJsonSchemaDocument(hostile(20_000, 40));
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.code).toBe("PARSE_ERROR");
      expect(r.error.message).toMatch(/alias/i);
    }
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("the JSON Schema importer: a fan-out the parser's alias guard does not see is rejected by the size walk", () => {
    const text = `title: T\ntype: object\nproperties:\n  a:\n    type: string\nx-big: &b ${emptyLists(5_000)}\nx-many: ${aliases(40)}\n`;
    const r = parseJsonSchemaDocument(text);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.message).toMatch(/expands to more than/i);
  });

  it("the ref resolver: a root document is refused, a $ref target is recorded as unreachable and the rest is kept", async () => {
    const root = JSON.stringify({ title: "Root", type: "object", properties: { good: { $ref: "https://example.com/good.json" }, bomb: { $ref: "https://example.com/bomb.yaml" } } });
    const files = new Map<string, string>([
      ["https://example.com/good.json", JSON.stringify({ title: "Good", type: "object", properties: { a: { type: "string" } } })],
      ["https://example.com/bomb.yaml", hostile(20_000, 40)],
    ]);
    const started = Date.now();
    const refs = await resolveJsonSchemaRefs("https://example.com/root.json", root, { fetchHttp: async (u) => files.get(u) ?? "{}", lookup: PUBLIC });
    expect(Date.now() - started).toBeLessThan(2000);
    expect([...refs.resolved.keys()].some((k) => k.endsWith("bomb.yaml"))).toBe(false);
    expect([...refs.resolved.keys()].some((k) => k.endsWith("good.json"))).toBe(true);
    const reason = refs.unreachable.get("https://example.com/bomb.yaml") ?? "";
    expect(reason).toMatch(/alias/i);

    const asRoot = await resolveJsonSchemaRefs("https://example.com/bomb.yaml", hostile(20_000, 40), { fetchHttp: async () => "{}", lookup: PUBLIC });
    expect(asRoot.resolved.size).toBe(0);
    expect([...asRoot.unreachable.values()].join(" ")).toMatch(/alias/i);
  });

  it("the URL import: a YAML root with the fan-out fails with the clear reason", async () => {
    const files = new Map<string, string>([["https://example.com/root.yaml", hostile(20_000, 40)]]);
    const started = Date.now();
    const r = await importJsonSchemaFromUrl("https://example.com/root.yaml", { fetchHttp: async (u) => files.get(u) ?? "{}", lookup: PUBLIC });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.message).toMatch(/alias/i);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("the URL import: a $ref target with the fan-out becomes a per-reference warning and the other documents import", async () => {
    const files = new Map<string, string>([
      ["https://example.com/root.json", JSON.stringify({ title: "Root", type: "object", properties: { bomb: { $ref: "https://example.com/bomb.yaml" }, a: { type: "string" } } })],
      ["https://example.com/bomb.yaml", hostile(20_000, 40)],
    ]);
    const r = await importJsonSchemaFromUrl("https://example.com/root.json", { fetchHttp: async (u) => files.get(u) ?? "{}", lookup: PUBLIC });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.entities.map((e) => e.name)).toEqual(["Root"]);
    expect(r.data.warnings.join("\n")).toMatch(/alias/i);
  });

  it("the format detector does not expand it, and does not call the document OpenAPI", () => {
    const text = `openapi: 3.0.0\npaths: {}\nx-big: &b ${ones(20_000)}\nx-many: ${aliases(40)}\n`;
    const started = Date.now();
    expect(detectFormat(text)).not.toBe("openapi");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("the AsyncAPI importer (already bounded: 100 aliases and a 2-million-value walk) still rejects the same shape at its own scale", () => {
    // 1 MiB cap: 450,000 values x 41 uses is far past the 2-million-value walk
    const text = `asyncapi: 3.0.0\nx-big: &b ${ones(450_000)}\nx-many: ${aliases(40)}\n`;
    const started = Date.now();
    const r = parseAsyncApiSource(text);
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.message).toMatch(/expands to more than|alias/i);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
