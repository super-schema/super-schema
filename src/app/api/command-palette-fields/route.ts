import { prisma } from "@/lib/db";
import { NextResponse } from "next/server";
import { getActiveTenantId } from "@/lib/active-tenant";
import { requireSession } from "@/lib/require-session";

export async function GET() {
  // A session only. The root middleware (src/middleware.ts) reads the Cookie header and nothing else, so a caller with only an
  // `Authorization: Bearer <API key>` never reaches this handler (it gets 401 there): an API-key branch here could never run.
  const denied = await requireSession();
  if (denied) return denied;

  try {
    // The fields of the tenant being viewed (the `active_tenant` cookie).
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
