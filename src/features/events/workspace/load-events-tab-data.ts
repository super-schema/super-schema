// src/features/events/workspace/load-events-tab-data.ts
import { prisma } from "@/lib/db";
import type { LevelScope } from "@/lib/levels";
import { assetHref } from "@/lib/navigation/asset-href";
import { traitListItem } from "@/lib/events/list-items";
import { traitListMeta } from "./trait-list-meta";
import type { TraitGroup, TraitTabItem, TraitsTabData } from "./types";

/**
 * Server loader for the Domain / Enterprise "Traits" workspace tab (library traits). The by-id service reads are unscoped by
 * design, so every list here filters by the tenant AND the level's own columns inside the query itself; the caller passes the
 * tenant of the route's domain, never an id taken from the client. (Products have no Events tab data to load here any more: their
 * events come from `loadEventsList` and a product has no traits of its own.)
 */

const TRAIT_SELECT = { id: true, name: true, kind: true, spec: true, updatedAt: true } as const;

type TraitRow = { id: string; name: string; kind: string; spec: unknown; updatedAt: Date };

function linkTraits(rows: TraitRow[], domainSlug: string | null): TraitTabItem[] {
  return rows.map((t) => ({ ...traitListItem(t), ...traitListMeta(t.spec), href: assetHref({ kind: "trait", id: t.id, domainSlug }) }));
}

const nonEmpty = (groups: TraitGroup[]) => groups.filter((g) => g.traits.length > 0);

const tenantTraits = (tenantId: string) => ({ tenantId, domainId: null, productId: null });
const domainTraits = (tenantId: string, domainId: string) => ({ tenantId, domainId, productId: null });

/**
 * Traits of a domain (`scope.domainId` set) or of the Enterprise; a domain also shows the Enterprise traits
 * read-only. `scope.productId` is not read here.
 */
export async function loadLevelTraits(args: { scope: LevelScope; domainSlug: string | null }): Promise<TraitsTabData> {
  const { scope, domainSlug } = args;
  if (!scope.domainId) {
    const own = await prisma.trait.findMany({ where: tenantTraits(scope.tenantId), orderBy: { name: "asc" }, select: TRAIT_SELECT });
    return { own: linkTraits(own, null), inherited: [] };
  }
  const [own, fromTenant] = await Promise.all([
    prisma.trait.findMany({ where: domainTraits(scope.tenantId, scope.domainId), orderBy: { name: "asc" }, select: TRAIT_SELECT }),
    prisma.trait.findMany({ where: tenantTraits(scope.tenantId), orderBy: { name: "asc" }, select: TRAIT_SELECT }),
  ]);
  return {
    own: linkTraits(own, domainSlug),
    inherited: nonEmpty([
      { label: "From Enterprise", href: assetHref({ kind: "traits", domainSlug: null, productSlug: null }), traits: linkTraits(fromTenant, null) },
    ]),
  };
}
