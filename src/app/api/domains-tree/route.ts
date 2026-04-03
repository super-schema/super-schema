import { prisma } from "@/lib/db";
import { NextResponse } from "next/server";

export async function GET() {
  const domains = await prisma.domain.findMany({
    orderBy: [{ isSystem: "desc" }, { name: "asc" }],
    include: {
      entities: {
        select: { id: true, name: true, status: true },
        orderBy: { name: "asc" },
      },
    },
  });

  return NextResponse.json(
    domains.map((d) => ({
      id: d.id,
      name: d.name,
      isSystem: d.isSystem,
      entities: d.entities,
    }))
  );
}
