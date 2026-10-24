import { prisma } from "@/lib/db";
import { NextResponse } from "next/server";
import { getActiveTenantId } from "@/lib/active-tenant";
import { authenticateRequest } from "../v1/middleware";

export async function GET(request: Request) {
  const authResult = await authenticateRequest(request);
  if (!authResult.authenticated) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  try {
    // The fields of the tenant being viewed (the `active_tenant` cookie; a caller with an API key has none, so it gets the default tenant,
    // like every other route that asks).
    const tenantId = await getActiveTenantId();
    const fields = await prisma.field.findMany({
      where: { entity: { tenantId } },
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
        // null for a tenant-level entity; the client builds links with assetHref.
        domainSlug: f.entity.domain?.slug ?? null,
        productSlug: f.entity.product?.slug ?? null,
      }))
    );
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch fields" },
      { status: 500 }
    );
  }
}
