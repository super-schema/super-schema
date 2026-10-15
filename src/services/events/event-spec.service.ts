import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { ScopeTarget } from "@/lib/asset-scope";
import type { LevelScope } from "@/lib/levels";
import { formatVersionLabel } from "@/lib/entity-versioning/version-math";
import { toFrozenTrait, toResolvedChannel } from "@/lib/events/catalog-mapping";
import { normalizeCatalogName } from "@/lib/events/inputs";
import {
  collectDocumentRefs,
  emptyEventSpecDocument,
  parseEventSpecDocument,
  type DocumentProblem,
} from "@/lib/events/event-spec-document";
import { hasCatalogDrift } from "@/lib/events/publish-plan";
import type { EventSpecDetail, EventSpecDocument, FrozenChannel, FrozenTrait } from "@/lib/events/types";
import { inSameLine } from "@/services/name-registry.service";
import { createInScope, ServiceErrorRejection, writeWithUniqueName } from "@/services/scoped-create.service";
import { auditedWrite } from "@/services/events/audited";
import { CHANNEL_SELECT, TRAIT_SELECT } from "@/services/events/event-spec-resolver";
import { deleteReferencesFrom, replaceReferences } from "@/services/events/schema-references";
import { loadOwnedRow, optionalString, requireId } from "@/services/events/service-guards";
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

/** Ownership read (spec §10) through the shared guard: the FORBIDDEN / NOT_FOUND text is labelled by the caller's own id, never `row.name`. */
function loadOwned(ctx: ServiceContext, id: string, owner: ScopeTarget): Promise<Result<{ row: SpecRow; scope: LevelScope }>> {
  return loadOwnedRow(ctx.prisma, {
    kind: "Event spec", id, owner,
    load: (specId) => ctx.prisma.eventSpec.findUnique({ where: { id: specId }, select: SPEC_SELECT }),
  });
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
      // Tenant-scoped lookup above: another tenant's trait id reads exactly like a missing one (no name / kind leak).
      if (!t) problems.push({ pointer: `${p}/traitIds/${k}`, message: `Trait "${id}" not found` });
      else if (!inSameLine(t, scope)) problems.push({ pointer: `${p}/traitIds/${k}`, message: `Trait "${t.name}" is not visible from this product` });
      else if (t.kind !== "OPERATION") problems.push({ pointer: `${p}/traitIds/${k}`, message: `Trait "${t.name}" is a MESSAGE trait; operations take OPERATION traits` });
    });
    if (op.reply?.channelId && !channelSet.has(op.reply.channelId)) {
      problems.push({ pointer: `${p}/reply/channelId`, message: `Channel "${op.reply.channelId}" not found` });
    }
    if (op.reply?.messageVersionIds) checkMessages(op.reply.messageVersionIds, `${p}/reply/messageVersionIds`);
  });
  return { problems, messageVersionIds: refs.messageRefIds.filter((id) => versionSet.has(id)) };
}

/**
 * Input arrives from the client at runtime: `productId` must be a non-empty string and `input` an object whose `name` is a
 * string and whose optional `title` / `description` are strings. Anything else is a VALIDATION_ERROR before any query or
 * string method runs; an unknown (but well-formed) product id is NOT_FOUND from the scope resolution.
 */
export async function createEventSpec(productId: string, input: CreateEventSpecInput, ctx: ServiceContext): Promise<Result<EventSpecDetail>> {
  const product = requireId(productId, "productId");
  if (!product.success) return product;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return err({ code: "VALIDATION_ERROR", message: "Event spec input must be an object" });
  }
  const raw = input as unknown as Record<string, unknown>;
  const name = normalizeCatalogName(raw.name, "Event spec");
  if (!name.success) return name;
  const title = optionalString(raw.title, "Title");
  if (!title.success) return title;
  const description = optionalString(raw.description, "Description");
  if (!description.success) return description;
  const document = emptyEventSpecDocument(title.data?.trim() || name.data, description.data?.trim() || undefined);
  return auditedWrite({
    action: "CREATE", entityType: "EventSpec", entityId: "pending", userId: ctx.userId,
    run: async () => {
      const created = await createInScope(ctx.prisma, {
        kind: "eventSpec",
        target: { level: "PRODUCT", productId: product.data },
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

export async function renameEventSpec(id: string, rawName: unknown, owner: ScopeTarget, ctx: ServiceContext): Promise<Result<EventSpecDetail>> {
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

const frozenList = <T extends { id: string }>(value: unknown): T[] =>
  Array.isArray(value) ? (value as T[]).filter((v) => v !== null && typeof v === "object" && typeof v.id === "string") : [];

/**
 * D8 drift for the "unpublished changes" badges: which of these specs have a live Channel / Trait that differs from the copy
 * frozen into their latest version (the same `hasCatalogDrift` the publish planner uses for `hasChanges`). It reads the frozen
 * copies and the live rows only — no snapshot, no rendering, no emission — in three batched queries however many specs are
 * listed, so list pages can afford it. A published spec whose draft is unchanged references exactly its frozen channel / trait
 * ids, so the live rows are looked up by those ids; a deleted row drops out and counts as drift, as in the planner's snapshot.
 * (A spec with draft edits is already flagged by `hasUnpublishedChanges`; unpublished specs have nothing to drift from.)
 */
export async function findEventSpecsWithCatalogDrift(
  db: PrismaClient | Prisma.TransactionClient,
  tenantId: string,
  specIds: string[]
): Promise<Set<string>> {
  if (specIds.length === 0) return new Set();
  const rows = await db.eventSpec.findMany({
    where: { id: { in: specIds }, tenantId, latestVersionId: { not: null } },
    select: { id: true, latestVersion: { select: { frozenChannels: true, frozenTraits: true } } },
  });
  const frozen = rows.flatMap((r) =>
    r.latestVersion ? [{ id: r.id, channels: frozenList<FrozenChannel>(r.latestVersion.frozenChannels), traits: frozenList<FrozenTrait>(r.latestVersion.frozenTraits) }] : []
  );
  const channelIds = [...new Set(frozen.flatMap((f) => f.channels.map((c) => c.id)))];
  const traitIds = [...new Set(frozen.flatMap((f) => f.traits.map((t) => t.id)))];
  const [channelRows, traitRows] = await Promise.all([
    channelIds.length > 0 ? db.channel.findMany({ where: { id: { in: channelIds }, tenantId }, select: CHANNEL_SELECT }) : [],
    traitIds.length > 0 ? db.trait.findMany({ where: { id: { in: traitIds }, tenantId }, select: TRAIT_SELECT }) : [],
  ]);
  const liveChannels = new Map(channelRows.map((c) => [c.id, toResolvedChannel(c)]));
  const liveTraits = new Map(traitRows.map((t) => [t.id, toFrozenTrait(t)]));
  const present = <T,>(v: T | undefined): v is T => v !== undefined;
  const drifted = new Set<string>();
  for (const f of frozen) {
    const live = {
      channels: f.channels.map((c) => liveChannels.get(c.id)).filter(present),
      traits: f.traits.map((t) => liveTraits.get(t.id)).filter(present),
    };
    if (hasCatalogDrift({ channels: f.channels, traits: f.traits }, live)) drifted.add(f.id);
  }
  return drifted;
}

/** Read-side reuse by the page loader (Task 17); returns a Result because stored drafts are re-validated. */
export { SPEC_SELECT, toDetail as toEventSpecDetail };
