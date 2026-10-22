/**
 * Builds the entity rows a case would have in the database, through the REAL production chain:
 *   JSON Schema: parseJsonSchemaDocument -> toAssetImportResult -> buildImportAssetsPayload -> createImportedEntities (fake tx)
 *   TypeSpec:    compileTypeSpecDocument -> mapDocumentToImportResult -> buildImportAssetsPayload -> createImportedEntities (fake tx)
 *   model:       the entity / fields given directly
 * and returns the inputs `emitOfficialTypeSpecTargetFromData` takes.
 */
import { vi } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { createImportedEntities, type ImportedEntityInput } from "@/services/imported-entities";
import type { PrismaEntityInput, PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { parseJsonSchemaDocument } from "@/lib/importers/jsonschema.importer";
import { toAssetImportResult, pickRootEntity } from "@/lib/importers/multi-asset";
import { buildImportAssetsPayload } from "@/lib/importers/import-payload";
import { mapDocumentToImportResult, type TypeSpecImportResult } from "@/lib/importers/typespec.importer";
import type { MultiEntityImportResult } from "@/lib/importers/types";
import type { CorpusCase, ModelInput } from "../../fixtures/corpus/types";

export interface BuiltCase {
  entity: PrismaEntityInput;
  fields: PrismaFieldInput[];
  importWarnings: string[];
  /** The multi-entity import (JSON Schema cases) for the round-trip projection. */
  imported?: MultiEntityImportResult;
  /** How many entities the document produced (only the root one is emitted). */
  entityCount: number;
}
export type BuildOutcome = { ok: true; value: BuiltCase } | { ok: false; reason: string };

type Row = Record<string, unknown> & { name: string; type: string };

export function toPrismaFields(rows: Row[]): PrismaFieldInput[] {
  return rows.map((r, i) => ({
    id: `f${i}`, name: r.name, type: r.type, precision: (r.precision as number | null) ?? null, scale: (r.scale as number | null) ?? null,
    nullable: (r.nullable as boolean) ?? false, isKey: (r.isKey as boolean) ?? false, fieldNumber: (r.fieldNumber as number | null) ?? null,
    description: (r.description as string) ?? "", classification: (r.classification as string | null) ?? null,
    aliases: (r.aliases as string[]) ?? [], decorators: r.decorators ?? {}, sortOrder: i,
  }));
}

async function persist(result: TypeSpecImportResult, rootName: string): Promise<{ entity: PrismaEntityInput; fields: PrismaFieldInput[] } | string> {
  const payload = buildImportAssetsPayload(result, {
    domainId: "d", selectedModels: [], selectedEntities: result.models.map((_, i) => i), selectedEnums: [], selectedScalars: [],
    selectedUnions: [], selectedServices: [], selectedDecorators: [],
  });
  const recorded: Array<{ name: string; metadata?: Record<string, unknown>; description?: string; fields: { create: Row[] } }> = [];
  const create = vi.fn(async ({ data }: { data: (typeof recorded)[number] }) => { recorded.push(data); return { id: `id-${data.name}` }; });
  const tx = { entity: { create, findFirst: vi.fn().mockResolvedValue(null) } } as unknown as Prisma.TransactionClient;
  const skipped: string[] = [];
  await createImportedEntities(tx, {
    entities: payload.entities as unknown as ImportedEntityInput[],
    productScope: { tenantId: "t", domainId: "d", productId: "p" },
    productId: "p", ownerId: "u", sourceFormat: result.sourceFormat,
    isNameFree: async () => true, skip: (m) => skipped.push(m), refs: new Map(),
  });
  const data = recorded.find((d) => d.name === rootName.trim()) ?? recorded[0];
  if (!data) return `no entity was created (${skipped.join("; ") || "none selected"})`;
  return {
    entity: { id: "e1", name: data.name, description: data.description ?? "", status: "DRAFT", version: 1, domainId: "d", metadata: data.metadata, domain: { id: "d", name: "Corpus", slug: "corpus" } },
    fields: toPrismaFields(data.fields.create),
  };
}

export async function buildCase(c: CorpusCase): Promise<BuildOutcome> {
  try {
    if (c.kind === "model") {
      const m = c.source as ModelInput;
      const entity: PrismaEntityInput = { id: "e1", description: "", status: "DRAFT", version: 1, domainId: "d", metadata: {}, domain: { id: "d", name: "Corpus", slug: "corpus" }, ...m.entity };
      return { ok: true, value: { entity, fields: toPrismaFields(m.fields as Row[]), importWarnings: [], entityCount: 1 } };
    }
    if (c.kind === "jsonschema") {
      const parsed = parseJsonSchemaDocument(c.source as string);
      if (!parsed.success) return { ok: false, reason: `import: ${parsed.error.message}` };
      const doc = parsed.data;
      if (doc.entities.length === 0) return { ok: false, reason: "import produced no entity" };
      const result = toAssetImportResult(doc);
      const root = pickRootEntity(doc);
      const built = await persist(result, root.name);
      if (typeof built === "string") return { ok: false, reason: built };
      return { ok: true, value: { ...built, importWarnings: result.warnings, imported: doc, entityCount: doc.entities.length } };
    }
    const { compileTypeSpecDocument } = await import("@/lib/compiler/typespec-compiler");
    const doc = await compileTypeSpecDocument(c.source as string);
    const result = mapDocumentToImportResult(doc, c.source as string);
    if (result.models.length === 0) return { ok: false, reason: "typespec import produced no model" };
    const rootModel = result.models.find((m) => m.recommendedAsEntity) ?? result.models[0];
    const built = await persist(result, rootModel.name);
    if (typeof built === "string") return { ok: false, reason: built };
    return { ok: true, value: { ...built, importWarnings: result.warnings, entityCount: result.models.length } };
  } catch (error) {
    return { ok: false, reason: `build threw: ${error instanceof Error ? error.message : String(error)}` };
  }
}
