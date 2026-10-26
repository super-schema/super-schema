// src/services/events/usage.service.ts
import { formatVersionLabel } from "@/lib/entity-versioning/version-math";
import { describeUsage, parseUsageSubject, usageRowList, type UsageLookups, type UsageRow, type UsageRowList, type UsageSubject } from "@/lib/events/usage";
import { MAX_EVENT_REFERRERS, MAX_REFERRER_SCAN } from "@/services/events/event-guards";
import { guardRead, requireId } from "@/services/events/service-guards";
import { ok, err, type Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";

const AT = { domain: { select: { slug: true } }, product: { select: { slug: true } } } as const;
const at = (r: { domain: { slug: string } | null; product: { slug: string } | null }) => ({ domainSlug: r.domain?.slug ?? null, productSlug: r.product?.slug ?? null });
/**
 * Where a referrer lives, for the caller's read check: a referrer the caller's roles do not cover is dropped like another tenant's (never shown,
 * never a ghost), so a lookup of an entity or event the caller may read does not name the events, traits or entities of domains and products
 * they may not. Absent = no check (the whole tenant; the action always passes it from the policy).
 */
export type ReferrerPlace = { domainId: string | null; productId: string | null };
export type ReferrerVisible = (kind: "entity" | "event" | "trait", place: ReferrerPlace) => boolean;

const idsOf = (refs: Array<{ fromKind: string; fromId: string }>, kind: string) => refs.filter((r) => r.fromKind === kind).map((r) => r.fromId);

/** Rows of one referrer kind split by tenant; the other tenants' ids are collected so their edges can be dropped. */
function inTenant<T>(rows: T[], idOf: (r: T) => string, tenantOf: (r: T) => string, tenantId: string, kind: string, foreign: Set<string>, readable: (r: T) => boolean): T[] {
  return rows.filter((r) => {
    if (tenantOf(r) === tenantId && readable(r)) return true;
    foreign.add(`${kind}:${idOf(r)}`);
    return false;
  });
}

/**
 * Spec §6.1 / 18.9: every SchemaReference pointing at any version of the subject, published uses first. The subject is an entity
 * (events, library traits and other entities pin its versions) or an event (other events reference its published versions).
 *
 * `tenantId` is the server-resolved active tenant (the action never takes it from the client): a subject outside
 * it looks exactly like a missing one, and referrers outside it are dropped before anything is returned. Foreign
 * referrers are filtered after the lookup rather than by the query's `where` on purpose — a `where` miss is
 * indistinguishable from a deleted referrer, and a referrer whose row is gone is still listed as a "(deleted)" ghost
 * (defensive: the delete triggers, incl. 20261017 for EntityVersion-sourced edges, remove the edges they source).
 *
 * The result carries `truncated` (always false for an entity: its list is not bounded). An event's list is bounded like the
 * event guards' referrer lists: at most `MAX_REFERRER_SCAN` edges are read and `MAX_EVENT_REFERRERS` rows returned.
 */
export async function findUsages(subject: UsageSubject, ctx: ServiceContext, tenantId: string, visible?: ReferrerVisible): Promise<Result<UsageRowList>> {
  const parsed = parseUsageSubject(subject);
  if (!parsed.success) return parsed;
  const tenant = requireId(tenantId, "tenantId");
  if (!tenant.success) return tenant;
  const target = parsed.data;
  return guardRead(() => (target.kind === "event" ? lookupEventUsages(target.eventId, ctx, tenant.data, visible) : lookupEntityUsages(target.entityId, ctx, tenant.data, visible)));
}

interface VersionTarget {
  id: string;
  label: string;
}
const labelsOf = (targets: VersionTarget[]) => Object.fromEntries(targets.map((x) => [x.id, x.label]));
/** Published uses first, then oldest first: the order the panel shows. */
const BY_USE = [{ isDraft: "asc" as const }, { createdAt: "asc" as const }, { id: "asc" as const }];

async function lookupEntityUsages(entityId: string, ctx: ServiceContext, tenantId: string, visible?: ReferrerVisible): Promise<Result<UsageRowList>> {
  const db = ctx.prisma;
  const entity = await db.entity.findFirst({ where: { id: entityId, tenantId }, select: { name: true, versions: { select: { id: true, major: true, minor: true } } } });
  if (!entity) return err({ code: "NOT_FOUND", message: `Entity "${entityId}" not found` });
  const targets = entity.versions.map((v) => ({ id: v.id, label: `${entity.name} v${formatVersionLabel(v)}` }));
  if (targets.length === 0) return ok(usageRowList([], false));

  const refs = await db.schemaReference.findMany({ where: { toKind: "ENTITY_VERSION", toId: { in: targets.map((t) => t.id) } }, orderBy: BY_USE });
  return ok(usageRowList(await describeReferences(ctx, tenantId, refs, labelsOf(targets), visible), false));
}

/**
 * Other events that reference any published version of the event (external references, `toKind` EVENT_SPEC_VERSION). The event's
 * own edges (its draft, or one of its own versions pointing at another of its own) are left out by the query itself rather than
 * after it, so they cannot use up the scan.
 */
async function lookupEventUsages(eventId: string, ctx: ServiceContext, tenantId: string, visible?: ReferrerVisible): Promise<Result<UsageRowList>> {
  const db = ctx.prisma;
  const event = await db.eventSpec.findFirst({ where: { id: eventId, tenantId }, select: { name: true, versions: { select: { id: true, major: true, minor: true } } } });
  if (!event) return err({ code: "NOT_FOUND", message: `Event "${eventId}" not found` });
  const targets = event.versions.map((v) => ({ id: v.id, label: `${event.name} v${formatVersionLabel(v)}` }));
  if (targets.length === 0) return ok(usageRowList([], false));
  const targetIds = targets.map((t) => t.id);

  const scanned = await db.schemaReference.findMany({
    where: {
      toKind: "EVENT_SPEC_VERSION",
      toId: { in: targetIds },
      NOT: [{ fromKind: "EVENT_SPEC", fromId: eventId }, { fromKind: "EVENT_SPEC_VERSION", fromId: { in: targetIds } }],
    },
    orderBy: BY_USE,
    take: MAX_REFERRER_SCAN + 1,
  });
  const scanTruncated = scanned.length > MAX_REFERRER_SCAN;
  const rows = await describeReferences(ctx, tenantId, scanTruncated ? scanned.slice(0, MAX_REFERRER_SCAN) : scanned, labelsOf(targets), visible);
  return ok(usageRowList(rows.slice(0, MAX_EVENT_REFERRERS), scanTruncated || rows.length > MAX_EVENT_REFERRERS));
}

/** The referrers behind the edges, looked up per kind; another tenant's edges are dropped (never shown, never a ghost). */
async function describeReferences(
  ctx: ServiceContext,
  tenantId: string,
  refs: Array<{ id: string; fromKind: string; fromId: string; role: string; isDraft: boolean; toId: string }>,
  targetLabels: Record<string, string>,
  visible?: ReferrerVisible
): Promise<UsageRow[]> {
  const db = ctx.prisma;
  const [entityVersions, eventSpecs, eventSpecVersions, traits] = await Promise.all([
    db.entityVersion.findMany({ where: { id: { in: idsOf(refs, "ENTITY_VERSION") } }, select: { id: true, major: true, minor: true, entity: { select: { name: true, slug: true, tenantId: true, domainId: true, productId: true, ...AT } } } }),
    db.eventSpec.findMany({ where: { id: { in: idsOf(refs, "EVENT_SPEC") } }, select: { id: true, name: true, tenantId: true, domainId: true, productId: true, ...AT } }),
    db.eventSpecVersion.findMany({ where: { id: { in: idsOf(refs, "EVENT_SPEC_VERSION") } }, select: { id: true, major: true, minor: true, eventSpec: { select: { id: true, name: true, tenantId: true, domainId: true, productId: true, ...AT } } } }),
    db.trait.findMany({ where: { id: { in: idsOf(refs, "TRAIT") } }, select: { id: true, name: true, tenantId: true, domainId: true, productId: true, ...AT } }),
  ]);

  const foreign = new Set<string>();
  const readable = <T extends { domainId: string | null; productId: string | null }>(kind: "entity" | "event" | "trait") => (row: T) =>
    visible === undefined || visible(kind, { domainId: row.domainId, productId: row.productId });
  const ev = inTenant(entityVersions, (v) => v.id, (v) => v.entity.tenantId, tenantId, "ENTITY_VERSION", foreign, (v) => readable("entity")(v.entity));
  const s = inTenant(eventSpecs, (x) => x.id, (x) => x.tenantId, tenantId, "EVENT_SPEC", foreign, readable("event"));
  const sv = inTenant(eventSpecVersions, (v) => v.id, (v) => v.eventSpec.tenantId, tenantId, "EVENT_SPEC_VERSION", foreign, (v) => readable("event")(v.eventSpec));
  const t = inTenant(traits, (x) => x.id, (x) => x.tenantId, tenantId, "TRAIT", foreign, readable("trait"));

  const lookups: UsageLookups = {
    entityVersions: Object.fromEntries(ev.map((v) => [v.id, { label: formatVersionLabel(v), entity: { name: v.entity.name, slug: v.entity.slug, ...at(v.entity) } }])),
    eventSpecs: Object.fromEntries(s.map((x) => [x.id, { id: x.id, name: x.name, ...at(x) }])),
    eventSpecVersions: Object.fromEntries(sv.map((v) => [v.id, { label: formatVersionLabel(v), eventSpec: { id: v.eventSpec.id, name: v.eventSpec.name, ...at(v.eventSpec) } }])),
    traits: Object.fromEntries(t.map((x) => [x.id, { id: x.id, name: x.name, ...at(x) }])),
  };
  return refs.filter((r) => !foreign.has(`${r.fromKind}:${r.fromId}`)).map((r) => describeUsage(r, lookups, targetLabels));
}
