// src/services/events/event-guards.ts
// Pin-integrity guards for self-contained events (spec 2026-10-15-events-self-contained-design §6 / §10).
//
// An event document points at entity versions, library traits and other events' published versions WITHOUT foreign keys: the
// old `messages` / `message_versions` FKs (which turned an entity delete into a P2003) are gone, so these reads are what stops
// the delete / retire / cascade that would leave a dangling pin. Every read is scoped to the target's tenant, bounded, and runs
// sequentially (the delete paths pass an interactive transaction: one connection). Nothing here takes a lock.
//
// Sources, per finder:
//  - draft edges (`schema_references`, fromKind EVENT_SPEC) written on every document save, and published edges
//    (fromKind EVENT_SPEC_VERSION) written at publish; an edge whose referrer no longer exists is not a referrer;
//  - the draft documents themselves (JSONB containment) for what has no edge: an unpinned pin names an entity but no version.
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { formatVersionLabel } from "@/lib/entity-versioning/version-math";
import type { DeleteGuardScope } from "@/services/events/delete-guards";
import type { ServiceError } from "@/types/result";

type Db = PrismaClient | Prisma.TransactionClient;

/** One event that holds a pin on / a reference to the thing being deleted or retired. */
export interface EventReferrer {
  eventId: string;
  eventName: string;
  domainName: string;
  productName: string;
  /** A published version of the event holds the reference (immutable: only deleting the event releases it). */
  published: boolean;
}

/**
 * What the finders return per event: the `EventReferrer` plus how it holds the reference. `draft` and `referencedVersions` are
 * what the event delete's `details.referrers` reports (pinned by its tests), so every guard reports them the same way.
 */
export interface EventReferrerUsage extends EventReferrer {
  /** The event's draft holds the reference (fixed by editing that draft). */
  draft: boolean;
  /** Labels ("1.0") of the target's versions the referrer points at, oldest first; empty when only an unpinned pin / a trait id names it. */
  referencedVersions: string[];
}

/** A referrer list cut at `MAX_EVENT_REFERRERS`; `truncated` says more existed (also set when a scan limit was hit). */
export type EventReferrerList = EventReferrerUsage[] & { readonly truncated: boolean };

/** Referrers returned (and listed in an error's `details`). The message names the first `MAX_NAMED_REFERRERS`. */
export const MAX_EVENT_REFERRERS = 50;
const MAX_NAMED_REFERRERS = 5;
/** Rows read per source before the list is flagged truncated. Any hit blocks; only the first few are ever named. */
export const MAX_REFERRER_SCAN = 200;
/** Ids per `IN (...)` list (a domain can own many event versions). */
const ID_CHUNK = 1000;

// ── shared reads ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const SPEC_SELECT = {
  id: true, name: true, domainId: true, productId: true,
  domain: { select: { name: true } }, product: { select: { name: true } },
} satisfies Prisma.EventSpecSelect;
type SpecRow = Prisma.EventSpecGetPayload<{ select: typeof SPEC_SELECT }>;

type EdgeSource = "EVENT_SPEC" | "EVENT_SPEC_VERSION";
const EDGE_SOURCES: EdgeSource[] = ["EVENT_SPEC", "EVENT_SPEC_VERSION"];
interface ScannedEdge { fromKind: string; fromId: string; toId: string }
/** One reference found: the referencing event, whether it is its draft or a published version, and the target version it points at. */
interface Hit { spec: SpecRow; draft: boolean; label: string | null }

function referrerList(items: EventReferrerUsage[], truncated: boolean): EventReferrerList {
  return Object.defineProperty(items, "truncated", { value: truncated, enumerable: false }) as EventReferrerList;
}

/** "1.0" < "1.2" < "1.10" < "2.0": numeric, not lexical. */
function compareLabels(a: string, b: string): number {
  const [aMajor = 0, aMinor = 0] = a.split(".").map(Number);
  const [bMajor = 0, bMinor = 0] = b.split(".").map(Number);
  return aMajor - bMajor || aMinor - bMinor || a.localeCompare(b);
}

/** Edges (draft and published, from events) into the given target versions: at most `MAX_REFERRER_SCAN`, then `truncated`. */
async function scanEdges(db: Db, toKind: "ENTITY_VERSION" | "EVENT_SPEC_VERSION", toIds: string[]): Promise<{ edges: ScannedEdge[]; truncated: boolean }> {
  const edges: ScannedEdge[] = [];
  for (let i = 0; i < toIds.length && edges.length <= MAX_REFERRER_SCAN; i += ID_CHUNK) {
    const rows = await db.schemaReference.findMany({
      where: { toKind, toId: { in: toIds.slice(i, i + ID_CHUNK) }, fromKind: { in: EDGE_SOURCES } },
      select: { fromKind: true, fromId: true, toId: true },
      orderBy: [{ fromId: "asc" }, { id: "asc" }],
      take: MAX_REFERRER_SCAN + 1 - edges.length,
    });
    edges.push(...rows);
  }
  const truncated = edges.length > MAX_REFERRER_SCAN;
  return { edges: truncated ? edges.slice(0, MAX_REFERRER_SCAN) : edges, truncated };
}

/** The events behind the edges, same tenant only (edges are polymorphic: a stray cross-tenant or dangling edge resolves to nothing). */
async function hitsOfEdges(db: Db, tenantId: string, edges: ScannedEdge[], labelOf: Map<string, string>): Promise<Hit[]> {
  if (edges.length === 0) return [];
  const idsOf = (kind: EdgeSource) => [...new Set(edges.filter((e) => e.fromKind === kind).map((e) => e.fromId))];
  const draftIds = idsOf("EVENT_SPEC");
  const versionIds = idsOf("EVENT_SPEC_VERSION");
  const drafts = draftIds.length === 0 ? [] : await db.eventSpec.findMany({ where: { id: { in: draftIds }, tenantId }, select: SPEC_SELECT });
  const versions =
    versionIds.length === 0
      ? []
      : await db.eventSpecVersion.findMany({ where: { id: { in: versionIds }, eventSpec: { tenantId } }, select: { id: true, eventSpec: { select: SPEC_SELECT } } });
  const ofDraft = new Map(drafts.map((s) => [s.id, s]));
  const ofVersion = new Map(versions.map((v) => [v.id, v.eventSpec]));
  return edges.flatMap((e) => {
    const draft = e.fromKind === "EVENT_SPEC";
    const spec = (draft ? ofDraft : ofVersion).get(e.fromId);
    return spec ? [{ spec, draft, label: labelOf.get(e.toId) ?? e.toId }] : [];
  });
}

/** One referrer per event (sorted by name, then id), bounded to `MAX_EVENT_REFERRERS`; `skip` drops events that do not count. */
function collect(hits: Hit[], scanTruncated: boolean, skip: (spec: SpecRow) => boolean = () => false): EventReferrerList {
  const byEvent = new Map<string, EventReferrerUsage>();
  for (const { spec, draft, label } of hits) {
    if (skip(spec)) continue;
    const entry = byEvent.get(spec.id) ?? {
      eventId: spec.id, eventName: spec.name, domainName: spec.domain?.name ?? "-", productName: spec.product?.name ?? "-",
      published: false, draft: false, referencedVersions: [],
    };
    if (draft) entry.draft = true;
    else entry.published = true;
    if (label !== null && !entry.referencedVersions.includes(label)) entry.referencedVersions.push(label);
    byEvent.set(spec.id, entry);
  }
  const all = [...byEvent.values()].sort((a, b) => a.eventName.localeCompare(b.eventName) || a.eventId.localeCompare(b.eventId));
  for (const r of all) r.referencedVersions.sort(compareLabels);
  return referrerList(all.slice(0, MAX_EVENT_REFERRERS), scanTruncated || all.length > MAX_EVENT_REFERRERS);
}

const byNameThenId = [{ name: "asc" as const }, { id: "asc" as const }];

// ── finders ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The four places a document names an entity: message payload / headers / key pin and a local trait's headers pin. */
const namesEntity = (entityId: string): Prisma.EventSpecWhereInput[] => [
  { document: { path: ["messages"], array_contains: [{ payload: { entityId } }] } },
  { document: { path: ["messages"], array_contains: [{ headers: { entityId } }] } },
  { document: { path: ["messages"], array_contains: [{ keyPin: { entityId } }] } },
  { document: { path: ["traits"], array_contains: [{ headers: { entityId } }] } },
];

/**
 * Events of the entity's tenant that hold the entity:
 *  - draft AND published edges to ANY version of it (a pin on a draft only counts, and a published version pins for good);
 *  - drafts whose document names the entity at any pin site, which also covers an UNPINNED pin (no edge exists for it).
 * A stale edge (the event is gone) and another tenant's events are not referrers.
 */
export async function findEntityEventReferrers(db: Db, entity: { id: string; tenantId: string }): Promise<EventReferrerList> {
  const versions = await db.entityVersion.findMany({ where: { entityId: entity.id }, select: { id: true, major: true, minor: true } });
  const hits: Hit[] = [];
  let truncated = false;
  if (versions.length > 0) {
    const scan = await scanEdges(db, "ENTITY_VERSION", versions.map((v) => v.id));
    truncated = scan.truncated;
    hits.push(...(await hitsOfEdges(db, entity.tenantId, scan.edges, new Map(versions.map((v) => [v.id, formatVersionLabel(v)])))));
  }
  const named = await db.eventSpec.findMany({
    where: { tenantId: entity.tenantId, OR: namesEntity(entity.id) },
    select: SPEC_SELECT,
    orderBy: byNameThenId,
    take: MAX_REFERRER_SCAN + 1,
  });
  if (named.length > MAX_REFERRER_SCAN) truncated = true;
  hits.push(...named.slice(0, MAX_REFERRER_SCAN).map((spec) => ({ spec, draft: true, label: null })));
  return collect(hits, truncated);
}

/**
 * The events that hold the entity's LATEST version: draft or published edges to exactly that version. This is the retire rule:
 * retiring freezes the entity, and an event still pinned to its current version would be left on a retired entity; a pin on an
 * older version is a deliberate choice that retiring does not change, and an unpinned pin names no version. Unlike the
 * delete guard this reads edges only, so a hit is exact (never lost to the `MAX_EVENT_REFERRERS` cut: the list is non-empty).
 */
export async function findEntityLatestVersionEventReferrers(
  db: Db,
  entity: { id: string; tenantId: string; latestVersionId: string | null }
): Promise<EventReferrerList> {
  const latestId = entity.latestVersionId;
  if (!latestId) return referrerList([], false);
  const scan = await scanEdges(db, "ENTITY_VERSION", [latestId]);
  if (scan.edges.length === 0) return referrerList([], false);
  const latest = await db.entityVersion.findUnique({ where: { id: latestId }, select: { major: true, minor: true } });
  const labelOf = new Map([[latestId, latest ? formatVersionLabel(latest) : latestId]]);
  return collect(await hitsOfEdges(db, entity.tenantId, scan.edges, labelOf), scan.truncated);
}

/**
 * Events of the trait's tenant that use the library trait:
 *  - drafts with `traits[].libraryTraitId` (JSONB containment on `event_specs.document`);
 *  - published versions that carry it in their source document (`traits[].libraryTraitId`) or froze it (`frozenTraits[].id`).
 *    Versions without a `resolvedSpec` (published before document v2) are not matched through `frozenTraits`: they carried
 *    catalog ids, not library traits. None can exist since migration 20261020 refuses to run while one does.
 */
export async function findLibraryTraitEventReferrers(db: Db, trait: { id: string; tenantId: string }): Promise<EventReferrerList> {
  const { id, tenantId } = trait;
  const drafts = await db.eventSpec.findMany({
    where: { tenantId, document: { path: ["traits"], array_contains: [{ libraryTraitId: id }] } },
    select: SPEC_SELECT,
    orderBy: byNameThenId,
    take: MAX_REFERRER_SCAN + 1,
  });
  const versions = await db.eventSpecVersion.findMany({
    where: {
      eventSpec: { tenantId },
      OR: [
        { sourceDocument: { path: ["traits"], array_contains: [{ libraryTraitId: id }] } },
        { frozenTraits: { array_contains: [{ id }] }, resolvedSpec: { not: Prisma.DbNull } },
      ],
    },
    select: { major: true, minor: true, eventSpec: { select: SPEC_SELECT } },
    orderBy: [{ eventSpec: { name: "asc" } }, { eventSpec: { id: "asc" } }, { sequence: "asc" }],
    take: MAX_REFERRER_SCAN + 1,
  });
  const truncated = drafts.length > MAX_REFERRER_SCAN || versions.length > MAX_REFERRER_SCAN;
  return collect(
    [
      ...drafts.slice(0, MAX_REFERRER_SCAN).map((spec) => ({ spec, draft: true, label: null })),
      ...versions.slice(0, MAX_REFERRER_SCAN).map((v) => ({ spec: v.eventSpec, draft: false, label: formatVersionLabel(v) })),
    ],
    truncated
  );
}

/**
 * Other events (same tenant) whose draft or published versions reference one of this event's published versions
 * (`schema_references` toKind EVENT_SPEC_VERSION: external refs). The event's own edges to itself are not referrers.
 */
export async function findEventVersionReferrers(db: Db, eventId: string): Promise<EventReferrerList> {
  const event = await db.eventSpec.findUnique({ where: { id: eventId }, select: { tenantId: true, versions: { select: { id: true, major: true, minor: true } } } });
  if (!event || event.versions.length === 0) return referrerList([], false);
  const scan = await scanEdges(db, "EVENT_SPEC_VERSION", event.versions.map((v) => v.id));
  const hits = await hitsOfEdges(db, event.tenantId, scan.edges, new Map(event.versions.map((v) => [v.id, formatVersionLabel(v)])));
  return collect(hits, scan.truncated, (spec) => spec.id === eventId);
}

/**
 * Events OUTSIDE the product / domain being deleted (same tenant) that reference a published version of an event INSIDE it.
 * The delete cascades the inside events and their versions, which would leave those references dangling for good.
 */
export async function findCrossProductEventRefs(db: Db, scope: DeleteGuardScope): Promise<EventReferrerList> {
  const inside = scope.kind === "product" ? { productId: scope.productId } : { domainId: scope.domainId };
  const versions = await db.eventSpecVersion.findMany({ where: { eventSpec: { tenantId: scope.tenantId, ...inside } }, select: { id: true, major: true, minor: true } });
  if (versions.length === 0) return referrerList([], false);
  const scan = await scanEdges(db, "EVENT_SPEC_VERSION", versions.map((v) => v.id));
  const hits = await hitsOfEdges(db, scope.tenantId, scan.edges, new Map(versions.map((v) => [v.id, formatVersionLabel(v)])));
  const isInside = (spec: SpecRow) => (scope.kind === "product" ? spec.productId === scope.productId : spec.domainId === scope.domainId);
  return collect(hits, scan.truncated, isInside);
}

// ── errors ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type EventsGuardKind = "Entity" | "Trait" | "Event" | "Product" | "Domain";
export type EventsGuardAction = "deleted" | "retired";

const KIND_NOUN: Record<EventsGuardKind, string> = { Entity: "entity", Trait: "trait", Event: "event", Product: "product", Domain: "domain" };
/** What to do about a DRAFT-only referrer, per kind. */
const DRAFT_FIX: Record<EventsGuardKind, string> = {
  Entity: "Remove the pin from", Trait: "Remove the trait from", Event: "Remove the external reference from",
  Product: "Remove the external reference from", Domain: "Remove the external reference from",
};

/** The `details.referrers` item: the shape the event delete has always reported. */
function toDetail(r: EventReferrer) {
  const usage = r as Partial<EventReferrerUsage>;
  return {
    eventId: r.eventId, name: r.eventName, domain: r.domainName, product: r.productName,
    referencedVersions: usage.referencedVersions ?? [], draft: usage.draft ?? !r.published, published: r.published,
  };
}

/** `checkout (payments/checkout), …, and 2+ more` — at most `MAX_NAMED_REFERRERS` names, then the rest counted. */
function describeReferrers(listed: EventReferrer[], truncated: boolean): string {
  const shown = listed.slice(0, MAX_NAMED_REFERRERS);
  const hidden = listed.length - shown.length;
  const tail = hidden > 0 ? `, and ${hidden}${truncated ? "+" : ""} more` : truncated ? ", and more" : "";
  return `${shown.map((r) => `${r.eventName} (${r.domainName}/${r.productName})`).join(", ")}${tail}`;
}

function clauseOf(kind: EventsGuardKind, action: EventsGuardAction, listed: EventReferrer[], named: string): string {
  const events = listed.length === 1 ? "event" : "events";
  switch (kind) {
    case "Event": return `its published versions are referenced by ${named}`;
    case "Entity": return `${action === "retired" ? "its latest version is" : "it is"} pinned by ${events} ${named}`;
    case "Trait": return `it is used by ${events} ${named}`;
    case "Product": return `other products' events reference its events: ${named}`;
    case "Domain": return `other domains' events reference its events: ${named}`;
  }
}

function build(kind: EventsGuardKind, name: string, found: EventReferrer[], action: EventsGuardAction) {
  const truncated = (found as { truncated?: unknown }).truncated === true || found.length > MAX_EVENT_REFERRERS;
  const listed = found.slice(0, MAX_EVENT_REFERRERS);
  const clause = clauseOf(kind, action, listed, describeReferrers(listed, truncated));
  return { truncated, listed, clause, prefix: `${kind} "${name}" cannot be ${action}: ` };
}

function suggestedFixFor(kind: EventsGuardKind, listed: EventReferrer[]): string {
  const published = listed.find((r) => r.published);
  const noun = KIND_NOUN[kind];
  if (published) {
    return `Published versions cannot be changed, so delete event "${published.eventName}" (which removes its published versions)${listed.length > 1 ? " and the other referrers listed" : ""} first, or keep the ${noun}.`;
  }
  return `${DRAFT_FIX[kind]} ${listed.length === 1 ? `"${listed[0].eventName}"` : "the drafts listed"} first, or keep the ${noun}.`;
}

/**
 * IN_USE naming the events (drafts and published versions alike, at most five by name) that hold the entity / library trait /
 * event / product / domain, or null when none does. `details` is `{ referrers, truncated }` (bounded, the event delete's shape).
 * `action` only changes the entity wording: `"retired"` says it is the LATEST version that is pinned.
 */
export function eventsInUseError(kind: EventsGuardKind, name: string, found: EventReferrer[], action: EventsGuardAction = "deleted"): ServiceError | null {
  if (found.length === 0) return null;
  const { truncated, listed, clause, prefix } = build(kind, name, found, action);
  return {
    code: "IN_USE",
    message: `${prefix}${clause}.`,
    details: { referrers: listed.map(toDetail), truncated },
    suggestedFix: suggestedFixFor(kind, listed),
  };
}

/**
 * The existing guard's outcome with the event guard's merged in: nothing found -> the existing outcome untouched (same message,
 * details and remedy); only events found -> `eventsInUseError`; both -> the existing error (its code kept) whose message gains
 * `, and <events clause>`, whose details gain `events: { referrers, truncated }` and whose remedies are both kept.
 */
export function withEventsInUse(
  existing: ServiceError | null,
  kind: EventsGuardKind,
  name: string,
  found: EventReferrer[],
  action: EventsGuardAction = "deleted"
): ServiceError | null {
  const events = eventsInUseError(kind, name, found, action);
  if (!events) return existing;
  if (!existing) return events;
  const { clause, prefix } = build(kind, name, found, action);
  const message = existing.message.startsWith(prefix) ? `${existing.message.replace(/\.$/, "")}, and ${clause}.` : `${existing.message} ${events.message}`;
  const suggestedFix = [existing.suggestedFix, events.suggestedFix].filter(Boolean).join(" ");
  return {
    ...existing,
    message,
    details: { ...(existing.details ?? {}), events: events.details },
    ...(suggestedFix && { suggestedFix }),
  };
}
