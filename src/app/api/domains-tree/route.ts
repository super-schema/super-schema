import { prisma } from "@/lib/db";
import { NextResponse } from "next/server";

export async function GET() {
  const domains = await prisma.domain.findMany({
    orderBy: [{ isSystem: "desc" }, { name: "asc" }],
    include: {
      entities: {
        select: { id: true, name: true, slug: true, status: true },
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
      entities: d.entities,
      modelCount: d._count.modelDefinitions,
      decoratorCount: d._count.decoratorDefinitions,
      sharedEnumCount: d._count.sharedEnums,
      customScalarCount: d._count.customScalars,
      unionTypeCount: d._count.unionTypes,
      serviceCount: d._count.services,
    }))
  );
}
