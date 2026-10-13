import { prisma } from "@/lib/db";
import { NextResponse } from "next/server";
import { getActiveTenantId } from "@/lib/active-tenant";

export async function GET() {
  const tenantId = await getActiveTenantId();
  const domains = await prisma.domain.findMany({
    where: { tenantId },
    orderBy: [{ isSystem: "desc" }, { name: "asc" }],
    include: {
      entities: {
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          product: { select: { slug: true } },
        },
        orderBy: { name: "asc" },
      },
      _count: {
        select: {
          modelDefinitions: true,
          decoratorDefinitions: true,
          sharedEnums: true,
          customScalars: true,
          unionTypes: true,
          services: true,
        },
      },
    },
  });

  return NextResponse.json(
    domains.map((d) => ({
      id: d.id,
      name: d.name,
      slug: d.slug,
      isSystem: d.isSystem,
      entities: d.entities.map((e) => ({
        id: e.id,
        name: e.name,
        slug: e.slug,
        status: e.status,
        productSlug: e.product?.slug ?? "default",
      })),
      modelCount: d._count.modelDefinitions,
      decoratorCount: d._count.decoratorDefinitions,
      sharedEnumCount: d._count.sharedEnums,
      customScalarCount: d._count.customScalars,
      unionTypeCount: d._count.unionTypes,
      serviceCount: d._count.services,
    }))
  );
}
