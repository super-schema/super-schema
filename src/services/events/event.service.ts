// src/services/events/event.service.ts
// Self-contained Event (spec 2026-10-15-events-self-contained-design): create / update document / rename / delete / get over the v2
// document. The table is still `event_specs` (E5); the old catalog-id (version 1) documents and their service are gone.
import type { Prisma } from "@/generated/prisma/client";
import type { ScopeTarget } from "@/lib/asset-scope";
import { formatVersionLabel } from "@/lib/entity-versioning/version-math";
import { collectDocumentEdges, collectDocumentRefs, collectPinSites } from "@/lib/events/document/edges";
import { parseEventDocument } from "@/lib/events/document/parse";
import { emptyEventDocument, isLibraryTrait, type DocumentProblem, type EventDocument } from "@/lib/events/document/types";
import { normalizeCatalogName } from "@/lib/events/inputs";
import type { LevelScope } from "@/lib/levels";
import { createInScope, ServiceErrorRejection, writeWithUniqueName } from "@/services/scoped-create.service";
import { auditedWrite } from "@/services/events/audited";
import { eventsInUseError, findEventVersionReferrers } from "@/services/events/event-guards";
import { deleteReferencesFrom, replaceReferences } from "@/services/events/schema-references";
import { guardRead, loadOwnedRow, optionalString, requireId } from "@/services/events/service-guards";
import { ok, err, type Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";

export interface EventDetail {
  id: string;
  name: string;
  specType: string;
  document: EventDocument;
  latestVersionLabel: string | null;
  hasUnpublishedChanges: boolean;
  tenantId: string;
  domainId: string | null;
  productId: string | null;
}

export interface CreateEventInput {
  name: string;
  title?: string;
  description?: string;
}

export const EVENT_SELECT = {
  id: true, name: true, specType: true, document: true, hasUnpublishedChanges: true,
  tenantId: true, domainId: true, productId: true, latestVersion: { select: { major: true, minor: true } },
} satisfies Prisma.EventSpecSelect;
type EventRow = Prisma.EventSpecGetPayload<{ select: typeof EVENT_SELECT }>;

/**
 * A stored document that is not a valid v2 document — including every v1 (catalog-id) document, which only the old services
 * read — is DATA_CORRUPT. The message names the row by id, never by name: `getEvent` has no ownership check.
 */
function toDetail(row: EventRow): Result<EventDetail> {
  const document = parseEventDocument(row.document);
  if (!document.success) {
    return err({ code: "DATA_CORRUPT", message: `Stored document of event "${row.id}" is not a valid event document (v2)`, details: document.error.details });
  }
  return ok({
    id: row.id, name: row.name, specType: row.specType, document: document.data,
    latestVersionLabel: row.latestVersion ? formatVersionLabel(row.latestVersion) : null,
    hasUnpublishedChanges: row.hasUnpublishedChanges,
    tenantId: row.tenantId, domainId: row.domainId, productId: row.productId,
  });
}

/** For use inside a transaction callback: an unreadable row rolls the write back and surfaces as its DATA_CORRUPT error through `auditedWrite`. */
function detailOrRollback(row: EventRow): EventDetail {
  const d = toDetail(row);
  if (!d.success) throw new ServiceErrorRejection(d.error);
  return d.data;
}

/** Ownership read (spec §10) through the shared guard: FORBIDDEN / NOT_FOUND text is labelled by the caller's own id, never `row.name`. */
function loadOwned(ctx: ServiceContext, id: string, owner: ScopeTarget): Promise<Result<{ row: EventRow; scope: LevelScope }>> {
  return loadOwnedRow(ctx.prisma, {
    kind: "Event", id, owner,
    load: (eventId) => ctx.prisma.eventSpec.findUnique({ where: { id: eventId }, select: EVENT_SELECT }),
  });
}

// ── reference validation ────────────────────────────────────────────────────────────────────────────────────────────────

/** The ids of a stored `ResolvedEventSpec`'s channels or messages; `null` when there is no usable resolved spec (NULL column, malformed JSON). */
function resolvedItemIds(resolvedSpec: Prisma.JsonValue | null, kind: "channel" | "message"): Set<string> | null {
  if (resolvedSpec === null || typeof resolvedSpec !== "object" || Array.isArray(resolvedSpec)) return null;
  const items = resolvedSpec[kind === "channel" ? "channels" : "messages"];
  const ids = new Set<string>();
  if (Array.isArray(items)) {
    for (const item of items) {
      const id = item !== null && typeof item === "object" && !Array.isArray(item) ? item.id : undefined;
      if (typeof id === "string") ids.add(id);
    }
  }
  return ids;
}

/**
 * Everything the document points at must exist where the spec says it may (§4 / §10), reported all at once, in this order:
 * pins, library traits, external refs. Four batched reads however large the document is; every lookup is tenant-filtered, so
 * another tenant's entity / trait / event version reads exactly like a missing one (no name or kind leaks).
 *  - Pins (same rules as `resolvePin`): the entity is in this tenant; a non-null version belongs to that entity.
 *  - Library traits: same tenant, level tenant or this event's own domain (never product-level, never another domain), same kind.
 *  - External refs: a published `EventSpecVersion` (the row exists only once published) of this tenant, not of this event, whose
 *    stored `resolvedSpec` is non-null and contains the item (`channels[].id` / `messages[].id` = the ref's `itemKey`).
 */
async function validateDocumentRefs(ctx: ServiceContext, scope: LevelScope, eventId: string, doc: EventDocument): Promise<DocumentProblem[]> {
  const refs = collectDocumentRefs(doc);
  const { tenantId } = scope;
  const [entities, versions, traits, externals] = await Promise.all([
    refs.entityIds.length === 0 ? [] : ctx.prisma.entity.findMany({ where: { id: { in: refs.entityIds }, tenantId }, select: { id: true, name: true } }),
    refs.pinnedVersionIds.length === 0 ? [] : ctx.prisma.entityVersion.findMany({ where: { id: { in: refs.pinnedVersionIds }, entity: { tenantId } }, select: { id: true, entityId: true } }),
    refs.libraryTraitIds.length === 0 ? [] : ctx.prisma.trait.findMany({ where: { id: { in: refs.libraryTraitIds }, tenantId }, select: { id: true, name: true, kind: true, domainId: true, productId: true } }),
    refs.externalVersionIds.length === 0
      ? []
      : ctx.prisma.eventSpecVersion.findMany({
          where: { id: { in: refs.externalVersionIds }, eventSpec: { tenantId } },
          select: { id: true, eventSpecId: true, major: true, minor: true, resolvedSpec: true, eventSpec: { select: { name: true } } },
        }),
  ]);
  const entityById = new Map(entities.map((e) => [e.id, e]));
  const versionById = new Map(versions.map((v) => [v.id, v]));
  const traitById = new Map(traits.map((t) => [t.id, t]));
  const externalById = new Map(externals.map((v) => [v.id, v]));

  const problems: DocumentProblem[] = [];
  for (const { pointer, pin } of collectPinSites(doc)) {
    const entity = entityById.get(pin.entityId);
    if (!entity) {
      problems.push({ pointer: `${pointer}/entityId`, message: `Entity "${pin.entityId}" not found in this tenant` });
      continue;
    }
    if (pin.entityVersionId === null) continue;
    const version = versionById.get(pin.entityVersionId);
    if (!version || version.entityId !== entity.id) {
      problems.push({ pointer: `${pointer}/entityVersionId`, message: `"${pin.entityVersionId}" is not a published version of ${entity.name}` });
    }
  }

  doc.traits.forEach((t, i) => {
    if (!isLibraryTrait(t)) return;
    const pointer = `/traits/${i}/libraryTraitId`;
    const library = traitById.get(t.libraryTraitId);
    if (!library) problems.push({ pointer, message: `Library trait "${t.libraryTraitId}" not found` });
    else if (library.productId !== null || (library.domainId !== null && library.domainId !== scope.domainId)) {
      problems.push({ pointer, message: `Library trait "${library.name}" is not available to this event: only tenant-level traits and traits of the event's own domain can be used` });
    } else if (library.kind !== t.kind) {
      problems.push({ pointer, message: `Library trait "${library.name}" is of kind ${library.kind}, but "${t.key}" is of kind ${t.kind}` });
    }
  });

  doc.externalRefs.forEach((r, i) => {
    const pointer = `/externalRefs/${i}`;
    const version = externalById.get(r.eventVersionId);
    if (!version) {
      problems.push({ pointer: `${pointer}/eventVersionId`, message: `Event version "${r.eventVersionId}" not found` });
      return;
    }
    if (version.eventSpecId === eventId) {
      problems.push({ pointer: `${pointer}/eventVersionId`, message: "An event cannot reference its own version" });
      return;
    }
    const label = `Version ${formatVersionLabel(version)} of "${version.eventSpec.name}"`;
    const items = resolvedItemIds(version.resolvedSpec, r.kind);
    if (items === null) {
      problems.push({ pointer, message: `${label} cannot be referenced: it has no resolved spec (published before event documents v2)` });
    } else if (!items.has(r.itemKey)) {
      problems.push({ pointer: `${pointer}/itemKey`, message: `${label} has no ${r.kind} "${r.itemKey}"` });
    }
  });
  return problems;
}

// ── create / update / rename ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Input arrives from the client at runtime: `productId` must be a non-empty string and `input` an object whose `name` is a
 * string and whose optional `title` / `description` are strings. Anything else is a VALIDATION_ERROR before any query or
 * string method runs; an unknown (but well-formed) product id is NOT_FOUND from the scope resolution.
 */
export async function createEvent(productId: string, input: CreateEventInput, ctx: ServiceContext): Promise<Result<EventDetail>> {
  const product = requireId(productId, "productId");
  if (!product.success) return product;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return err({ code: "VALIDATION_ERROR", message: "Event input must be an object" });
  }
  const raw = input as unknown as Record<string, unknown>;
  const name = normalizeCatalogName(raw.name, "Event");
  if (!name.success) return name;
  const title = optionalString(raw.title, "Title");
  if (!title.success) return title;
  const description = optionalString(raw.description, "Description");
  if (!description.success) return description;
  const document = emptyEventDocument(title.data?.trim() || name.data, description.data?.trim() || undefined);
  return auditedWrite({
    action: "CREATE", entityType: "EventSpec", entityId: "pending", userId: ctx.userId,
    run: () =>
      createInScope(ctx.prisma, {
        kind: "eventSpec",
        target: { level: "PRODUCT", productId: product.data },
        name: name.data,
        write: async (tx, s) => detailOrRollback(await tx.eventSpec.create({ data: { name: name.data, document: document as unknown as Prisma.InputJsonValue, ...s }, select: EVENT_SELECT })),
      }),
  });
}

/**
 * Save the draft document. Parse problems are returned as they are; reference problems (pins, library traits, external refs)
 * come back together as one VALIDATION_ERROR. A save always marks the event as having unpublished changes and replaces the
 * event's draft edges from the document in the SAME transaction (the event row is updated first, so it is locked before any
 * edge is touched — the lock order publish expects: `event_specs`, then entities).
 */
export async function updateEventDocument(id: string, document: unknown, owner: ScopeTarget, ctx: ServiceContext): Promise<Result<EventDetail>> {
  const parsed = parseEventDocument(document);
  if (!parsed.success) return parsed;
  const owned = await loadOwned(ctx, id, owner);
  if (!owned.success) return owned;
  const checked = await guardRead(async () => ok(await validateDocumentRefs(ctx, owned.data.scope, id, parsed.data)));
  if (!checked.success) return checked;
  if (checked.data.length > 0) {
    return err({ code: "VALIDATION_ERROR", message: `The event references ${checked.data.length} unknown or invalid item(s)`, details: { problems: checked.data } });
  }
  return auditedWrite({
    action: "UPDATE", entityType: "EventSpec", entityId: id, userId: ctx.userId, beforeState: { document: owned.data.row.document },
    run: async () => {
      const detail = await ctx.prisma.$transaction(async (tx) => {
        const updated = await tx.eventSpec.update({
          where: { id },
          data: { document: parsed.data as unknown as Prisma.InputJsonValue, hasUnpublishedChanges: true },
          select: EVENT_SELECT,
        });
        await replaceReferences(tx, { kind: "EVENT_SPEC", id }, collectDocumentEdges(parsed.data), true);
        return detailOrRollback(updated);
      });
      return ok(detail);
    },
  });
}

export async function renameEvent(id: string, rawName: unknown, owner: ScopeTarget, ctx: ServiceContext): Promise<Result<EventDetail>> {
  const name = normalizeCatalogName(rawName, "Event");
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
        write: async (tx) => detailOrRollback(await tx.eventSpec.update({ where: { id }, data: { name: name.data }, select: EVENT_SELECT })),
      }),
  });
}

// ── delete ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Blocked (IN_USE) while any other event references one of its published versions. The check runs in the delete's own
 * transaction, right before the writes; the edges from the event and from its versions go with the row.
 */
export async function deleteEvent(id: string, owner: ScopeTarget, ctx: ServiceContext): Promise<Result<{ id: string }>> {
  const owned = await loadOwned(ctx, id, owner);
  if (!owned.success) return owned;
  const { row } = owned.data;
  return auditedWrite({
    action: "DELETE", entityType: "EventSpec", entityId: id, userId: ctx.userId, beforeState: { name: row.name },
    run: async () => {
      await ctx.prisma.$transaction(async (tx) => {
        const versions = await tx.eventSpecVersion.findMany({ where: { eventSpecId: id }, select: { id: true } });
        const blocked = eventsInUseError("Event", row.name, await findEventVersionReferrers(tx, id));
        if (blocked) throw new ServiceErrorRejection(blocked);
        await deleteReferencesFrom(tx, "EVENT_SPEC", [id]);
        await deleteReferencesFrom(tx, "EVENT_SPEC_VERSION", versions.map((v) => v.id));
        await tx.eventSpec.delete({ where: { id } });
      });
      return ok({ id });
    },
  });
}

// ── read ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Read by id (no ownership check — callers that need one use the write functions' `owner`); a DB throw becomes DB_ERROR. */
export async function getEvent(id: string, ctx: ServiceContext): Promise<Result<EventDetail>> {
  const eventId = requireId(id, "id");
  if (!eventId.success) return eventId;
  return guardRead(async () => {
    const row = await ctx.prisma.eventSpec.findUnique({ where: { id: eventId.data }, select: EVENT_SELECT });
    return row ? toDetail(row) : err({ code: "NOT_FOUND", message: `Event "${eventId.data}" not found` });
  });
}

/** Read-side reuse by later phases (page loader, snapshot): the same select and mapping the service itself uses. */
export { toDetail as toEventDetail };
