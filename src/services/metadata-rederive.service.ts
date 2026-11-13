/**
 * Re-derives stored attribute values after a dictionary or classification change: every affected field has its derived members
 * (`recomputeFieldAttributes`) resolved again, written in ONE transaction together with the draft mark of its entity.
 */

import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { MARK_DRAFT_CHANGED_SQL } from "@/lib/entity-versioning/draft-state";
import { recomputeFieldAttributes, type DerivableField } from "@/lib/metadata-attributes/derive";
import type { MetadataAttributeDefinition } from "@/types/schemas/metadata-attribute";
import { listMetadataAttributes } from "@/services/metadata-attribute.service";
import { loadCustomClassMap } from "@/services/classification-scale.service";

export interface DerivationContext {
  defs: MetadataAttributeDefinition[];
  custom: ReadonlyMap<string, number>;
}

/** The tenant's field-target definitions and the custom class map, loaded once per action; null when there are no definitions (skip all work). */
export async function loadDerivationContext(
  tenantId: string | null | undefined,
  db: Pick<Prisma.TransactionClient, "metadataAttributeDefinition" | "classificationLevel"> = prisma,
): Promise<DerivationContext | null> {
  if (!tenantId) return null;
  const listed = await listMetadataAttributes(tenantId, "field", db);
  if (!listed.success || listed.data.length === 0) return null;
  return { defs: listed.data, custom: await loadCustomClassMap(db) };
}

/** The same context for the tenant that owns `domainId` (for writers that know a domain, not a tenant); null when there is none. */
export async function loadDerivationContextForDomain(
  domainId: string,
  db: Pick<Prisma.TransactionClient, "metadataAttributeDefinition" | "classificationLevel" | "domain">,
): Promise<DerivationContext | null> {
  const domain = await db.domain.findUnique({ where: { id: domainId }, select: { tenantId: true } });
  return loadDerivationContext(domain?.tenantId, db);
}

/** The field's decorators with derived members applied; the input decorators untouched when there is no context. */
export function deriveFieldDecorators(ctx: DerivationContext | null, field: DerivableField): Record<string, unknown> | undefined {
  if (!ctx) return (field.decorators && typeof field.decorators === "object" ? field.decorators : undefined) as Record<string, unknown> | undefined;
  return recomputeFieldAttributes(field, ctx.defs, ctx.custom);
}

type FieldRow = {
  id: string;
  entityId: string;
  name: string;
  type: string;
  classification: string | null;
  decorators: unknown;
  entity: { tenantId: string };
};

const FIELD_SELECT = {
  id: true,
  entityId: true,
  name: true,
  type: true,
  classification: true,
  decorators: true,
  entity: { select: { tenantId: true } },
} as const;

async function rederiveFields(fields: FieldRow[]): Promise<number> {
  if (fields.length === 0) return 0;
  const custom = await loadCustomClassMap();
  const defsByTenant = new Map<string, Awaited<ReturnType<typeof listMetadataAttributes>>>();
  const writes: Prisma.PrismaPromise<unknown>[] = [];
  const entities = new Set<string>();

  for (const field of fields) {
    const tenantId = field.entity.tenantId;
    if (!defsByTenant.has(tenantId)) defsByTenant.set(tenantId, await listMetadataAttributes(tenantId, "field"));
    const listed = defsByTenant.get(tenantId)!;
    if (!listed.success || listed.data.length === 0) continue;

    const next = recomputeFieldAttributes(field, listed.data, custom);
    if (next === field.decorators) continue;
    writes.push(prisma.field.update({ where: { id: field.id }, data: { decorators: next as unknown as Prisma.InputJsonValue } }));
    entities.add(field.entityId);
  }
  if (writes.length === 0) return 0;
  for (const entityId of entities) writes.push(prisma.$executeRawUnsafe(MARK_DRAFT_CHANGED_SQL, entityId));
  await prisma.$transaction(writes);
  return entities.size;
}

/** Re-derive every field classified with `level` (a custom level's class number changed). Returns the number of entities touched. */
export async function rederiveForLevel(level: string): Promise<number> {
  const fields = await prisma.field.findMany({
    where: { classification: { equals: level, mode: "insensitive" } },
    select: FIELD_SELECT,
  });
  return rederiveFields(fields as FieldRow[]);
}

/** Re-derive every field of a tenant (an attribute definition changed). Returns the number of entities touched. */
export async function rederiveTenant(tenantId: string): Promise<number> {
  const fields = await prisma.field.findMany({
    where: { entity: { tenantId } },
    select: FIELD_SELECT,
  });
  return rederiveFields(fields as FieldRow[]);
}
