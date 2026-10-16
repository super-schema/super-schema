import { prisma } from "@/lib/db";
import { NextResponse } from "next/server";
import { getActiveTenantId } from "@/lib/active-tenant";
import { buildExplorerTree } from "@/lib/navigation/build-explorer-tree";

type GroupedLevel = { domainId: string | null; productId: string | null; _count: { _all: number } };

/** `groupBy` rows → the level-tagged shape the tree builder counts (one row per level, with its count). */
const asLevelCounts = (rows: GroupedLevel[]) =>
  rows.map(({ domainId, productId, _count }) => ({ domainId, productId, count: _count._all }));

export async function GET() {
  const tenantId = await getActiveTenantId();
  const levelSelect = { domainId: true, productId: true } as const;
  // Traits and events are only counted per level (never listed), so they are aggregated in the
  // database instead of loading every row.
  const levelGroup = {
    by: ["domainId", "productId"] as Array<"domainId" | "productId">,
    where: { tenantId },
    _count: { _all: true },
  } as const;
  // Only self-contained events (document v2) are Events now; a stored legacy v1 row is not listed by the Events page, so it is not counted.
  const eventGroup = { ...levelGroup, where: { tenantId, document: { path: ["documentVersion"], equals: 2 } } };
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
      where: { tenantId },
      orderBy: { name: "asc" },
      select: { id: true, name: true, slug: true, status: true, domainId: true, productId: true },
    }),
    prisma.sharedEnum.findMany({ where: { tenantId }, select: levelSelect }),
    prisma.customScalar.findMany({ where: { tenantId }, select: levelSelect }),
    prisma.unionType.findMany({ where: { tenantId }, select: levelSelect }),
    prisma.serviceDefinition.findMany({ where: { tenantId }, select: levelSelect }),
    prisma.trait.groupBy(levelGroup),
    prisma.eventSpec.groupBy(eventGroup),
  ]);
  return NextResponse.json(
    buildExplorerTree({
      domains,
      products,
      entities,
      dataTypes: [...enums, ...scalars, ...unions],
      services,
      traits: asLevelCounts(traits),
      events: asLevelCounts(events),
    })
  );
}
