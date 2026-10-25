/**
 * Test helper: a JSON Schema document as the app persists it. import -> payload -> the field rows `createImportedEntities` writes for the
 * first entity, plus the entity and field inputs the compiler / emitters take. Importing it needs `vi.mock("server-only", () => ({}))`
 * in the test file (the services it reaches are server modules).
 */
import { vi } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { createImportedEntities, type ImportedEntityInput } from "@/services/imported-entities";
import type { PrismaEntityInput, PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { parseJsonSchemaDocument } from "@/lib/importers/jsonschema.importer";
import { toAssetImportResult } from "@/lib/importers/multi-asset";
import { buildImportAssetsPayload } from "@/lib/importers/import-payload";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Row = Record<string, any> & { name: string; type: string; nullable: boolean; decorators: Record<string, any> };

export interface Imported {
  rows: Row[];
  metadata: Record<string, unknown> | undefined;
  warnings: string[];
  entity: PrismaEntityInput;
  fields: PrismaFieldInput[];
}

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
