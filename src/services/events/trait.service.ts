import type { Prisma } from "@/generated/prisma/client";
import { resolveScope, type ScopeTarget } from "@/lib/asset-scope";
import type { LevelScope } from "@/lib/levels";
import { isJsonObject, normalizeCatalogName } from "@/lib/events/inputs";
import { assertOwnedBy } from "@/lib/events/ownership";
import type { EntityPin, JsonObject, TraitDetail, TraitKind } from "@/lib/events/types";
import { createInScope, writeWithUniqueName } from "@/services/scoped-create.service";
import { auditedWrite } from "@/services/events/audited";
import { resolvePin, type PinInput } from "@/services/events/pins";
import { deleteReferencesFrom, pinEdges, replaceReferences } from "@/services/events/schema-references";
import { ok, err, type Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";

export interface TraitInput {
  name: string;
  kind: TraitKind;
  spec?: JsonObject;
  headers?: PinInput | null;
}

const TRAIT_SELECT = {
  id: true, name: true, kind: true, spec: true, headersEntityId: true, headersEntityVersionId: true,
  tenantId: true, domainId: true, productId: true,
} satisfies Prisma.TraitSelect;
type TraitRow = Prisma.TraitGetPayload<{ select: typeof TRAIT_SELECT }>;

function toDetail(row: TraitRow): TraitDetail {
  return {
    id: row.id, name: row.name, kind: row.kind, spec: isJsonObject(row.spec) ? row.spec : {},
    headers: row.headersEntityId ? { entityId: row.headersEntityId, entityVersionId: row.headersEntityVersionId } : null,
    tenantId: row.tenantId, domainId: row.domainId, productId: row.productId,
  };
}

interface NormalizedTrait {
  name: string;
  spec: JsonObject;
  headers: EntityPin | null;
}

async function normalizeTrait(ctx: ServiceContext, tenantId: string, kind: TraitKind, input: Omit<TraitInput, "kind">): Promise<Result<NormalizedTrait>> {
  const name = normalizeCatalogName(input.name, "Trait");
  if (!name.success) return name;
  if (input.spec !== undefined && !isJsonObject(input.spec)) return err({ code: "VALIDATION_ERROR", message: "Trait spec must be a JSON object" });
  if (input.headers && kind !== "MESSAGE") {
    return err({ code: "VALIDATION_ERROR", message: "Only MESSAGE traits can carry a headers entity", suggestedFix: "Remove the headers entity or create a MESSAGE trait." });
  }
  let headers: EntityPin | null = null;
  if (input.headers) {
    const pin = await resolvePin(ctx.prisma, tenantId, input.headers, "Headers");
    if (!pin.success) return pin;
    headers = pin.data;
  }
  return ok({ name: name.data, spec: input.spec ?? {}, headers });
}

function columns(n: NormalizedTrait) {
  return {
    name: n.name, spec: n.spec as Prisma.InputJsonValue,
    headersEntityId: n.headers?.entityId ?? null, headersEntityVersionId: n.headers?.entityVersionId ?? null,
  };
}

const headerEdges = (n: NormalizedTrait) => pinEdges({ headers: n.headers?.entityVersionId ?? null });

async function loadOwned(ctx: ServiceContext, id: string, owner: ScopeTarget): Promise<Result<{ row: TraitRow; scope: LevelScope }>> {
  const scope = await resolveScope(ctx.prisma, owner);
  if (!scope.success) return scope;
  const row = await ctx.prisma.trait.findUnique({ where: { id }, select: TRAIT_SELECT });
  if (!row) return err({ code: "NOT_FOUND", message: `Trait "${id}" not found` });
  const owned = assertOwnedBy(row, scope.data, `Trait "${row.name}"`);
  if (!owned.success) return owned;
  return ok({ row, scope: scope.data });
}

export async function createTrait(target: ScopeTarget, input: TraitInput, ctx: ServiceContext): Promise<Result<TraitDetail>> {
  if (input.kind !== "MESSAGE" && input.kind !== "OPERATION") return err({ code: "VALIDATION_ERROR", message: "Trait kind must be MESSAGE or OPERATION" });
  const scope = await resolveScope(ctx.prisma, target);
  if (!scope.success) return scope;
  const n = await normalizeTrait(ctx, scope.data.tenantId, input.kind, input);
  if (!n.success) return n;
  return auditedWrite({
    action: "CREATE", entityType: "Trait", entityId: "pending", userId: ctx.userId,
    run: async () => {
      const created = await createInScope(ctx.prisma, {
        kind: "trait",
        target,
        name: n.data.name,
        write: async (tx, s) => {
          const row = await tx.trait.create({ data: { kind: input.kind, ...columns(n.data), ...s }, select: TRAIT_SELECT });
          await replaceReferences(tx, { kind: "TRAIT", id: row.id }, headerEdges(n.data), false);
          return row;
        },
      });
      return created.success ? ok(toDetail(created.data)) : created;
    },
  });
}

export async function updateTrait(id: string, input: Omit<TraitInput, "kind">, owner: ScopeTarget, ctx: ServiceContext): Promise<Result<TraitDetail>> {
  const owned = await loadOwned(ctx, id, owner);
  if (!owned.success) return owned;
  const n = await normalizeTrait(ctx, owned.data.row.tenantId, owned.data.row.kind, input);
  if (!n.success) return n;
  return auditedWrite({
    action: "UPDATE", entityType: "Trait", entityId: id, userId: ctx.userId, beforeState: toDetail(owned.data.row),
    run: () =>
      writeWithUniqueName(ctx.prisma, {
        scope: owned.data.scope,
        name: n.data.name,
        exclude: { kind: "trait", id },
        write: async (tx) => {
          const row = await tx.trait.update({ where: { id }, data: columns(n.data), select: TRAIT_SELECT });
          await replaceReferences(tx, { kind: "TRAIT", id }, headerEdges(n.data), false);
          return toDetail(row);
        },
      }),
  });
}

export async function deleteTrait(id: string, owner: ScopeTarget, ctx: ServiceContext): Promise<Result<{ id: string }>> {
  const owned = await loadOwned(ctx, id, owner);
  if (!owned.success) return owned;
  return auditedWrite({
    action: "DELETE", entityType: "Trait", entityId: id, userId: ctx.userId, beforeState: toDetail(owned.data.row),
    run: async () => {
      await ctx.prisma.$transaction(async (tx) => {
        await deleteReferencesFrom(tx, "TRAIT", [id]);
        await tx.trait.delete({ where: { id } });
      });
      return ok({ id });
    },
  });
}

export async function getTrait(id: string, ctx: ServiceContext): Promise<Result<TraitDetail>> {
  const row = await ctx.prisma.trait.findUnique({ where: { id }, select: TRAIT_SELECT });
  return row ? ok(toDetail(row)) : err({ code: "NOT_FOUND", message: `Trait "${id}" not found` });
}

/** Read-side reuse by the page loaders (Task 15). */
export { TRAIT_SELECT, toDetail as toTraitDetail };
