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
