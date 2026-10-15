// src/features/events/workspace/load-events-tab-data.ts
import { prisma } from "@/lib/db";
import type { LevelScope } from "@/lib/levels";
import { assetHref } from "@/lib/navigation/asset-href";
import { channelListItem, eventSpecListItem, messageListItem, traitListItem } from "@/lib/events/list-items";
import type { Linked, TraitListItem } from "@/lib/events/types";
import { findEventSpecsWithCatalogDrift } from "@/services/events/event-spec.service";
import { loadEntityOptions } from "@/features/events/load-options";
import type { EventsTabData, TraitGroup, TraitsTabData } from "./types";

/**
 * Server loaders for the Events / Traits workspace tabs. The by-id service reads are unscoped by design,
 * so every list here filters by the tenant AND the level's own columns inside the query itself; the
 * caller passes the tenant of the route's domain, never an id taken from the client.
 */

const TRAIT_SELECT = { id: true, name: true, kind: true, spec: true, updatedAt: true } as const;
const VERSION = { select: { major: true, minor: true } } as const;

type TraitRow = { id: string; name: string; kind: string; spec: unknown; updatedAt: Date };

function linkTraits(rows: TraitRow[], domainSlug: string | null, productSlug: string | null): Linked<TraitListItem>[] {
  return rows.map((t) => ({ ...traitListItem(t), href: assetHref({ kind: "trait", id: t.id, domainSlug, productSlug }) }));
}

const nonEmpty = (groups: TraitGroup[]) => groups.filter((g) => g.traits.length > 0);

const tenantTraits = (tenantId: string) => ({ tenantId, domainId: null, productId: null });
const domainTraits = (tenantId: string, domainId: string) => ({ tenantId, domainId, productId: null });

export async function loadProductEventsData(args: {
  tenantId: string;
  domainId: string;
  productId: string;
  domainSlug: string;
  productSlug: string;
}): Promise<{ events: EventsTabData; traits: TraitsTabData }> {
  const { tenantId, domainId, productId, domainSlug, productSlug } = args;
  const own = { tenantId, domainId, productId };
  const [specs, messages, channels, payloadEntities, ownTraits, fromDomain, fromTenant] = await Promise.all([
    prisma.eventSpec.findMany({
      where: own,
      orderBy: { name: "asc" },
      select: { id: true, name: true, document: true, hasUnpublishedChanges: true, updatedAt: true, latestVersion: VERSION },
    }),
    prisma.message.findMany({
      where: own,
      orderBy: { name: "asc" },
      select: { id: true, name: true, spec: true, hasUnpublishedChanges: true, updatedAt: true, latestVersion: VERSION, payloadEntity: { select: { name: true } } },
    }),
    prisma.channel.findMany({
      where: own,
      orderBy: { name: "asc" },
      select: { id: true, name: true, address: true, protocol: true, format: true, spec: true, updatedAt: true },
    }),
    loadEntityOptions(tenantId),
    prisma.trait.findMany({ where: own, orderBy: { name: "asc" }, select: TRAIT_SELECT }),
    prisma.trait.findMany({ where: domainTraits(tenantId, domainId), orderBy: { name: "asc" }, select: TRAIT_SELECT }),
    prisma.trait.findMany({ where: tenantTraits(tenantId), orderBy: { name: "asc" }, select: TRAIT_SELECT }),
  ]);
  // D8: a published spec whose live Channel / Trait differs from its frozen copy has unpublished changes too (R78) — the stored
  // flag never sees it. Frozen copies vs live rows only (three batched queries, no rendering / emitter).
  const unflagged = specs.filter((s) => s.latestVersion && !s.hasUnpublishedChanges).map((s) => s.id);
  const drifted = await findEventSpecsWithCatalogDrift(prisma, tenantId, unflagged);
  const at = { domainSlug, productSlug };
  return {
    events: {
      eventSpecs: specs.map((s) => ({ ...eventSpecListItem({ ...s, hasUnpublishedChanges: s.hasUnpublishedChanges || drifted.has(s.id) }), href: assetHref({ kind: "eventSpec", id: s.id, ...at }) })),
      messages: messages.map((m) => ({ ...messageListItem(m), href: assetHref({ kind: "message", id: m.id, ...at }) })),
      channels: channels.map((c) => ({ ...channelListItem(c), href: assetHref({ kind: "channel", id: c.id, ...at }) })),
      payloadEntities,
    },
    traits: {
      own: linkTraits(ownTraits, domainSlug, productSlug),
      inherited: nonEmpty([
        { label: "From Domain", href: assetHref({ kind: "traits", domainSlug, productSlug: null }), traits: linkTraits(fromDomain, domainSlug, null) },
        { label: "From Enterprise", href: assetHref({ kind: "traits", domainSlug: null, productSlug: null }), traits: linkTraits(fromTenant, null, null) },
      ]),
    },
  };
}

/**
 * Traits of a domain (`scope.domainId` set) or of the Enterprise; a domain also shows the Enterprise traits
 * read-only. Product traits come from `loadProductEventsData` — `scope.productId` is not read here.
 */
export async function loadLevelTraits(args: { scope: LevelScope; domainSlug: string | null }): Promise<TraitsTabData> {
  const { scope, domainSlug } = args;
  if (!scope.domainId) {
    const own = await prisma.trait.findMany({ where: tenantTraits(scope.tenantId), orderBy: { name: "asc" }, select: TRAIT_SELECT });
    return { own: linkTraits(own, null, null), inherited: [] };
  }
  const [own, fromTenant] = await Promise.all([
    prisma.trait.findMany({ where: domainTraits(scope.tenantId, scope.domainId), orderBy: { name: "asc" }, select: TRAIT_SELECT }),
    prisma.trait.findMany({ where: tenantTraits(scope.tenantId), orderBy: { name: "asc" }, select: TRAIT_SELECT }),
  ]);
  return {
    own: linkTraits(own, domainSlug, null),
    inherited: nonEmpty([
      { label: "From Enterprise", href: assetHref({ kind: "traits", domainSlug: null, productSlug: null }), traits: linkTraits(fromTenant, null, null) },
    ]),
  };
}
