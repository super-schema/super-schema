/**
 * What the JSON Schema importer keeps, end to end (wave 2a of the fidelity review): a document goes through import -> persisted field
 * rows -> generated TypeSpec -> the app's real emitters, and the emitted JSON Schema still says what the document said.
 */
import { describe, expect, it, vi } from "vitest";
vi.setConfig({ testTimeout: 60_000 });
import type { Prisma } from "@/generated/prisma/client";
import { createImportedEntities, type ImportedEntityInput } from "@/services/imported-entities";
import { compileEntity, type PrismaEntityInput, type PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { parseJsonSchemaDocument } from "@/lib/importers/jsonschema.importer";
import { toAssetImportResult } from "@/lib/importers/multi-asset";
import { buildImportAssetsPayload } from "@/lib/importers/import-payload";
import { generateTypeSpec } from "@/lib/compiler/typespec-generator";
import { emitOfficialTypeSpecTargetFromData } from "@/lib/typespec-official/emitter.service";

vi.mock("server-only", () => ({}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any> & { name: string; type: string; nullable: boolean; decorators: Record<string, any> };

interface Imported {
  rows: Row[];
  metadata: Record<string, unknown> | undefined;
  warnings: string[];
  entity: PrismaEntityInput;
  fields: PrismaFieldInput[];
}

/** import -> payload -> the rows `createImportedEntities` writes (the first entity), as the app persists them. */
export async function importAndPersist(schema: unknown, name = "Evt"): Promise<Imported> {
  const parsed = parseJsonSchemaDocument(JSON.stringify(schema));
  if (!parsed.success) throw new Error(parsed.error.message);
  const payload = buildImportAssetsPayload(toAssetImportResult(parsed.data), {
    domainId: "d", selectedModels: [], selectedEntities: [0], selectedEnums: [], selectedScalars: [],
    selectedUnions: [], selectedServices: [], selectedDecorators: [],
  });
  payload.entities[0].name = name;
  const create = vi.fn(async ({ data }: { data: { name: string } }) => ({ id: `id-${data.name}` }));
  const tx = { entity: { create, findFirst: vi.fn().mockResolvedValue(null) } } as unknown as Prisma.TransactionClient;
  await createImportedEntities(tx, {
    entities: [payload.entities[0] as unknown as ImportedEntityInput],
    productScope: { tenantId: "t", domainId: "d", productId: "p" },
    productId: "p", ownerId: "u", sourceFormat: "jsonschema", isNameFree: async () => true, skip: () => {}, refs: new Map(),
  });
  const data = create.mock.calls[0][0].data as unknown as { metadata?: Record<string, unknown>; fields: { create: Row[] } };
  const rows = data.fields.create;
  const entity: PrismaEntityInput = {
    id: "e1", name, description: "", status: "DRAFT", version: 1, domainId: "d", metadata: data.metadata,
    domain: { id: "d", name: "Sales", slug: "sales" },
  };
  const fields = rows.map((r, i) => ({
    id: `f${i}`, name: r.name, type: r.type, precision: null, scale: null, nullable: r.nullable, isKey: r.name === "id",
    fieldNumber: i + 1, description: (r.description as string) ?? "", classification: (r.classification as string) ?? null, aliases: [],
    decorators: r.decorators, sortOrder: i,
  })) as PrismaFieldInput[];
  return { rows, metadata: data.metadata, warnings: parsed.data.warnings, entity, fields };
}

export const emitJsonSchema = async (i: Imported) => {
  const result = await emitOfficialTypeSpecTargetFromData(i.entity, i.fields, "json-schema");
  expect(result.errors).toEqual([]);
  return JSON.parse(result.output) as { properties: Record<string, Record<string, unknown>>; required?: string[]; [key: string]: unknown };
};

describe("a property typed with several scalar types (F2a)", () => {
  const SCHEMA = {
    title: "Evt", type: "object", required: ["id", "v"],
    properties: {
      id: { type: "string" },
      v: { type: ["string", "integer"] },
      w: { oneOf: [{ type: "string", format: "date-time" }, { type: "number" }] },
      tags: { type: "array", items: { type: ["string", "integer"] } },
    },
  };

  it("keeps every type through the TypeSpec text", async () => {
    const i = await importAndPersist(SCHEMA);
    const text = generateTypeSpec(compileEntity(i.entity, i.fields), { governance: false });
    expect(text).toMatch(/v: string \| integer;/);
    expect(text).toMatch(/w\?: utcDateTime \| float64;/);
    expect(text).toMatch(/tags\?: \(string \| integer\)\[\];/);
  });

  it("the emitted JSON Schema is anyOf over all the types, not the first one", async () => {
    const schema = await emitJsonSchema(await importAndPersist(SCHEMA));
    expect(schema.properties.v).toEqual({ anyOf: [{ type: "string" }, { type: "integer" }] });
    expect(schema.properties.w.anyOf).toEqual([{ type: "string", format: "date-time" }, { type: "number" }]);
    expect(schema.properties.tags).toMatchObject({ type: "array", items: { anyOf: [{ type: "string" }, { type: "integer" }] } });
    expect(schema.required).toEqual(["id", "v"]);
  });

  it("the emitted JSON Schema re-imports as the same union", async () => {
    const i = await importAndPersist(SCHEMA);
    const result = await emitOfficialTypeSpecTargetFromData(i.entity, i.fields, "json-schema");
    const again = parseJsonSchemaDocument(result.output);
    if (!again.success) throw new Error(again.error.message);
    expect(again.data.entities[0].fields.find((f) => f.name === "v")).toMatchObject({ type: "union", unionMembers: ["string", "integer"] });
  });
});
