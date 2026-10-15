import type { Prisma } from "@/generated/prisma/client";
import { resolveScope, type ScopeTarget } from "@/lib/asset-scope";
import type { LevelScope } from "@/lib/levels";
import { formatVersionLabel } from "@/lib/entity-versioning/version-math";
import { normalizeCatalogName } from "@/lib/events/inputs";
import {
  collectDocumentRefs,
  emptyEventSpecDocument,
  parseEventSpecDocument,
  type DocumentProblem,
} from "@/lib/events/event-spec-document";
import { assertOwnedBy } from "@/lib/events/ownership";
import type { EventSpecDetail, EventSpecDocument } from "@/lib/events/types";
import { inSameLine } from "@/services/name-registry.service";
import { createInScope, ServiceErrorRejection, writeWithUniqueName } from "@/services/scoped-create.service";
import { auditedWrite } from "@/services/events/audited";
import { deleteReferencesFrom, replaceReferences } from "@/services/events/schema-references";
import { ok, err, type Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";

export interface CreateEventSpecInput {
  name: string;
  title?: string;
  description?: string;
}

const SPEC_SELECT = {
  id: true, name: true, specType: true, document: true, hasUnpublishedChanges: true,
  tenantId: true, domainId: true, productId: true, latestVersion: { select: { major: true, minor: true } },
} satisfies Prisma.EventSpecSelect;
type SpecRow = Prisma.EventSpecGetPayload<{ select: typeof SPEC_SELECT }>;

function toDetail(row: SpecRow): Result<EventSpecDetail> {
  const document = parseEventSpecDocument(row.document);
  if (!document.success) return err({ code: "DATA_CORRUPT", message: `Stored document of event spec "${row.name}" is invalid`, details: document.error.details });
  return ok({
    id: row.id, name: row.name, specType: row.specType, document: document.data,
    latestVersionLabel: row.latestVersion ? formatVersionLabel(row.latestVersion) : null,
    hasUnpublishedChanges: row.hasUnpublishedChanges,
    tenantId: row.tenantId, domainId: row.domainId, productId: row.productId,
  });
}

/**
 * For use inside a transaction callback: a corrupt stored document (only possible for rows written outside
 * this service) rolls the write back and surfaces as its DATA_CORRUPT error through `auditedWrite`.
 */
function detailOrRollback(row: SpecRow): EventSpecDetail {
  const d = toDetail(row);
  if (!d.success) throw new ServiceErrorRejection(d.error);
  return d.data;
}

async function loadOwned(ctx: ServiceContext, id: string, owner: ScopeTarget): Promise<Result<{ row: SpecRow; scope: LevelScope }>> {
  const scope = await resolveScope(ctx.prisma, owner);
  if (!scope.success) return scope;
  const row = await ctx.prisma.eventSpec.findUnique({ where: { id }, select: SPEC_SELECT });
  if (!row) return err({ code: "NOT_FOUND", message: `Event spec "${id}" not found` });
  const owned = assertOwnedBy(row, scope.data, `Event spec "${row.name}"`);
  if (!owned.success) return owned;
  return ok({ row, scope: scope.data });
}

/** Every referenced id must exist; drafts (D4) only from this spec's product; traits must be OPERATION traits in line. */
async function validateDocumentRefs(
  ctx: ServiceContext,
  scope: LevelScope,
  doc: EventSpecDocument
): Promise<{ problems: DocumentProblem[]; messageVersionIds: string[] }> {
  const refs = collectDocumentRefs(doc);
  const [channels, versions, drafts, traits] = await Promise.all([
    ctx.prisma.channel.findMany({ where: { id: { in: refs.channelIds }, tenantId: scope.tenantId }, select: { id: true } }),
    ctx.prisma.messageVersion.findMany({ where: { id: { in: refs.messageRefIds }, message: { tenantId: scope.tenantId } }, select: { id: true } }),
    ctx.prisma.message.findMany({ where: { id: { in: refs.messageRefIds }, productId: scope.productId }, select: { id: true } }),
    ctx.prisma.trait.findMany({ where: { id: { in: refs.traitIds }, tenantId: scope.tenantId }, select: { id: true, name: true, kind: true, tenantId: true, domainId: true, productId: true } }),
  ]);
  const channelSet = new Set(channels.map((c) => c.id));
  const versionSet = new Set(versions.map((v) => v.id));
  const draftSet = new Set(drafts.map((d) => d.id));

  const problems: DocumentProblem[] = [];
  const checkMessages = (ids: string[], pointer: string) =>
    ids.forEach((id, j) => {
      if (!versionSet.has(id) && !draftSet.has(id)) {
        problems.push({ pointer: `${pointer}/${j}`, message: `"${id}" is neither a message version nor a message draft of this product` });
      }
    });
  doc.operations.forEach((op, i) => {
    const p = `/operations/${i}`;
    if (!channelSet.has(op.channelId)) problems.push({ pointer: `${p}/channelId`, message: `Channel "${op.channelId}" not found` });
    checkMessages(op.messageVersionIds, `${p}/messageVersionIds`);
    op.traitIds.forEach((id, k) => {
      const t = traits.find((x) => x.id === id);
      if (!t) problems.push({ pointer: `${p}/traitIds/${k}`, message: `Trait "${id}" not found` });
      else if (t.kind !== "OPERATION") problems.push({ pointer: `${p}/traitIds/${k}`, message: `Trait "${t.name}" is a MESSAGE trait; operations take OPERATION traits` });
      else if (!inSameLine(t, scope)) problems.push({ pointer: `${p}/traitIds/${k}`, message: `Trait "${t.name}" is not visible from this product` });
    });
    if (op.reply?.channelId && !channelSet.has(op.reply.channelId)) {
      problems.push({ pointer: `${p}/reply/channelId`, message: `Channel "${op.reply.channelId}" not found` });
    }
    if (op.reply?.messageVersionIds) checkMessages(op.reply.messageVersionIds, `${p}/reply/messageVersionIds`);
  });
  return { problems, messageVersionIds: refs.messageRefIds.filter((id) => versionSet.has(id)) };
}

export async function createEventSpec(productId: string, input: CreateEventSpecInput, ctx: ServiceContext): Promise<Result<EventSpecDetail>> {
  const name = normalizeCatalogName(input.name, "Event spec");
  if (!name.success) return name;
  const document = emptyEventSpecDocument(input.title?.trim() || name.data, input.description?.trim() || undefined);
  return auditedWrite({
    action: "CREATE", entityType: "EventSpec", entityId: "pending", userId: ctx.userId,
    run: async () => {
      const created = await createInScope(ctx.prisma, {
        kind: "eventSpec",
        target: { level: "PRODUCT", productId },
        name: name.data,
        write: (tx, s) => tx.eventSpec.create({ data: { name: name.data, document: document as unknown as Prisma.InputJsonValue, ...s }, select: SPEC_SELECT }),
      });
      return created.success ? toDetail(created.data) : created;
    },
  });
}

export async function updateEventSpecDocument(id: string, document: unknown, owner: ScopeTarget, ctx: ServiceContext): Promise<Result<EventSpecDetail>> {
  const parsed = parseEventSpecDocument(document);
  if (!parsed.success) return parsed;
  const owned = await loadOwned(ctx, id, owner);
  if (!owned.success) return owned;
  const { problems, messageVersionIds } = await validateDocumentRefs(ctx, owned.data.scope, parsed.data);
  if (problems.length > 0) {
    return err({ code: "VALIDATION_ERROR", message: `The event spec references ${problems.length} unknown or invalid item(s)`, details: { problems } });
  }
  return auditedWrite({
    action: "UPDATE", entityType: "EventSpec", entityId: id, userId: ctx.userId, beforeState: { document: owned.data.row.document },
    run: async () => {
      const row = await ctx.prisma.$transaction(async (tx) => {
        const updated = await tx.eventSpec.update({
          where: { id },
          data: { document: parsed.data as unknown as Prisma.InputJsonValue, hasUnpublishedChanges: true },
          select: SPEC_SELECT,
        });
        await replaceReferences(
          tx,
          { kind: "EVENT_SPEC", id },
          messageVersionIds.map((toId) => ({ role: "MESSAGE" as const, toKind: "MESSAGE_VERSION" as const, toId })),
          true
        );
        return updated;
      });
      return toDetail(row);
    },
  });
}

export async function renameEventSpec(id: string, rawName: string, owner: ScopeTarget, ctx: ServiceContext): Promise<Result<EventSpecDetail>> {
  const name = normalizeCatalogName(rawName, "Event spec");
  if (!name.success) return name;
  const owned = await loadOwned(ctx, id, owner);
  if (!owned.success) return owned;
  return auditedWrite({
    action: "UPDATE", entityType: "EventSpec", entityId: id, userId: ctx.userId, beforeState: { name: owned.data.row.name },
    run: () =>
      writeWithUniqueName(ctx.prisma, {
        scope: owned.data.scope,
        name: name.data,
        exclude: { kind: "eventSpec", id },
        write: async (tx) => detailOrRollback(await tx.eventSpec.update({ where: { id }, data: { name: name.data }, select: SPEC_SELECT })),
      }),
  });
}

export async function deleteEventSpec(id: string, owner: ScopeTarget, ctx: ServiceContext): Promise<Result<{ id: string }>> {
  const owned = await loadOwned(ctx, id, owner);
  if (!owned.success) return owned;
  const versionIds = (await ctx.prisma.eventSpecVersion.findMany({ where: { eventSpecId: id }, select: { id: true } })).map((v) => v.id);
  return auditedWrite({
    action: "DELETE", entityType: "EventSpec", entityId: id, userId: ctx.userId, beforeState: { name: owned.data.row.name },
    run: async () => {
      await ctx.prisma.$transaction(async (tx) => {
        await deleteReferencesFrom(tx, "EVENT_SPEC", [id]);
        await deleteReferencesFrom(tx, "EVENT_SPEC_VERSION", versionIds);
        await tx.eventSpec.delete({ where: { id } });
      });
      return ok({ id });
    },
  });
}

export async function getEventSpec(id: string, ctx: ServiceContext): Promise<Result<EventSpecDetail>> {
  const row = await ctx.prisma.eventSpec.findUnique({ where: { id }, select: SPEC_SELECT });
  return row ? toDetail(row) : err({ code: "NOT_FOUND", message: `Event spec "${id}" not found` });
}

/** Read-side reuse by the page loader (Task 17); returns a Result because stored drafts are re-validated. */
export { SPEC_SELECT, toDetail as toEventSpecDetail };
