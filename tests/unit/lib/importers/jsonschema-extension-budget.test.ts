import { describe, expect, it } from "vitest";
import { MAX_PRESERVED_VALUE_BYTES, parseJsonSchemaDocument } from "@/lib/importers/jsonschema.importer";
import { importJsonSchemaFromUrl } from "@/lib/importers/jsonschema-url-import";

/**
 * A `$ref` to an inline definition copies the definition's extensions (and `default` / `examples` / description) onto every field that
 * points at it, by reference, and the response serialises each copy: 208 KB of schema came back as 20.7 MB (linear in the references).
 * Past a per-import byte budget a repeat of a large value is not copied again, and one warning per key says so.
 */
const BIG = 200 * 1024;

function amplified(refs: number, def: Record<string, unknown>): string {
  const props: Record<string, unknown> = {};
  for (let i = 0; i < refs; i++) props[`p${i}`] = { $ref: "#/$defs/Big" };
  return JSON.stringify({ title: "R", type: "object", properties: props, $defs: { Big: { type: "string", ...def } } });
}

function parse(text: string) {
  const r = parseJsonSchemaDocument(text);
  if (!r.success) throw new Error(r.error.message);
  return r.data;
}

describe("extension budget: one definition's large value is not copied onto every field that references it", () => {
  it("an extension of 200 KB on 100 references (20.7 MB of response before) stays near the budget, with a warning", () => {
    const data = parse(amplified(100, { "x-big": "x".repeat(BIG) }));
    const out = JSON.stringify(data);
    expect(out.length).toBeLessThan(MAX_PRESERVED_VALUE_BYTES + 1_500_000);
    const fields = data.entities[0]!.fields;
    expect(fields).toHaveLength(100);
    // the first field keeps the value, the last does not
    expect((fields[0]!.extensions?.["x-big"] as string).length).toBe(BIG);
    expect(fields[99]!.extensions?.["x-big"]).toBeUndefined();
    const warning = data.warnings.find((w) => w.includes("x-big"));
    expect(warning).toMatch(/not repeated/i);
    expect(warning).toMatch(/\b\d+ fields\b/);
  });

  it("the same for default and examples (kept as extensions) and for a long description", () => {
    for (const def of [{ default: "d".repeat(BIG) }, { examples: ["e".repeat(BIG)] }, { description: "t".repeat(BIG) }]) {
      const data = parse(amplified(100, def));
      expect(JSON.stringify(data).length).toBeLessThan(MAX_PRESERVED_VALUE_BYTES + 1_500_000);
      expect(data.warnings.some((w) => /not repeated/i.test(w))).toBe(true);
    }
  });

  it("repeats of a SMALL value are always kept, and nothing changes while the schema is within the budget", () => {
    const data = parse(amplified(100, { "x-visibility": { extent: "EXTERNAL" }, "x-big": "x".repeat(5000) }));
    const fields = data.entities[0]!.fields;
    expect(fields.every((f) => (f.extensions?.["x-visibility"] as { extent: string }).extent === "EXTERNAL")).toBe(true);
    // 100 x 5 KB is well under the 2 MB budget: every copy is kept and nothing is reported
    expect(fields.every((f) => (f.extensions?.["x-big"] as string).length === 5000)).toBe(true);
    expect(data.warnings.some((w) => /not repeated/i.test(w))).toBe(false);
  });

  it("distinct large values are all kept: only a REPEAT of an earlier value is dropped", () => {
    const defs: Record<string, unknown> = {};
    const props: Record<string, unknown> = {};
    for (let i = 0; i < 15; i++) {
      defs[`D${i}`] = { type: "string", "x-big": `${i}`.repeat(BIG) };
      props[`p${i}`] = { $ref: `#/$defs/D${i}` };
    }
    const data = parse(JSON.stringify({ title: "R", type: "object", properties: props, $defs: defs }));
    const fields = data.entities[0]!.fields;
    expect(fields.every((f, i) => (f.extensions?.["x-big"] as string)?.startsWith(`${i}`))).toBe(true);
  });

  it("a response many times larger than its source is refused (the backstop for an enum, a pattern or a constant repeated on every reference)", () => {
    const enumValues = Array.from({ length: 40_000 }, (_, i) => `v${i}`);
    // An enum is bounded to 5000 symbols (MAX_ENUM_VALUES), so it takes more references to pass the response limit than it once did.
    for (const [refs, def] of [[400, { enum: enumValues }], [100, { pattern: "a".repeat(BIG) }], [100, { const: "c".repeat(BIG) }]] as const) {
      const started = Date.now();
      const r = parseJsonSchemaDocument(amplified(refs, def));
      expect(r.success).toBe(false);
      if (!r.success) {
        expect(r.error.code).toBe("PARSE_ERROR");
        expect(r.error.message).toMatch(/expands to more than \d+ MB/);
      }
      expect(Date.now() - started).toBeLessThan(2000);
    }
  });

  it("a legitimate large enum used by many fields still imports (the limit is relative to the source)", () => {
    const countries = Array.from({ length: 250 }, (_, i) => `C${i}`);
    const props: Record<string, unknown> = {};
    for (let i = 0; i < 500; i++) props[`country${i}`] = { $ref: "#/$defs/Country" };
    const r = parseJsonSchemaDocument(JSON.stringify({ title: "R", type: "object", properties: props, $defs: { Country: { type: "string", enum: countries } } }));
    expect(r.success).toBe(true);
  });

  it("the budget also holds across the documents of one URL import", async () => {
    const files = new Map<string, string>();
    const props: Record<string, unknown> = {};
    for (let d = 0; d < 15; d++) {
      const uri = `https://example.com/d${d}.json`;
      props[`d${d}`] = { $ref: uri };
      const inner: Record<string, unknown> = {};
      for (let i = 0; i < 4; i++) inner[`p${i}`] = { $ref: "#/$defs/Big" };
      files.set(uri, JSON.stringify({ title: `D${d}`, type: "object", properties: inner, $defs: { Big: { type: "string", "x-big": "x".repeat(150 * 1024) } } }));
    }
    files.set("https://example.com/root.json", JSON.stringify({ title: "Root", type: "object", properties: props }));
    const r = await importJsonSchemaFromUrl("https://example.com/root.json", {
      fetchHttp: async (u: string) => files.get(u) ?? "{}",
      lookup: async () => ["93.184.216.34"],
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    // 60 copies of 150 KB would be 9 MB; the originalContent budget keeps the source copies down already
    const kept = r.data.entities.flatMap((e) => e.fields).filter((f) => f.extensions?.["x-big"] !== undefined).length;
    expect(kept).toBeLessThan(25);
    expect(r.data.warnings.some((w) => /x-big.*not repeated/i.test(w))).toBe(true);
  });
});
