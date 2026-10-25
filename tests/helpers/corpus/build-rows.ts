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
import type { CorpusCase, ModelInput, Placement } from "../../fixtures/corpus/types";

/** The domain and product every entity of a document (and a model case that names no place) lives in. */
export const CORPUS_PLACE: Required<Placement> = { domain: "Corpus", product: "Corpus" };

/** One entity of the case's tenant: what the closure resolver would read from the database for it. */
export interface BuiltMember {
  entity: PrismaEntityInput;
  fields: PrismaFieldInput[];
  place: Placement;
  /** Published versions, oldest first: what a pin names (and what a published-mode closure would read). */
  published: Array<{ version: string; fields: PrismaFieldInput[] }>;
}

export interface BuiltCase {
  entity: PrismaEntityInput;
  fields: PrismaFieldInput[];
  importWarnings: string[];
  /** The multi-entity import (JSON Schema cases) for the round-trip projection. */
  imported?: MultiEntityImportResult;
  /** How many entities the document produced. */
  entityCount: number;
  /**
   * Every entity of the case's tenant, the case's own entity FIRST (`members[0]` is `entity` / `fields`): the document's other entities
   * (its `$defs` / models), or the case's `siblings`. The closure of the case's entity walks these, like the app walks the tenant.
   */
  members: BuiltMember[];
}
export type BuildOutcome = { ok: true; value: BuiltCase } | { ok: false; reason: string };

type Row = Record<string, unknown> & { name: string; type: string };

export function toPrismaFields(rows: Row[], idPrefix = ""): PrismaFieldInput[] {
  return rows.map((r, i) => ({
    id: `${idPrefix}f${i}`, name: r.name, type: r.type, precision: (r.precision as number | null) ?? null, scale: (r.scale as number | null) ?? null,
    nullable: (r.nullable as boolean) ?? false, isKey: (r.isKey as boolean) ?? false, fieldNumber: (r.fieldNumber as number | null) ?? null,
    description: (r.description as string) ?? "", classification: (r.classification as string | null) ?? null,
    aliases: (r.aliases as string[]) ?? [], decorators: r.decorators ?? {}, sortOrder: i,
  }));
}

const entityInput = (name: string, id: string, extra: Partial<PrismaEntityInput> = {}): PrismaEntityInput => ({
  id, name, description: "", status: "DRAFT", version: 1, domainId: "d", metadata: {}, domain: { id: "d", name: CORPUS_PLACE.domain, slug: "corpus" }, ...extra,
});

async function persist(result: TypeSpecImportResult, rootName: string): Promise<{ entity: PrismaEntityInput; fields: PrismaFieldInput[]; members: BuiltMember[] } | string> {
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
  // The document's other entities are the rest of the tenant: the root is `e1`, the others `m<n>`. The importer's reference fields
  // name them, so the closure resolver finds them by name, exactly as it finds a legacy name-only reference in the app.
  const members: BuiltMember[] = [data, ...recorded.filter((d) => d !== data)].map((d, i) => {
    const id = i === 0 ? "e1" : `m${i}`;
    return {
      entity: entityInput(d.name, id, { description: d.description ?? "", metadata: d.metadata }),
      fields: toPrismaFields(d.fields.create, i === 0 ? "" : `${id}-`),
      place: { ...CORPUS_PLACE },
      published: [],
    };
  });
  return { entity: members[0].entity, fields: members[0].fields, members };
}

/** A hand-built entity (the case's own, or a sibling) as a member of the tenant. */
function memberOf(input: ModelInput, id: string, fieldIdPrefix: string): BuiltMember {
  const entity = entityInput(input.entity.name, id, input.entity as Partial<PrismaEntityInput>);
  return {
    entity: { ...entity, id },
    fields: toPrismaFields(input.fields as Row[], fieldIdPrefix),
    place: input.place ?? { ...CORPUS_PLACE },
    published: (input.published ?? []).map((p) => ({ version: p.version, fields: toPrismaFields(p.fields as Row[], `${id}-v${p.version}-`) })),
  };
}

export async function buildCase(c: CorpusCase): Promise<BuildOutcome> {
  try {
    if (c.kind === "model") {
      const m = c.source as ModelInput;
      const entity: PrismaEntityInput = { id: "e1", description: "", status: "DRAFT", version: 1, domainId: "d", metadata: {}, domain: { id: "d", name: "Corpus", slug: "corpus" }, ...m.entity };
      const root = memberOf({ ...m, entity }, entity.id, "");
      // A sibling takes its own id when the fixture gives one (a reference field names it), else `m<n>`.
      const siblings = (m.siblings ?? []).map((s, i) => memberOf(s, s.entity.id ?? `m${i + 1}`, `${s.entity.id ?? `m${i + 1}`}-`));
      const ids = new Set<string>();
      for (const member of [root, ...siblings]) {
        if (ids.has(member.entity.id)) return { ok: false, reason: `two entities of the case have the id ${member.entity.id}` };
        ids.add(member.entity.id);
      }
      return { ok: true, value: { entity, fields: root.fields, importWarnings: [], entityCount: 1 + siblings.length, members: [root, ...siblings] } };
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
