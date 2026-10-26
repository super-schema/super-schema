import { prisma } from "@/lib/db";
import { NextResponse } from "next/server";
import { APP_ERRORS, withApiAuth } from "@/lib/access/api";
import { canListDomain, canListProduct, readableScopes, type ActionId, type Assignment } from "@/lib/access";
import { buildExplorerTree } from "@/lib/navigation/build-explorer-tree";

type GroupedLevel = { domainId: string | null; productId: string | null; _count: { _all: number } };

/** `groupBy` rows → the level-tagged shape the tree builder counts (one row per level, with its count). */
const asLevelCounts = (rows: GroupedLevel[]) =>
  rows.map(({ domainId, productId, _count }) => ({ domainId, productId, count: _count._all }));

/**
 * The rows of a table the caller may read for `action`, as a `where` fragment: all of the tenant's (a tenant or platform role), or only those under
 * the domains and products their narrower roles cover. A role that is too low for the action contributes nothing, so a tenant-level row (no domain,
 * no product) is only ever shown to a tenant or platform role. The QUERY is restricted, not a page after it.
 */
function readableRows(assignments: readonly Assignment[], action: ActionId, tenantId: string): { OR?: Array<Record<string, unknown>> } {
  const scopes = readableScopes(assignments, action, tenantId);
  return scopes.all ? {} : { OR: [{ domainId: { in: scopes.domainIds } }, { productId: { in: scopes.productIds } }] };
}

/**
 * The explorer tree of the tenant being viewed, as far as the caller's roles reach: the domains and products they may list (a role at a product
 * shows its domain as a parent and that product only, never its siblings), and the entities, data types, APIs, traits and events counted under
 * them, each restricted by what the caller may read of that kind (`entity.read`, `asset.read`, `trait.read`, `event.read`). A user with no role in
 * the tenant is told 404, one with a role that reaches none of it 403. Answers to a session only.
 */
export const GET = withApiAuth(
  "domain.read",
  async (_request, api) => {
    const tenantId = api.tenantId as string; // content action: `withApiAuth` always resolves it
    const assignments = api.principal.assignments;
    const levelSelect = { domainId: true, productId: true } as const;
    const entityScope = readableRows(assignments, "entity.read", tenantId);
    const assetScope = readableRows(assignments, "asset.read", tenantId);
    const traitScope = readableRows(assignments, "trait.read", tenantId);
    const eventScope = readableRows(assignments, "event.read", tenantId);
    // Traits and events are only counted per level (never listed), so they are aggregated in the
    // database instead of loading every row.
    const levelGroup = (where: object) =>
      ({
        by: ["domainId", "productId"] as Array<"domainId" | "productId">,
        where: { tenantId, ...where },
        _count: { _all: true },
      }) as const;
    const [domains, products, entities, enums, scalars, unions, services, traits, events] = await Promise.all([
      prisma.domain.findMany({
        where: { tenantId },
        orderBy: [{ isSystem: "desc" }, { name: "asc" }],
        select: { id: true, name: true, slug: true, isSystem: true },
      }),
      prisma.product.findMany({
        where: { domain: { tenantId } },
        select: { id: true, domainId: true, name: true, slug: true, isSystem: true },
      }),
      prisma.entity.findMany({
        where: { tenantId, ...entityScope },
        orderBy: { name: "asc" },
        select: { id: true, name: true, slug: true, status: true, domainId: true, productId: true },
      }),
      prisma.sharedEnum.findMany({ where: { tenantId, ...assetScope }, select: levelSelect }),
      prisma.customScalar.findMany({ where: { tenantId, ...assetScope }, select: levelSelect }),
      prisma.unionType.findMany({ where: { tenantId, ...assetScope }, select: levelSelect }),
      prisma.serviceDefinition.findMany({ where: { tenantId, ...assetScope }, select: levelSelect }),
      prisma.trait.groupBy(levelGroup(traitScope)),
      prisma.eventSpec.groupBy(levelGroup(eventScope)),
    ]);
    // The structure itself: a domain is listed when a role covers it or one of its products, a product when a role covers it.
    const listedDomains = domains.filter((d) => canListDomain(assignments, { tenantId, domainId: d.id }));
    const listedProducts = products.filter((p) => p.domainId !== null && canListProduct(assignments, { tenantId, domainId: p.domainId, productId: p.id }));
    return NextResponse.json(
      buildExplorerTree({
        domains: listedDomains,
        products: listedProducts,
        entities,
        dataTypes: [...enums, ...scalars, ...unions],
        services,
        traits: asLevelCounts(traits),
        events: asLevelCounts(events),
      })
    );
  },
  { respond: APP_ERRORS, allowApiKey: false }
);
