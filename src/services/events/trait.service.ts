import type { Prisma } from "@/generated/prisma/client";
import { resolveScope, type ScopeTarget } from "@/lib/asset-scope";
import type { LevelScope } from "@/lib/levels";
import { BUNDLED_MARKER_KEY, bundledMarker, inlineHeadersProblem } from "@/lib/events/bundled-traits";
import { isJsonObject, normalizeCatalogName } from "@/lib/events/inputs";
import type { EntityPin, JsonObject, TraitDetail, TraitKind } from "@/lib/events/types";
import { createInScope, writeWithUniqueName } from "@/services/scoped-create.service";
import { auditedWrite } from "@/services/events/audited";
import { findLibraryTraitEventReferrers, withEventsInUse } from "@/services/events/event-guards";
import { resolvePin, type PinInput } from "@/services/events/pins";
import { deleteReferencesFrom, pinEdges, replaceReferences } from "@/services/events/schema-references";
import { guardRead, loadOwnedRow, parseScopeTarget, requireId, requireString } from "@/services/events/service-guards";
import { ok, err, type Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";

export interface TraitInput {
  name: string;
  kind: TraitKind;
  /**
   * The AsyncAPI Message / Operation Trait object. A MESSAGE trait may describe its message properties inline as `spec.headers` (a JSON
   * Schema object); a pinned `headers` entity wins over it. The `x-bundled` key is reserved for the built-in traits and refused.
   */
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

const invalid = (message: string, suggestedFix?: string) =>
  err({ code: "VALIDATION_ERROR", message, ...(suggestedFix && { suggestedFix }) });

function asRecord(input: unknown): Result<Record<string, unknown>> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? ok(input as Record<string, unknown>)
    : invalid("Trait input must be an object");
}

/** Shape-check an untrusted headers pin; `undefined` / `null` mean "no headers entity". */
function parseHeadersPin(value: unknown): Result<PinInput | null> {
  if (value === undefined || value === null) return ok(null);
  if (typeof value !== "object" || Array.isArray(value)) return invalid("Headers must be an object like { entityId, entityVersionId? }");
  const pin = value as { entityId?: unknown; entityVersionId?: unknown };
  const entityId = requireId(pin.entityId, "Headers entityId");
  if (!entityId.success) return entityId;
  if (pin.entityVersionId === undefined || pin.entityVersionId === null) {
    return ok({ entityId: entityId.data, entityVersionId: pin.entityVersionId });
  }
  const versionId = requireId(pin.entityVersionId, "Headers entityVersionId");
  return versionId.success ? ok({ entityId: entityId.data, entityVersionId: versionId.data }) : versionId;
}

/**
 * The refusal for a built-in trait (`x-bundled` in its stored spec): read-only means read-only, whatever the UI does. FORBIDDEN, like every
 * write to a record the caller may not change; the message names the trait so a form can show it as it is.
 */
const builtInRefusal = (name: string, marker: string, verb: "modified" | "deleted") =>
  err({
    code: "FORBIDDEN",
    message: `${name} is built in and can't be ${verb}`,
    details: { bundled: marker },
    suggestedFix: "Apply it to a message as it is, or create your own message properties.",
  });

/**
 * What a caller-supplied `spec` may not contain: the built-in marker (only `ensureBundledTraits` writes it, so a user cannot forge a
 * read-only trait or make an editable one look built in), and an inline `headers` schema that is not a well-formed object schema
 * (MESSAGE traits only: an operation trait has no headers, so the assembler would silently drop them).
 */
function checkSpec(kind: TraitKind, spec: JsonObject): Result<void> {
  if (Object.hasOwn(spec, BUNDLED_MARKER_KEY)) {
    return invalid(`The "${BUNDLED_MARKER_KEY}" key is reserved for built-in message properties`, `Remove "${BUNDLED_MARKER_KEY}" from the spec.`);
  }
  if (spec.headers === undefined) return ok(undefined);
  if (kind !== "MESSAGE") return invalid("Only MESSAGE traits can carry headers", "Remove the headers or create a MESSAGE trait.");
  const problem = inlineHeadersProblem(spec.headers);
  return problem
    ? invalid(problem, 'Describe the headers as an object schema: { "type": "object", "required": ["name"], "properties": { "name": { "type": "string" } } }.')
    : ok(undefined);
}

async function normalizeTrait(ctx: ServiceContext, tenantId: string, kind: TraitKind, input: Record<string, unknown>): Promise<Result<NormalizedTrait>> {
  const rawName = requireString(input.name, "Trait name");
  if (!rawName.success) return rawName;
  const name = normalizeCatalogName(rawName.data, "Trait");
  if (!name.success) return name;
  if (input.spec !== undefined && !isJsonObject(input.spec)) return invalid("Trait spec must be a JSON object");
  if (input.spec !== undefined) {
    const spec = checkSpec(kind, input.spec);
    if (!spec.success) return spec;
  }
  const headersInput = parseHeadersPin(input.headers);
  if (!headersInput.success) return headersInput;
  const pinInput = headersInput.data;
  if (pinInput && kind !== "MESSAGE") {
    return invalid("Only MESSAGE traits can carry a headers entity", "Remove the headers entity or create a MESSAGE trait.");
  }
  let headers: EntityPin | null = null;
  if (pinInput) {
    const pin = await guardRead(() => resolvePin(ctx.prisma, tenantId, pinInput, "Headers"));
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

/** Validates the id + owner shapes, then reads the row and checks ownership; a DB throw becomes DB_ERROR. */
async function loadOwned(ctx: ServiceContext, id: unknown, owner: unknown): Promise<Result<{ row: TraitRow; scope: LevelScope }>> {
  const traitId = requireId(id, "Trait id");
  if (!traitId.success) return traitId;
  const target = parseScopeTarget(owner);
  if (!target.success) return target;
  // Labelled by the caller's own id, never `row.name`: the row may belong to another level or tenant.
  return loadOwnedRow(ctx.prisma, {
    kind: "Trait", id: traitId.data, owner: target.data,
    load: (rowId) => ctx.prisma.trait.findUnique({ where: { id: rowId }, select: TRAIT_SELECT }),
  });
}

export async function createTrait(target: ScopeTarget, input: TraitInput, ctx: ServiceContext): Promise<Result<TraitDetail>> {
  const raw = asRecord(input);
  if (!raw.success) return raw;
  if (raw.data.kind !== "MESSAGE" && raw.data.kind !== "OPERATION") return invalid("Trait kind must be MESSAGE or OPERATION");
  const kind: TraitKind = raw.data.kind;
  const parsedTarget = parseScopeTarget(target);
  if (!parsedTarget.success) return parsedTarget;
  const scope = await guardRead(() => resolveScope(ctx.prisma, parsedTarget.data));
  if (!scope.success) return scope;
  const n = await normalizeTrait(ctx, scope.data.tenantId, kind, raw.data);
  if (!n.success) return n;
  return auditedWrite({
    action: "CREATE", entityType: "Trait", entityId: "pending", userId: ctx.userId,
    run: async () => {
      const created = await createInScope(ctx.prisma, {
        kind: "trait",
        target: parsedTarget.data,
        name: n.data.name,
        write: async (tx, s) => {
          const row = await tx.trait.create({ data: { kind, ...columns(n.data), ...s }, select: TRAIT_SELECT });
          await replaceReferences(tx, { kind: "TRAIT", id: row.id }, headerEdges(n.data), false);
          return row;
        },
      });
      return created.success ? ok(toDetail(created.data)) : created;
    },
  });
}

/**
 * Full replace of the editable fields: `name`, `spec` and `headers` all take the input's value, so an omitted
 * `spec` resets to `{}` and an omitted (or null) `headers` unpins the headers entity and removes its
 * `schema_references` edge; an explicit `headers.entityVersionId` re-pins to that version, an omitted one pins the
 * entity's latest published version (D5).
 * Preserved: the id, the `kind` (immutable — a `kind` in the input is ignored) and the level columns.
 * A built-in trait (`x-bundled` in its stored spec) is refused with FORBIDDEN before anything is validated or written, and a spec that
 * carries `x-bundled` is refused for every other trait: nobody can edit a built-in or turn a custom trait into one.
 */
export async function updateTrait(id: string, input: Omit<TraitInput, "kind">, owner: ScopeTarget, ctx: ServiceContext): Promise<Result<TraitDetail>> {
  const raw = asRecord(input);
  if (!raw.success) return raw;
  const owned = await loadOwned(ctx, id, owner);
  if (!owned.success) return owned;
  const builtIn = bundledMarker(owned.data.row.spec);
  if (builtIn) return builtInRefusal(owned.data.row.name, builtIn, "modified");
  const n = await normalizeTrait(ctx, owned.data.row.tenantId, owned.data.row.kind, raw.data);
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

/**
 * Deletes a trait unless something still uses it (IN_USE, naming the same-tenant referrers): a published message version
 * that carries it, a published event spec version that froze it, or a live message / event spec draft that references it;
 * plus the events (drafts and published versions) whose document uses it as a library trait, merged into the same IN_USE.
 * A published version is immutable, so deleting a trait it carries would leave every spec using it permanently
 * `UNRESOLVED_REFERENCE`. The check and the delete share one transaction and take no lock of their own (the lock order is
 * `event_specs` -> `messages`, see `deleteMessage`).
 * A built-in trait (`x-bundled` in its stored spec) is never deleted here: FORBIDDEN.
 */
export async function deleteTrait(id: string, owner: ScopeTarget, ctx: ServiceContext): Promise<Result<{ id: string }>> {
  const owned = await loadOwned(ctx, id, owner);
  if (!owned.success) return owned;
  const { name, tenantId } = owned.data.row;
  const builtIn = bundledMarker(owned.data.row.spec);
  if (builtIn) return builtInRefusal(name, builtIn, "deleted");
  return auditedWrite({
    action: "DELETE", entityType: "Trait", entityId: id, userId: ctx.userId, beforeState: toDetail(owned.data.row),
    run: () =>
      ctx.prisma.$transaction(async (tx): Promise<Result<{ id: string }>> => {
        const blocked = withEventsInUse(null, "Trait", name, await findLibraryTraitEventReferrers(tx, { id, tenantId }));
        if (blocked) return err(blocked);
        await deleteReferencesFrom(tx, "TRAIT", [id]);
        await tx.trait.delete({ where: { id } });
        return ok({ id });
      }),
  });
}

export async function getTrait(id: string, ctx: ServiceContext): Promise<Result<TraitDetail>> {
  const traitId = requireId(id, "Trait id");
  if (!traitId.success) return traitId;
  return guardRead(async () => {
    const row = await ctx.prisma.trait.findUnique({ where: { id: traitId.data }, select: TRAIT_SELECT });
    return row ? ok(toDetail(row)) : err({ code: "NOT_FOUND", message: `Trait "${traitId.data}" not found` });
  });
}

/** Read-side reuse by the page loaders (Task 15). */
export { TRAIT_SELECT, toDetail as toTraitDetail };
