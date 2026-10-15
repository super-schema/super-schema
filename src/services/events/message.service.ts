import type { Prisma } from "@/generated/prisma/client";
import { resolveScope, type ScopeTarget } from "@/lib/asset-scope";
import type { LevelScope } from "@/lib/levels";
import { formatVersionLabel } from "@/lib/entity-versioning/version-math";
import { normalizeCatalogName } from "@/lib/events/inputs";
import { parseMessageSpec, readMessageSpec } from "@/lib/events/catalog-specs";
import { assertOwnedBy } from "@/lib/events/ownership";
import type { EntityPin, MessageDetail, MessageSpec } from "@/lib/events/types";
import { inSameLine } from "@/services/name-registry.service";
import { createInScope, writeWithUniqueName } from "@/services/scoped-create.service";
import { auditedWrite } from "@/services/events/audited";
import { resolvePin, type PinInput } from "@/services/events/pins";
import { deleteReferencesFrom, pinEdges, replaceReferences } from "@/services/events/schema-references";
import { ok, err, type Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";

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

async function normalizeMessage(ctx: ServiceContext, scope: LevelScope, input: MessageInput): Promise<Result<NormalizedMessage>> {
  const name = normalizeCatalogName(input.name, "Message");
  if (!name.success) return name;
  const spec = parseMessageSpec(input.spec ?? { traitIds: [] });
  if (!spec.success) return spec;

  const problems: string[] = [];
  const pin = async (value: PinInput | null | undefined, label: string): Promise<EntityPin | null> => {
    if (!value) return null;
    const r = await resolvePin(ctx.prisma, scope.tenantId, value, label);
    if (!r.success) problems.push(r.error.message);
    return r.success ? r.data : null;
  };
  const payload = await pin(input.payload, "Payload");
  const headers = await pin(input.headers, "Headers");
  const key = await pin(input.key, "Key");

  if (spec.data.traitIds.length > 0) {
    const traits = await ctx.prisma.trait.findMany({
      where: { id: { in: spec.data.traitIds } },
      select: { id: true, name: true, kind: true, tenantId: true, domainId: true, productId: true },
    });
    for (const id of spec.data.traitIds) {
      const t = traits.find((x) => x.id === id);
      if (!t) problems.push(`Trait "${id}" not found`);
      else if (t.kind !== "MESSAGE") problems.push(`Trait "${t.name}" is an OPERATION trait; messages take MESSAGE traits`);
      else if (!inSameLine(t, scope)) problems.push(`Trait "${t.name}" is not visible from this product (use a trait from this product, its domain or the Enterprise)`);
    }
  }
  if (!payload && problems.length === 0) problems.push("A payload entity is required");
  if (problems.length > 0 || !payload) {
    return err({ code: "VALIDATION_ERROR", message: problems.join("; "), details: { problems } });
  }
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

export async function deleteMessage(id: string, owner: ScopeTarget, ctx: ServiceContext): Promise<Result<{ id: string }>> {
  const owned = await loadOwned(ctx, id, owner);
  if (!owned.success) return owned;
  const versionIds = (await ctx.prisma.messageVersion.findMany({ where: { messageId: id }, select: { id: true } })).map((v) => v.id);
  if (versionIds.length > 0) {
    const pinned = await ctx.prisma.schemaReference.findFirst({
      where: { toKind: "MESSAGE_VERSION", toId: { in: versionIds }, isDraft: false },
      select: { fromId: true },
    });
    if (pinned) {
      return err({
        code: "IN_USE",
        message: `Message "${owned.data.row.name}" has versions used by a published event spec version and cannot be deleted.`,
        suggestedFix: "Deprecate it instead (spec §6.1: versions referenced by published versions are kept).",
      });
    }
  }
  return auditedWrite({
    action: "DELETE", entityType: "Message", entityId: id, userId: ctx.userId, beforeState: toDetail(owned.data.row),
    run: async () => {
      await ctx.prisma.$transaction(async (tx) => {
        await deleteReferencesFrom(tx, "MESSAGE", [id]);
        await deleteReferencesFrom(tx, "MESSAGE_VERSION", versionIds);
        if (versionIds.length > 0) await tx.schemaReference.deleteMany({ where: { toKind: "MESSAGE_VERSION", toId: { in: versionIds } } });
        await tx.message.delete({ where: { id } });
      });
      return ok({ id });
    },
  });
}

export async function getMessage(id: string, ctx: ServiceContext): Promise<Result<MessageDetail>> {
  const row = await ctx.prisma.message.findUnique({ where: { id }, select: MESSAGE_SELECT });
  return row ? ok(toDetail(row)) : err({ code: "NOT_FOUND", message: `Message "${id}" not found` });
}

/** Read-side reuse by the page loaders (Task 16). */
export { MESSAGE_SELECT, toDetail as toMessageDetail };
