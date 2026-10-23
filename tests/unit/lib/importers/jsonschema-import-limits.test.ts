import { describe, expect, it } from "vitest";
import { parseJsonSchemaDocument, MAX_IMPORT_ENTITIES } from "@/lib/importers/jsonschema.importer";
import { importJsonSchemaFromUrl } from "@/lib/importers/jsonschema-url-import";

function many(n: number, pad = 0): string {
  const defs: Record<string, unknown> = {};
  for (let i = 0; i < n; i++) defs[`E${i}`] = { type: "object", properties: { a: { type: "string", description: "x".repeat(pad) } } };
  return JSON.stringify({ title: "Root", type: "object", properties: { a: { type: "string" } }, $defs: defs });
}

describe("JSON Schema import limits", () => {
  it("accepts exactly the cap and refuses one more (paste path)", () => {
    expect(parseJsonSchemaDocument(many(MAX_IMPORT_ENTITIES - 1)).success).toBe(true);
    const r = parseJsonSchemaDocument(many(MAX_IMPORT_ENTITIES));
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.message).toContain(String(MAX_IMPORT_ENTITIES));
  });

  it("keeps originalContent on every entity when small", () => {
    const src = many(3);
    const r = parseJsonSchemaDocument(src);
    if (!r.success) throw new Error("x");
    expect(r.data.entities.every((e) => e.originalContent === src)).toBe(true);
  });

  it("keeps the source on the first entity only when the total is over budget", () => {
    const src = many(40, 30_000);
    const r = parseJsonSchemaDocument(src);
    if (!r.success) throw new Error("x");
    expect(r.data.entities[0]!.originalContent).toBe(src);
    expect(r.data.entities.slice(1).every((e) => e.originalContent === "")).toBe(true);
    expect(r.data.warnings.some((w) => w.includes("first entity of each document"))).toBe(true);
  });

  it("refuses too many entities from a URL import", async () => {
    const r = await importJsonSchemaFromUrl("https://example.com/s.json", {
      lookup: async () => ["93.184.216.34"],
      fetchHttp: async () => many(MAX_IMPORT_ENTITIES),
      fetchGitFile: async () => {
        throw new Error("no");
      },
    });
    expect(r.success).toBe(false);
  });
});
