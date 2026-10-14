import { prisma } from "@/lib/db";
import { NextResponse } from "next/server";
import { getActiveTenantId } from "@/lib/active-tenant";
import { buildExplorerTree } from "@/lib/navigation/build-explorer-tree";

export async function GET() {
  const tenantId = await getActiveTenantId();
  const levelSelect = { domainId: true, productId: true } as const;
  const [domains, products, entities, enums, scalars, unions, services] = await Promise.all([
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
  ]);
  return NextResponse.json(
    buildExplorerTree({ domains, products, entities, dataTypes: [...enums, ...scalars, ...unions], services })
  );
}
