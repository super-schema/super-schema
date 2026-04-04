import { prisma } from "@/lib/db";
import { NextResponse } from "next/server";
import { toSlug } from "@/lib/domain-utils";

export async function GET() {
  try {
    const fields = await prisma.field.findMany({
      select: {
        id: true,
        name: true,
        type: true,
        entity: {
          select: {
            id: true,
            name: true,
            domain: {
              select: { name: true },
            },
          },
        },
      },
      orderBy: [{ entity: { name: "asc" } }, { name: "asc" }],
      take: 100, // Limit for performance
    });

    return NextResponse.json(
      fields.map((f) => ({
        id: f.id,
        name: f.name,
        type: f.type,
        entityId: f.entity.id,
        entityName: f.entity.name,
        domainSlug: toSlug(f.entity.domain.name),
      }))
    );
  } catch {
    return NextResponse.json([], { status: 200 });
  }
}
