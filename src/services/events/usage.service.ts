// src/services/events/usage.service.ts
import { formatVersionLabel } from "@/lib/entity-versioning/version-math";
import { describeUsage, parseUsageSubject, type UsageLookups, type UsageRow, type UsageSubject } from "@/lib/events/usage";
import { guardRead, requireId } from "@/services/events/service-guards";
import { ok, err, type Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";

const AT = { domain: { select: { slug: true } }, product: { select: { slug: true } } } as const;
const at = (r: { domain: { slug: string } | null; product: { slug: string } | null }) => ({ domainSlug: r.domain?.slug ?? null, productSlug: r.product?.slug ?? null });
const idsOf = (refs: Array<{ fromKind: string; fromId: string }>, kind: string) => refs.filter((r) => r.fromKind === kind).map((r) => r.fromId);

/** Rows of one referrer kind split by tenant; the other tenants' ids are collected so their edges can be dropped. */
function inTenant<T>(rows: T[], idOf: (r: T) => string, tenantOf: (r: T) => string, tenantId: string, kind: string, foreign: Set<string>): T[] {
  return rows.filter((r) => {
    if (tenantOf(r) === tenantId) return true;
    foreign.add(`${kind}:${idOf(r)}`);
    return false;
  });
}

/**
 * Spec §6.1 / 18.9: every SchemaReference pointing at any version of the subject, published uses first.
 *
 * `tenantId` is the server-resolved active tenant (the action never takes it from the client): a subject outside
 * it looks exactly like a missing one, and referrers outside it are dropped before anything is returned. Foreign
 * referrers are filtered after the lookup rather than by the query's `where` on purpose — a `where` miss is
 * indistinguishable from a deleted referrer, and deleted ones must still be listed as "(deleted)" ghosts
 * (EntityVersion-sourced edges are not cleaned up when an entity is deleted).
 */
export async function findUsages(subject: UsageSubject, ctx: ServiceContext, tenantId: string): Promise<Result<UsageRow[]>> {
  const parsed = parseUsageSubject(subject);
  if (!parsed.success) return parsed;
  const tenant = requireId(tenantId, "tenantId");
  if (!tenant.success) return tenant;
  return guardRead(() => lookupUsages(parsed.data, ctx, tenant.data));
}

async function lookupUsages(subject: UsageSubject, ctx: ServiceContext, tenantId: string): Promise<Result<UsageRow[]>> {
  const db = ctx.prisma;
  let toKind: "ENTITY_VERSION" | "MESSAGE_VERSION";
  let targets: Array<{ id: string; label: string }>;
  if (subject.kind === "entity") {
    const entity = await db.entity.findFirst({ where: { id: subject.entityId, tenantId }, select: { name: true, versions: { select: { id: true, major: true, minor: true } } } });
    if (!entity) return err({ code: "NOT_FOUND", message: `Entity "${subject.entityId}" not found` });
    toKind = "ENTITY_VERSION";
    targets = entity.versions.map((v) => ({ id: v.id, label: `${entity.name} v${formatVersionLabel(v)}` }));
  } else {
    const message = await db.message.findFirst({ where: { id: subject.messageId, tenantId }, select: { name: true, versions: { select: { id: true, major: true, minor: true } } } });
    if (!message) return err({ code: "NOT_FOUND", message: `Message "${subject.messageId}" not found` });
    toKind = "MESSAGE_VERSION";
    targets = message.versions.map((v) => ({ id: v.id, label: `${message.name} v${formatVersionLabel(v)}` }));
  }
  if (targets.length === 0) return ok([]);

  const refs = await db.schemaReference.findMany({
    where: { toKind, toId: { in: targets.map((t) => t.id) } },
    orderBy: [{ isDraft: "asc" }, { createdAt: "asc" }, { id: "asc" }],
  });
  const [entityVersions, messages, messageVersions, eventSpecs, eventSpecVersions, traits] = await Promise.all([
    db.entityVersion.findMany({ where: { id: { in: idsOf(refs, "ENTITY_VERSION") } }, select: { id: true, major: true, minor: true, entity: { select: { name: true, slug: true, tenantId: true, ...AT } } } }),
    db.message.findMany({ where: { id: { in: idsOf(refs, "MESSAGE") } }, select: { id: true, name: true, tenantId: true, ...AT } }),
    db.messageVersion.findMany({ where: { id: { in: idsOf(refs, "MESSAGE_VERSION") } }, select: { id: true, major: true, minor: true, message: { select: { id: true, name: true, tenantId: true, ...AT } } } }),
    db.eventSpec.findMany({ where: { id: { in: idsOf(refs, "EVENT_SPEC") } }, select: { id: true, name: true, tenantId: true, ...AT } }),
    db.eventSpecVersion.findMany({ where: { id: { in: idsOf(refs, "EVENT_SPEC_VERSION") } }, select: { id: true, major: true, minor: true, eventSpec: { select: { id: true, name: true, tenantId: true, ...AT } } } }),
    db.trait.findMany({ where: { id: { in: idsOf(refs, "TRAIT") } }, select: { id: true, name: true, tenantId: true, ...AT } }),
  ]);

  const foreign = new Set<string>();
  const ev = inTenant(entityVersions, (v) => v.id, (v) => v.entity.tenantId, tenantId, "ENTITY_VERSION", foreign);
  const m = inTenant(messages, (x) => x.id, (x) => x.tenantId, tenantId, "MESSAGE", foreign);
  const mv = inTenant(messageVersions, (v) => v.id, (v) => v.message.tenantId, tenantId, "MESSAGE_VERSION", foreign);
  const s = inTenant(eventSpecs, (x) => x.id, (x) => x.tenantId, tenantId, "EVENT_SPEC", foreign);
  const sv = inTenant(eventSpecVersions, (v) => v.id, (v) => v.eventSpec.tenantId, tenantId, "EVENT_SPEC_VERSION", foreign);
  const t = inTenant(traits, (x) => x.id, (x) => x.tenantId, tenantId, "TRAIT", foreign);

  const lookups: UsageLookups = {
    entityVersions: Object.fromEntries(ev.map((v) => [v.id, { label: formatVersionLabel(v), entity: { name: v.entity.name, slug: v.entity.slug, ...at(v.entity) } }])),
    messages: Object.fromEntries(m.map((x) => [x.id, { id: x.id, name: x.name, ...at(x) }])),
    messageVersions: Object.fromEntries(mv.map((v) => [v.id, { label: formatVersionLabel(v), message: { id: v.message.id, name: v.message.name, ...at(v.message) } }])),
    eventSpecs: Object.fromEntries(s.map((x) => [x.id, { id: x.id, name: x.name, ...at(x) }])),
    eventSpecVersions: Object.fromEntries(sv.map((v) => [v.id, { label: formatVersionLabel(v), eventSpec: { id: v.eventSpec.id, name: v.eventSpec.name, ...at(v.eventSpec) } }])),
    traits: Object.fromEntries(t.map((x) => [x.id, { id: x.id, name: x.name, ...at(x) }])),
  };
  const targetLabels = Object.fromEntries(targets.map((x) => [x.id, x.label]));
  return ok(refs.filter((r) => !foreign.has(`${r.fromKind}:${r.fromId}`)).map((r) => describeUsage(r, lookups, targetLabels)));
}
