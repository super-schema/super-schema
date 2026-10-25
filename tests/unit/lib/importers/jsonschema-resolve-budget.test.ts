import { afterEach, describe, expect, it } from "vitest";
import { parseJsonSchemaDocument, setResolveVisitLimitForTests } from "@/lib/importers/jsonschema.importer";
import { importJsonSchemaFromUrl } from "@/lib/importers/jsonschema-url-import";

/**
 * The type resolver used to be exponential in the BREADTH of an `allOf` fan-out: `$defs` A0..An, each listing the next one several
 * times, resolved every member separately (members^depth calls, synchronous, so no timeout can cut it). A definition is now resolved once
 * per (definition, depth, nesting), and a visit budget refuses what is still too large.
 */
function fanOutChain(members: number, depth: number): string {
  const defs: Record<string, unknown> = {};
  for (let i = 0; i < depth; i++) {
    defs[`A${i}`] = { minLength: 1, allOf: Array.from({ length: members }, () => ({ $ref: `#/$defs/A${i + 1}` })) };
  }
  defs[`A${depth}`] = { type: "string" };
  return JSON.stringify({ title: "Root", type: "object", properties: { f: { $ref: "#/$defs/A0" } }, $defs: defs });
}

afterEach(() => setResolveVisitLimitForTests(undefined));

describe("allOf fan-out is resolved in linear time", () => {
  it("depth 14 x 3 members (7 s before the fix) returns at once with the real type", () => {
    const started = Date.now();
    const r = parseJsonSchemaDocument(fanOutChain(3, 14));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.entities[0]!.fields[0]!.type).toBe("string");
  });

  it("depth 30 x 4 members returns within 2 s (a success or a clear refusal, never a stall)", () => {
    const started = Date.now();
    const r = parseJsonSchemaDocument(fanOutChain(4, 30));
    expect(Date.now() - started).toBeLessThan(2000);
    if (!r.success) expect(r.error.message).toMatch(/too large to resolve/i);
  });

  it("a diamond (two members reaching one definition) resolves to the shared definition's type and keeps every constraint", () => {
    const r = parseJsonSchemaDocument(
      JSON.stringify({
        title: "Root",
        type: "object",
        properties: { f: { $ref: "#/$defs/Top" } },
        $defs: {
          Short: { type: "string", maxLength: 10 },
          Mid1: { minLength: 1, allOf: [{ $ref: "#/$defs/Short" }] },
          Mid2: { pattern: "^a", allOf: [{ $ref: "#/$defs/Short" }] },
          Top: { allOf: [{ $ref: "#/$defs/Mid1" }, { $ref: "#/$defs/Mid2" }] },
        },
      })
    );
    expect(r.success).toBe(true);
    if (!r.success) return;
    const f = r.data.entities[0]!.fields[0]!;
    expect(f.type).toBe("string");
    expect(f.constraints?.map((c) => c.type).sort()).toEqual(["maxLength", "minLength", "pattern"]);
  });

  it("two fields reaching one inline definition get their own copy of its enum values", () => {
    const r = parseJsonSchemaDocument(
      JSON.stringify({
        title: "Root",
        type: "object",
        properties: { a: { $ref: "#/$defs/Alias" }, b: { $ref: "#/$defs/Alias" } },
        $defs: { Status: { type: "string", enum: ["on", "off"] }, Alias: { $ref: "#/$defs/Status" } },
      })
    );
    expect(r.success).toBe(true);
    if (!r.success) return;
    const [a, b] = r.data.entities[0]!.fields;
    expect(a!.enumValues).toEqual(["on", "off"]);
    expect(a!.enumValues).not.toBe(b!.enumValues);
  });
});

describe("the visit budget", () => {
  it("refuses a schema that needs more work than the limit, with a clear PARSE_ERROR", () => {
    setResolveVisitLimitForTests(500);
    const props: Record<string, unknown> = {};
    for (let i = 0; i < 2000; i++) props[`p${i}`] = { type: "string" };
    const r = parseJsonSchemaDocument(JSON.stringify({ title: "Wide", type: "object", properties: props }));
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.code).toBe("PARSE_ERROR");
      expect(r.error.message).toMatch(/too large to resolve/i);
    }
  });

  it("still imports a legitimate large schema: 2000 properties, shared definitions, 300 entities that reference each other", () => {
    const props: Record<string, unknown> = {};
    for (let i = 0; i < 2000; i++) {
      props[`p${i}`] =
        i % 5 === 0 ? { $ref: "#/$defs/ShortText" } : i % 5 === 1 ? { type: "array", items: { $ref: "#/$defs/E1" } } : i % 5 === 2 ? { $ref: "#/$defs/E2" } : { type: "string", maxLength: 40 };
    }
    const defs: Record<string, unknown> = { ShortText: { type: "string", maxLength: 12, description: "short" } };
    for (let i = 0; i < 300; i++) {
      defs[`E${i}`] = {
        type: "object",
        properties: { id: { type: "string" }, short: { $ref: "#/$defs/ShortText" }, next: { $ref: `#/$defs/E${(i + 1) % 300}` } },
      };
    }
    const started = Date.now();
    const r = parseJsonSchemaDocument(JSON.stringify({ title: "Big", type: "object", properties: props, $defs: defs }));
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.entities[0]!.fields).toHaveLength(2000);
    expect(r.data.entities).toHaveLength(301);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("is shared by the documents of one URL import: a document that finds it spent is reported, the rest still import", async () => {
    setResolveVisitLimitForTests(250);
    const wide = (title: string) => {
      const props: Record<string, unknown> = {};
      for (let i = 0; i < 120; i++) props[`p${i}`] = { type: "string" };
      return JSON.stringify({ title, type: "object", properties: props });
    };
    const files = new Map<string, string>([
      ["https://example.com/root.json", JSON.stringify({ title: "Root", type: "object", properties: { a: { $ref: "https://example.com/a.json" }, b: { $ref: "https://example.com/b.json" }, c: { $ref: "https://example.com/c.json" } } })],
      ["https://example.com/a.json", wide("A")],
      ["https://example.com/b.json", wide("B")],
      ["https://example.com/c.json", wide("C")],
    ]);
    const r = await importJsonSchemaFromUrl("https://example.com/root.json", {
      fetchHttp: async (u: string) => files.get(u) ?? "{}",
      lookup: async () => ["93.184.216.34"],
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.warnings.join("\n")).toMatch(/too large to resolve/i);
    expect(r.data.entities.length).toBeLessThan(4);
  });
});
