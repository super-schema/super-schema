import { prisma } from "@/lib/db";
import { NextResponse } from "next/server";
import { getActiveTenantId } from "@/lib/active-tenant";

export async function GET() {
  const [tenants, activeTenantId] = await Promise.all([
    prisma.tenant.findMany({
      where: { isActive: true },
      orderBy: [{ isSystem: "desc" }, { name: "asc" }],
      include: { _count: { select: { domains: true } } },
    }),
    getActiveTenantId(),
  ]);

  return NextResponse.json({
    activeTenantId,
    tenants: tenants.map((t) => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      description: t.description,
      isSystem: t.isSystem,
      domainCount: t._count.domains,
    })),
  });
}
