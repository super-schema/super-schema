import type { Prisma } from "@/generated/prisma/client";
import { resolveScope, type ScopeTarget } from "@/lib/asset-scope";
import type { LevelScope } from "@/lib/levels";
import { formatVersionLabel } from "@/lib/entity-versioning/version-math";
import { isJsonObject, normalizeCatalogName } from "@/lib/events/inputs";
import { parseMessageSpec, readMessageSpec } from "@/lib/events/catalog-specs";
import { assertOwnedBy } from "@/lib/events/ownership";
import type { EntityPin, MessageDetail, MessageSpec } from "@/lib/events/types";
import { inSameLine } from "@/services/name-registry.service";
import { createInScope, writeWithUniqueName } from "@/services/scoped-create.service";
import { auditedWrite } from "@/services/events/audited";
import { resolvePin, type PinInput } from "@/services/events/pins";
import { deleteReferencesFrom, pinEdges, replaceReferences } from "@/services/events/schema-references";
import { ok, err, type Result, type ServiceError } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";

/**
 * The complete editable state of a message draft. `updateMessage` is a FULL REPLACE of this shape, so an
 * editor (Task 16) must round-trip everything it loaded; whatever is omitted is reset:
 *
 * - `spec` omitted (or `null`) → reset to `{ traitIds: [] }` (all AsyncAPI fields and trait refs cleared).
 * - `headers` / `key` omitted, `null` or `undefined` → that pin is removed.
 * - a pin's `entityVersionId` omitted → re-pin to the entity's *latest published version at update time*
 *   (D5; this silently moves an existing pin forward). Send the exact `entityVersionId` you loaded to keep it.
 * - a pin's `entityVersionId: null` → explicitly unpinned (draft preview only; publish is blocked).
 *
 * Malformed input (non-object input, non-string name / ids, non-array `traitIds`, …) is a `VALIDATION_ERROR`.
 */
export interface MessageInput {
  name: string;
  spec?: MessageSpec;
  payload: PinInput;
  headers?: PinInput | null;
  key?: PinInput | null;
}

const MESSAGE_SELECT = {
  id: true, name: true, spec: true, hasUnpublishedChanges: true, tenantId: true, domainId: true, productId: true,
  payloadEntityId: true, payloadEntityVersionId: true, headersEntityId: true, headersEntityVersionId: true,
  keyEntityId: true, keyEntityVersionId: true,
  latestVersion: { select: { major: true, minor: true } },
} satisfies Prisma.MessageSelect;
type MessageRow = Prisma.MessageGetPayload<{ select: typeof MESSAGE_SELECT }>;

const pinOf = (entityId: string | null, entityVersionId: string | null): EntityPin | null =>
  entityId ? { entityId, entityVersionId } : null;

function toDetail(row: MessageRow): MessageDetail {
  return {
    id: row.id, name: row.name, spec: readMessageSpec(row.spec),
    payload: { entityId: row.payloadEntityId, entityVersionId: row.payloadEntityVersionId },
    headers: pinOf(row.headersEntityId, row.headersEntityVersionId),
    key: pinOf(row.keyEntityId, row.keyEntityVersionId),
    latestVersionLabel: row.latestVersion ? formatVersionLabel(row.latestVersion) : null,
    hasUnpublishedChanges: row.hasUnpublishedChanges,
    tenantId: row.tenantId, domainId: row.domainId, productId: row.productId,
  };
}

interface NormalizedMessage {
  name: string;
  spec: MessageSpec;
  payload: EntityPin;
  headers: EntityPin | null;
  key: EntityPin | null;
}

const invalid = (problems: string[]) =>
  err({ code: "VALIDATION_ERROR", message: problems.join("; "), details: { problems } });

/** Shape-checks one pin of untrusted action input (nothing here may throw); problems are pushed, not returned. */
function readPinInput(value: unknown, label: string, problems: string[]): PinInput | null {
  if (value === undefined || value === null) return null;
  if (!isJsonObject(value)) {
    problems.push(`${label} must be an object`);
    return null;
  }
  const { entityId, entityVersionId } = value;
  if (typeof entityId !== "string" || entityId.length === 0) {
    problems.push(`${label}: entityId must be a non-empty string`);
    return null;
  }
  if (entityVersionId !== undefined && entityVersionId !== null && (typeof entityVersionId !== "string" || entityVersionId.length === 0)) {
    problems.push(`${label}: entityVersionId must be a non-empty string, null or omitted`);
    return null;
  }
  return entityVersionId === undefined ? { entityId } : { entityId, entityVersionId };
}

async function normalizeMessage(ctx: ServiceContext, scope: LevelScope, input: unknown): Promise<Result<NormalizedMessage>> {
  if (!isJsonObject(input)) return invalid(["Message input must be an object"]);
  if (typeof input.name !== "string") return invalid(["Message name must be a string"]);
  const name = normalizeCatalogName(input.name, "Message");
  if (!name.success) return name;
  const spec = parseMessageSpec(input.spec ?? { traitIds: [] });
  if (!spec.success) return spec;

  const problems: string[] = [];
  const payloadIn = readPinInput(input.payload, "Payload", problems);
  const headersIn = readPinInput(input.headers, "Headers", problems);
  const keyIn = readPinInput(input.key, "Key", problems);
  if (input.payload === undefined || input.payload === null) problems.push("A payload entity is required");
  if (problems.length > 0 || !payloadIn) return invalid(problems);

  const pin = async (value: PinInput | null, label: string): Promise<EntityPin | null> => {
    if (!value) return null;
    const r = await resolvePin(ctx.prisma, scope.tenantId, value, label);
    if (!r.success) problems.push(r.error.message);
    return r.success ? r.data : null;
  };
  const payload = await pin(payloadIn, "Payload");
  const headers = await pin(headersIn, "Headers");
  const key = await pin(keyIn, "Key");

  if (spec.data.traitIds.length > 0) {
    // Tenant-scoped: a trait id from another tenant must look exactly like a missing one (no name / kind leak).
    const traits = await ctx.prisma.trait.findMany({
      where: { id: { in: spec.data.traitIds }, tenantId: scope.tenantId },
      select: { id: true, name: true, kind: true, tenantId: true, domainId: true, productId: true },
    });
    for (const id of spec.data.traitIds) {
      const t = traits.find((x) => x.id === id);
      if (!t) problems.push(`Trait "${id}" not found`);
      else if (!inSameLine(t, scope)) problems.push(`Trait "${t.name}" is not visible from this product (use a trait from this product, its domain or the Enterprise)`);
      else if (t.kind !== "MESSAGE") problems.push(`Trait "${t.name}" is an OPERATION trait; messages take MESSAGE traits`);
    }
  }
  if (problems.length > 0 || !payload) return invalid(problems);
  return ok({ name: name.data, spec: spec.data, payload, headers, key });
}

function columns(n: NormalizedMessage) {
  return {
    name: n.name, spec: n.spec as unknown as Prisma.InputJsonValue,
    payloadEntityId: n.payload.entityId, payloadEntityVersionId: n.payload.entityVersionId,
    headersEntityId: n.headers?.entityId ?? null, headersEntityVersionId: n.headers?.entityVersionId ?? null,
    keyEntityId: n.key?.entityId ?? null, keyEntityVersionId: n.key?.entityVersionId ?? null,
  };
}

const draftEdges = (n: NormalizedMessage) =>
  pinEdges({ payload: n.payload.entityVersionId, headers: n.headers?.entityVersionId ?? null, key: n.key?.entityVersionId ?? null });

async function loadOwned(ctx: ServiceContext, id: string, owner: ScopeTarget): Promise<Result<{ row: MessageRow; scope: LevelScope }>> {
  const scope = await resolveScope(ctx.prisma, owner);
  if (!scope.success) return scope;
  const row = await ctx.prisma.message.findUnique({ where: { id }, select: MESSAGE_SELECT });
  if (!row) return err({ code: "NOT_FOUND", message: `Message "${id}" not found` });
  const owned = assertOwnedBy(row, scope.data, `Message "${row.name}"`);
  if (!owned.success) return owned;
  return ok({ row, scope: scope.data });
}

export async function createMessage(productId: string, input: MessageInput, ctx: ServiceContext): Promise<Result<MessageDetail>> {
  const target = { level: "PRODUCT" as const, productId };
  const scope = await resolveScope(ctx.prisma, target);
  if (!scope.success) return scope;
  const n = await normalizeMessage(ctx, scope.data, input);
  if (!n.success) return n;
  return auditedWrite({
    action: "CREATE", entityType: "Message", entityId: "pending", userId: ctx.userId,
    run: async () => {
      const created = await createInScope(ctx.prisma, {
        kind: "message",
        target,
        name: n.data.name,
        write: async (tx, s) => {
          const row = await tx.message.create({ data: { ...columns(n.data), ...s }, select: MESSAGE_SELECT });
          await replaceReferences(tx, { kind: "MESSAGE", id: row.id }, draftEdges(n.data), true);
          return row;
        },
      });
      return created.success ? ok(toDetail(created.data)) : created;
    },
  });
}

/**
 * Full replace of the draft (see `MessageInput` for the exact semantics of every omitted / null field);
 * always marks the draft as having unpublished changes and rewrites the mirrored draft `SchemaReference` edges.
 * Task 16's editor must send back the complete `spec` and the exact `entityVersionId` of every pin it loaded.
 */
export async function updateMessage(id: string, input: MessageInput, owner: ScopeTarget, ctx: ServiceContext): Promise<Result<MessageDetail>> {
  const owned = await loadOwned(ctx, id, owner);
  if (!owned.success) return owned;
  const n = await normalizeMessage(ctx, owned.data.scope, input);
  if (!n.success) return n;
  return auditedWrite({
    action: "UPDATE", entityType: "Message", entityId: id, userId: ctx.userId, beforeState: toDetail(owned.data.row),
    run: () =>
      writeWithUniqueName(ctx.prisma, {
        scope: owned.data.scope,
        name: n.data.name,
        exclude: { kind: "message", id },
        write: async (tx) => {
          const row = await tx.message.update({ where: { id }, data: { ...columns(n.data), hasUnpublishedChanges: true }, select: MESSAGE_SELECT });
          await replaceReferences(tx, { kind: "MESSAGE", id }, draftEdges(n.data), true);
          return toDetail(row);
        },
      }),
  });
}

const MAX_NAMED_SPECS = 5;

interface PinningSpec {
  id: string;
  name: string;
  versions: string[];
}

/**
 * Published event spec versions that pin one of the message's versions, or null when none does.
 * Runs on the delete transaction, after the message row lock, so it sees every committed publish.
 */
async function findPublishedPins(tx: Prisma.TransactionClient, versionIds: string[]): Promise<{ specs: PinningSpec[] } | null> {
  const edges = await tx.schemaReference.findMany({
    where: { toKind: "MESSAGE_VERSION", toId: { in: versionIds }, isDraft: false },
    select: { fromKind: true, fromId: true },
  });
  if (edges.length === 0) return null;
  const edgeSpecVersionIds = edges.filter((e) => e.fromKind === "EVENT_SPEC_VERSION").map((e) => e.fromId);
  const specVersions = await tx.eventSpecVersion.findMany({
    where: { OR: [{ id: { in: edgeSpecVersionIds } }, { messageVersionIds: { hasSome: versionIds } }] },
    select: { major: true, minor: true, eventSpec: { select: { id: true, name: true } } },
    orderBy: [{ eventSpec: { name: "asc" } }, { sequence: "asc" }],
  });
  const bySpec = new Map<string, PinningSpec>();
  for (const v of specVersions) {
    const entry = bySpec.get(v.eventSpec.id) ?? { id: v.eventSpec.id, name: v.eventSpec.name, versions: [] };
    entry.versions.push(formatVersionLabel(v));
    bySpec.set(v.eventSpec.id, entry);
  }
  return { specs: [...bySpec.values()] };
}

function inUseError(messageName: string, pins: { specs: PinningSpec[] }): ServiceError {
  const { specs } = pins;
  const described = specs.slice(0, MAX_NAMED_SPECS).map((s) => `"${s.name}" (${s.versions.join(", ")})`);
  const more = specs.length - described.length;
  const by = specs.length === 0 ? "a published event spec version" : `published event spec versions of ${described.join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
  return {
    code: "IN_USE",
    message: `Message "${messageName}" cannot be deleted: its versions are pinned by ${by}.`,
    details: { eventSpecs: specs },
    suggestedFix:
      specs.length === 0
        ? "Delete the event specs whose published versions pin this message first (published spec versions cannot be changed or deleted on their own), or keep the message."
        : `Event spec "${specs[0].name}" has published versions that pin this message. Published spec versions cannot be changed or deleted on their own, so delete event spec "${specs[0].name}" (which removes its versions) before deleting the message${specs.length > 1 ? `; ${specs.length - 1} more spec(s) are listed in details` : ""}. Or keep the message.`,
  };
}

/**
 * Deletes a message and, with it, its immutable versions (the Wave 0 triggers allow that only through the
 * parent). Refused with IN_USE while a published event spec version pins one of those versions.
 *
 * Concurrency contract with the publish paths (R57 / R60), because `event_spec_versions.messageVersionIds` has
 * no FK. Everything here happens in ONE transaction that first takes `SELECT ... FOR UPDATE` on the message
 * row, then re-reads the version ids and re-checks the non-draft edges, so a publish that committed in the
 * meantime is always seen.
 *
 * GLOBAL LOCK ORDER: `event_specs` row -> `messages` rows (FOR SHARE for spec publish, FOR UPDATE for delete)
 * -> `schema_references` writes. Delete locks the message first and only then touches the rows it removes or
 * cascades (`message_versions`, `channel_messages`, `schema_references`); it never takes an `event_specs`
 * lock, so it cannot deadlock against publish.
 * - Spec publish (Task 12): lock the spec row; then `SELECT ... FROM messages WHERE id IN (<owning messages of
 *   the pinned message versions>) ORDER BY id FOR SHARE`; verify the pinned message versions still exist; only
 *   then write the version row and the edges.
 * - Message publish (Task 10): needs no FOR SHARE. Inserting the `message_versions` row already takes
 *   `FOR KEY SHARE` on the parent message row through the FK, and it updates `messages`, so it serializes
 *   against this delete on its own.
 * Whoever locks the message row first wins: a delete first makes the publish fail its re-verification, a
 * publish first makes the delete return IN_USE.
 */
export async function deleteMessage(id: string, owner: ScopeTarget, ctx: ServiceContext): Promise<Result<{ id: string }>> {
  const owned = await loadOwned(ctx, id, owner);
  if (!owned.success) return owned;
  const name = owned.data.row.name;
  return auditedWrite({
    action: "DELETE", entityType: "Message", entityId: id, userId: ctx.userId, beforeState: toDetail(owned.data.row),
    run: () =>
      ctx.prisma.$transaction(async (tx): Promise<Result<{ id: string }>> => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "messages" WHERE "id" = ${id} FOR UPDATE`;
        if (locked.length === 0) return err({ code: "NOT_FOUND", message: `Message "${id}" no longer exists` });
        const versionIds = (await tx.messageVersion.findMany({ where: { messageId: id }, select: { id: true } })).map((v) => v.id);
        if (versionIds.length > 0) {
          const pins = await findPublishedPins(tx, versionIds);
          if (pins) return err(inUseError(name, pins));
        }
        await deleteReferencesFrom(tx, "MESSAGE", [id]);
        await deleteReferencesFrom(tx, "MESSAGE_VERSION", versionIds);
        // Only draft spec edges can be left here (a non-draft one returned IN_USE above).
        if (versionIds.length > 0) {
          await tx.schemaReference.deleteMany({ where: { toKind: "MESSAGE_VERSION", toId: { in: versionIds }, isDraft: true } });
        }
        await tx.message.delete({ where: { id } });
        return ok({ id });
      }),
  });
}

export async function getMessage(id: string, ctx: ServiceContext): Promise<Result<MessageDetail>> {
  const row = await ctx.prisma.message.findUnique({ where: { id }, select: MESSAGE_SELECT });
  return row ? ok(toDetail(row)) : err({ code: "NOT_FOUND", message: `Message "${id}" not found` });
}

/** Read-side reuse by the page loaders (Task 16). */
export { MESSAGE_SELECT, toDetail as toMessageDetail };
