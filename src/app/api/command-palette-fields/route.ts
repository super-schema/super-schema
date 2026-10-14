import { prisma } from "@/lib/db";
import { NextResponse } from "next/server";
import { authenticateRequest } from "../v1/middleware";
import { domainSegment, productSegment } from "@/lib/entity-placement";

export async function GET(request: Request) {
  const authResult = await authenticateRequest(request);
  if (!authResult.authenticated) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  try {
    const fields = await prisma.field.findMany({
      select: {
        id: true,
        slug: true,
        name: true,
        type: true,
        entity: {
          select: {
            id: true,
            name: true,
            slug: true,
            product: { select: { slug: true } },
            domain: {
              select: { name: true, slug: true },
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
        slug: f.slug,
        name: f.name,
        type: f.type,
        entityId: f.entity.id,
        entitySlug: f.entity.slug,
        entityName: f.entity.name,
        domainSlug: domainSegment(f.entity.domain),
        productSlug: productSegment(f.entity.product),
      }))
    );
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch fields" },
      { status: 500 }
    );
  }
}
