import { describe, it, expect, vi } from "vitest";
import type { PrismaEntityInput, PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { parseJsonSchemaDocument } from "@/lib/importers/jsonschema.importer";
import { parsedFieldToCreateFieldInput } from "@/lib/importers/import-payload";

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.setConfig({ testTimeout: 60_000 });
import { emitOfficialTypeSpecTargetFromData } from "@/lib/typespec-official/emitter.service";

// Found by the corpus: a JSON Schema `deprecated: true` (no message) is stored as decorators.evolution.deprecated, which the generator
// never read (it wrote #deprecated only for a documentation message), so the flag was lost on every target.
const entity: PrismaEntityInput = { id: "e", name: "Evt", description: "", status: "DRAFT", version: 1, domainId: "d", metadata: {}, domain: { id: "d", name: "Sales", slug: "sales" } };

function fields(): PrismaFieldInput[] {
  const parsed = parseJsonSchemaDocument(JSON.stringify({ title: "Evt", type: "object", required: ["id"], properties: { id: { type: "string" }, old: { type: "string", deprecated: true } } }));
  if (!parsed.success) throw new Error(parsed.error.message);
  return parsed.data.entities[0].fields.map((f, i) => {
    const input = parsedFieldToCreateFieldInput(f);
    return { id: `f${i}`, name: input.name, type: input.type, precision: null, scale: null, nullable: input.nullable, isKey: input.name === "id", fieldNumber: null, description: "", classification: null, aliases: input.aliases ?? [], decorators: input.decorators ?? {}, sortOrder: i } as PrismaFieldInput;
  });
}

describe("a field deprecated without a message", () => {
  it("is deprecated in the generated JSON Schema and OpenAPI", async () => {
    const js = await emitOfficialTypeSpecTargetFromData(entity, fields(), "json-schema");
    expect(js.errors).toEqual([]);
    // One `Evt.json` per model (no `bundleId` since closure emission): the schema is the document itself, not a `$defs` entry.
    expect(JSON.parse(js.output).properties.old.deprecated).toBe(true);
    const oa = await emitOfficialTypeSpecTargetFromData(entity, fields(), "openapi3");
    expect(oa.errors).toEqual([]);
    expect(oa.output).toMatch(/old:[\s\S]*?deprecated: true/);
  });

  it.each(["avro", "protobuf", "java-pojo", "postgresql", "spanner", "bigquery"])("still compiles for %s", async (target) => {
    const result = await emitOfficialTypeSpecTargetFromData(entity, fields(), target);
    expect(result.errors).toEqual([]);
    expect(result.output).toContain("old");
  });
});
