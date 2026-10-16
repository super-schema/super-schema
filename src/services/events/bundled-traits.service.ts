// src/services/events/bundled-traits.service.ts
// Installs the built-in Message properties (`BUNDLED_TRAITS`) as tenant-level library traits. The only writer of a trait that carries
// the `x-bundled` marker: `createTrait` / `updateTrait` / `deleteTrait` refuse that marker (read-only means read-only).
//
// It goes through `createInScope` exactly like `createTrait` does — scope resolution, the placement matrix, then the line-unique name
// check and the write under the tenant's advisory lock — so a built-in trait can never take a name something else in the tenant's line
// holds. It is NOT audited: the audit log needs a user, and installing a built-in is a system provisioning step with no actor
// (tenant creation, `npm run dev`'s database step, the demo seed).
import type { PrismaClient, Prisma } from "@/generated/prisma/client";
import { BUNDLED_TRAITS, bundledMarker, type BundledTrait } from "@/lib/events/bundled-traits";
import { createInScope } from "@/services/scoped-create.service";
import { guardRead } from "@/services/events/service-guards";
import { ok, type Result } from "@/types/result";

export interface EnsureBundledTraitsResult {
  /** Names of the built-in traits this call created (empty on every run after the first). */
  created: string[];
  /**
   * Names of built-in traits that could NOT be created because the name is already taken in the tenant's line by something that is
   * not that built-in (a trait a user made called "CloudEvents", an entity of that name, ...). That asset is left exactly as it is.
   */
  skipped: string[];
}

export interface EnsureBundledTraitsAllResult {
  /** Tenants visited. */
  tenants: number;
  created: Array<{ tenantId: string; names: string[] }>;
  skipped: Array<{ tenantId: string; names: string[] }>;
  /** Tenants whose ensure failed (the others were still done): the tenant id and the failure's code. */
  failed: Array<{ tenantId: string; code: string }>;
}

type NameConflictDetails = { conflict?: { kind?: unknown; id?: unknown } };

/** True when the asset that holds `def`'s name is the built-in itself (another ensure won the race between our read and our write). */
async function holderIsBuiltIn(prisma: PrismaClient, tenantId: string, def: BundledTrait, details: unknown): Promise<boolean> {
  const conflict = (details as NameConflictDetails | undefined)?.conflict;
  if (conflict?.kind !== "trait" || typeof conflict.id !== "string") return false;
  const row = await prisma.trait.findFirst({ where: { id: conflict.id, tenantId }, select: { spec: true } });
  return row !== null && bundledMarker(row.spec) === def.id;
}

/**
 * Makes sure the tenant has every built-in trait, at tenant level. Idempotent: a built-in is recognised by its `x-bundled` marker,
 * so a second run creates nothing; an existing row is never renamed, edited or replaced (a definition changes by getting a new id).
 * A name that something else already holds is reported under `skipped` and left alone. Never throws: an unknown tenant is
 * `NOT_FOUND`, a database failure `DB_ERROR`.
 */
export async function ensureBundledTraits(prisma: PrismaClient, tenantId: string): Promise<Result<EnsureBundledTraitsResult>> {
  return guardRead(async () => {
    const levelTraits = await prisma.trait.findMany({ where: { tenantId, domainId: null, productId: null }, select: { spec: true } });
    const present = new Set(levelTraits.flatMap((t) => bundledMarker(t.spec) ?? []));
    const created: string[] = [];
    const skipped: string[] = [];
    for (const def of BUNDLED_TRAITS) {
      if (present.has(def.id)) continue;
      const result = await createInScope(prisma, {
        kind: "trait",
        target: { level: "TENANT", tenantId },
        name: def.name,
        write: (tx: Prisma.TransactionClient, scope) =>
          tx.trait.create({
            data: { kind: def.kind, name: def.name, spec: structuredClone(def.spec) as Prisma.InputJsonValue, headersEntityId: null, headersEntityVersionId: null, ...scope },
            select: { id: true },
          }),
      });
      if (result.success) created.push(def.name);
      else if (result.error.code !== "NAME_CONFLICT") return result;
      else if (!(await holderIsBuiltIn(prisma, tenantId, def, result.error.details))) skipped.push(def.name);
    }
    return ok({ created, skipped });
  });
}

/**
 * `ensureBundledTraits` for every tenant (or the given ones). One tenant failing does not stop the others; failures are listed.
 * One query per tenant when nothing is missing, so it is cheap enough to run at every start.
 */
export async function ensureBundledTraitsForAllTenants(prisma: PrismaClient, tenantIds?: string[]): Promise<Result<EnsureBundledTraitsAllResult>> {
  return guardRead(async () => {
    const ids = tenantIds ?? (await prisma.tenant.findMany({ select: { id: true }, orderBy: { id: "asc" } })).map((t) => t.id);
    const out: EnsureBundledTraitsAllResult = { tenants: ids.length, created: [], skipped: [], failed: [] };
    for (const tenantId of ids) {
      const r = await ensureBundledTraits(prisma, tenantId);
      if (!r.success) out.failed.push({ tenantId, code: r.error.code });
      else {
        if (r.data.created.length > 0) out.created.push({ tenantId, names: r.data.created });
        if (r.data.skipped.length > 0) out.skipped.push({ tenantId, names: r.data.skipped });
      }
    }
    return ok(out);
  });
}
