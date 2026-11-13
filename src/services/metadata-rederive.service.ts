/**
 * Derived attribute values: the derivation context every field writer uses, and the bulk re-derivation after a dictionary or classification
 * change.
 *
 * - Every derive path derives with the DOMAIN-resolved definitions (a domain policy may tighten `requiredWhen`): a writer that knows the
 *   field's entity or domain passes it to `loadDerivationContext`; the bulk re-derivation resolves each field's domain itself, once per
 *   domain.
 * - The bulk re-derivation reads and writes inside one interactive transaction per batch, with the field rows locked (`FOR UPDATE`) and
 *   re-derived from what the lock returned, so an edit committed meanwhile is never overwritten. Every query of a batch runs on its
 *   transaction (PGlite has one connection: a query on the global client inside it would wait forever).
 */

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { MARK_DRAFT_CHANGED_SQL } from "@/lib/entity-versioning/draft-state";
import { recomputeFieldAttributes, type DerivableField } from "@/lib/metadata-attributes/derive";
import { applyPolicyDefaults, resolveDefinitionsForDomain } from "@/lib/metadata-attributes/policy";
import type { PolicyTemplate } from "@/types/schemas/domain-policy";
import type { MetadataAttributeDefinition } from "@/types/schemas/metadata-attribute";
import { listMetadataAttributes } from "@/services/metadata-attribute.service";
import { loadCustomClassMap } from "@/services/classification-scale.service";

export interface DerivationContext {
  /** The tenant's field-target definitions, with the domain's `requiredWhen` overrides applied when the context was loaded for one. */
  defs: MetadataAttributeDefinition[];
  custom: ReadonlyMap<string, number>;
}

type DictionaryDb = Pick<Prisma.TransactionClient, "metadataAttributeDefinition" | "classificationLevel">;

/** Where the derived field lives: its entity (its domain is looked up, directly or through its product) or its domain. */
export type DerivationScope = { entityId: string } | { domainId: string };

const asPolicy = (raw: unknown): PolicyTemplate | null => (raw && typeof raw === "object" ? (raw as PolicyTemplate) : null);

async function scopePolicy(scope: DerivationScope, db: Partial<Pick<Prisma.TransactionClient, "entity" | "domain">>): Promise<PolicyTemplate | null> {
  if ("entityId" in scope) return db.entity ? loadEntityDomainPolicy(scope.entityId, db as Pick<Prisma.TransactionClient, "entity">) : null;
  if (!db.domain) return null;
  const row = await db.domain.findUnique({ where: { id: scope.domainId }, select: { policyTemplate: true } });
  return asPolicy(row?.policyTemplate);
}

/**
 * The tenant's field-target definitions and the custom class map, loaded once per action; null when there are no definitions (skip all
 * work). With a `scope`, the definitions are resolved for the domain the field lives in (C6: domain `requiredWhen` overrides apply on every
 * derive path, not only on create).
 */
export async function loadDerivationContext(
  tenantId: string | null | undefined,
  db: DictionaryDb & Partial<Pick<Prisma.TransactionClient, "entity" | "domain">> = prisma,
  scope?: DerivationScope,
): Promise<DerivationContext | null> {
  if (!tenantId) return null;
  const listed = await listMetadataAttributes(tenantId, "field", db);
  if (!listed.success || listed.data.length === 0) return null;
  const custom = await loadCustomClassMap(db);
  const policy = scope ? await scopePolicy(scope, db) : null;
  return { defs: policy ? resolveDefinitionsForDomain(listed.data, policy) : listed.data, custom };
}

/** The same context for the tenant that owns `domainId` (for writers that know a domain, not a tenant), resolved for that domain; null when there is none. */
export async function loadDerivationContextForDomain(
  domainId: string,
  db: DictionaryDb & Pick<Prisma.TransactionClient, "domain">,
): Promise<DerivationContext | null> {
  const domain = await db.domain.findUnique({ where: { id: domainId }, select: { tenantId: true } });
  return loadDerivationContext(domain?.tenantId, db, { domainId });
}

/** The field's decorators with derived members applied; the input decorators untouched when there is no context. */
export function deriveFieldDecorators(ctx: DerivationContext | null, field: DerivableField): Record<string, unknown> | undefined {
  if (!ctx) return (field.decorators && typeof field.decorators === "object" ? field.decorators : undefined) as Record<string, unknown> | undefined;
  return recomputeFieldAttributes(field, ctx.defs, ctx.custom);
}

/** The domain policy template of the domain an entity belongs to (directly, or through its product); null when it has none. */
export async function loadEntityDomainPolicy(
  entityId: string,
  db: Pick<Prisma.TransactionClient, "entity"> = prisma,
): Promise<PolicyTemplate | null> {
  const row = (await db.entity.findUnique({
    where: { id: entityId },
    select: { domain: { select: { policyTemplate: true } }, product: { select: { domain: { select: { policyTemplate: true } } } } },
  })) as { domain?: { policyTemplate: unknown } | null; product?: { domain?: { policyTemplate: unknown } | null } | null } | null;
  return asPolicy(row?.domain?.policyTemplate ?? row?.product?.domain?.policyTemplate ?? null);
}

/** Decorators for a NEW field in a domain: its policy defaults fill absent attributes, then derived members resolve on top (domain `requiredWhen` applies). */
export function deriveNewFieldDecorators(
  ctx: DerivationContext | null,
  policy: PolicyTemplate | null,
  field: DerivableField,
): Record<string, unknown> | undefined {
  if (!ctx) return deriveFieldDecorators(ctx, field);
  const defs = resolveDefinitionsForDomain(ctx.defs, policy);
  const base = (field.decorators && typeof field.decorators === "object" ? field.decorators : {}) as Record<string, unknown>;
  const filled = applyPolicyDefaults(base, defs, policy, { type: field.type, decorators: base });
  return deriveFieldDecorators({ ...ctx, defs }, { ...field, decorators: filled });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Bulk re-derivation
// ---------------------------------------------------------------------------------------------------------------------------------

type PolicyCarrier = { id?: string; policyTemplate: unknown } | null;

type FieldRow = {
  id: string;
  entityId: string;
  name: string;
  type: string;
  classification: string | null;
  decorators: unknown;
  entity: { tenantId: string; domainId: string | null; domain: PolicyCarrier; product: { domainId: string; domain: PolicyCarrier } | null };
};

const FIELD_SELECT = {
  id: true,
  entityId: true,
  name: true,
  type: true,
  classification: true,
  decorators: true,
  entity: {
    select: {
      tenantId: true,
      domainId: true,
      domain: { select: { id: true, policyTemplate: true } },
      product: { select: { domainId: true, domain: { select: { id: true, policyTemplate: true } } } },
    },
  },
} as const;

/** Fields re-derived per transaction: each batch locks its rows for as long as it runs. */
export const REDERIVE_BATCH_SIZE = 200;

type RederiveDb = Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRawUnsafe" | "field" | "metadataAttributeDefinition" | "classificationLevel">;

/**
 * Re-derives the fields `ids` on `tx`: locks the rows, reads them under the lock and writes the ones whose derived members moved, with the
 * draft mark of their entities. Definitions are loaded once per tenant and resolved once per domain. Returns the entities touched.
 */
async function rederiveLocked(tx: RederiveDb, ids: string[]): Promise<Set<string>> {
  const touched = new Set<string>();
  if (ids.length === 0) return touched;
  await tx.$queryRaw`SELECT "id" FROM "fields" WHERE "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR UPDATE`;
  const rows = (await tx.field.findMany({ where: { id: { in: ids } }, select: FIELD_SELECT })) as unknown as FieldRow[];
  if (rows.length === 0) return touched;
  const custom = await loadCustomClassMap(tx);
  const defsByTenant = new Map<string, MetadataAttributeDefinition[]>();
  const defsByDomain = new Map<string, MetadataAttributeDefinition[]>();
  for (const field of rows) {
    const tenantId = field.entity.tenantId;
    if (!defsByTenant.has(tenantId)) {
      const listed = await listMetadataAttributes(tenantId, "field", tx);
      defsByTenant.set(tenantId, listed.success ? listed.data : []);
    }
    const tenantDefs = defsByTenant.get(tenantId)!;
    if (tenantDefs.length === 0) continue;
    // The domain of the entity (directly, or through its product), resolved once per domain within this call.
    const domain = field.entity.domain ?? field.entity.product?.domain ?? null;
    const domainKey = `${tenantId}:${field.entity.domainId ?? field.entity.product?.domainId ?? ""}`;
    if (!defsByDomain.has(domainKey)) defsByDomain.set(domainKey, resolveDefinitionsForDomain(tenantDefs, asPolicy(domain?.policyTemplate)));
    const next = recomputeFieldAttributes(field, defsByDomain.get(domainKey)!, custom);
    if (next === field.decorators) continue;
    await tx.field.update({ where: { id: field.id }, data: { decorators: next as unknown as Prisma.InputJsonValue } });
    touched.add(field.entityId);
  }
  for (const entityId of touched) await tx.$executeRawUnsafe(MARK_DRAFT_CHANGED_SQL, entityId);
  return touched;
}

/**
 * Re-derives the fields `where` selects. With `tx`, everything runs in the caller's transaction (it commits or rolls back with it); without,
 * the ids are read first and each batch of {@link REDERIVE_BATCH_SIZE} runs in a transaction of its own. Returns the entities touched.
 */
async function rederiveWhere(where: Prisma.FieldWhereInput, tx?: RederiveDb): Promise<number> {
  const db = tx ?? prisma;
  const ids = (await db.field.findMany({ where, select: { id: true }, orderBy: { id: "asc" } })).map((f) => f.id);
  if (tx) return (await rederiveLocked(tx, ids)).size;
  const touched = new Set<string>();
  for (let i = 0; i < ids.length; i += REDERIVE_BATCH_SIZE) {
    const batch = ids.slice(i, i + REDERIVE_BATCH_SIZE);
    const entities = await prisma.$transaction((batchTx) => rederiveLocked(batchTx, batch));
    for (const e of entities) touched.add(e);
  }
  return touched.size;
}

/**
 * Re-derive every field classified with `level` (a custom level's class number changed). Pass the transaction that changed the class: the
 * re-derivation then commits or rolls back with it. Returns the number of entities touched.
 */
export async function rederiveForLevel(level: string, tx?: RederiveDb): Promise<number> {
  return rederiveWhere({ classification: { equals: level, mode: "insensitive" } }, tx);
}

/** Re-derive every field of a tenant (an attribute definition changed). Returns the number of entities touched. */
export async function rederiveTenant(tenantId: string, tx?: RederiveDb): Promise<number> {
  return rederiveWhere({ entity: { tenantId } }, tx);
}
