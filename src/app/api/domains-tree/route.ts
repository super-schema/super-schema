import { prisma } from "@/lib/db";
import { NextResponse } from "next/server";
import { authenticateRequest } from "../v1/middleware";

export async function GET(request: Request) {
  const authResult = await authenticateRequest(request);
  if (!authResult.authenticated) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const domains = await prisma.domain.findMany({
    orderBy: [{ isSystem: "desc" }, { name: "asc" }],
    include: {
      entities: {
        select: { id: true, name: true, slug: true, status: true },
        orderBy: { name: "asc" },
      },
      _count: {
        select: {
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
      sharedEnumCount: d._count.sharedEnums,
      customScalarCount: d._count.customScalars,
      unionTypeCount: d._count.unionTypes,
      serviceCount: d._count.services,
    }))
  );
}
