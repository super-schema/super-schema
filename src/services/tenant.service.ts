import { prisma } from "@/lib/db";
import { ok } from "@/types/result";
import type { Result } from "@/types/result";
import type { Tenant } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";

export interface TenantListItem {
  id: string;
  name: string;
  slug: string;
  description: string;
  isSystem: boolean;
  domainCount: number;
}

export async function getTenants(
  ctx: ServiceContext
): Promise<Result<TenantListItem[]>> {
  const tenants = await ctx.prisma.tenant.findMany({
    where: { isActive: true },
    orderBy: [{ isSystem: "desc" }, { name: "asc" }],
    include: { _count: { select: { domains: true } } },
  });

  return ok(
    tenants.map((t) => ({
      id: t.id,
      name: t.name,
      slug: t.slug,
      description: t.description,
      isSystem: t.isSystem,
      domainCount: t._count.domains,
    }))
  );
}

export async function getTenantById(
  id: string,
  ctx: ServiceContext
): Promise<Result<Tenant | null>> {
  const tenant = await ctx.prisma.tenant.findUnique({ where: { id } });
  return ok(tenant);
}
