import type { PrismaClient } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import { cleanupDomains, stamp } from "./helpers";

/**
 * A second tenant with one domain / product / entity, for cross-tenant isolation tests.
 * `cleanup()` removes everything (edges, domain cascade, then the tenant); call it in `finally`.
 */
export async function createForeignTenant(prisma: PrismaClient, ctx: ServiceContext) {
  const s = stamp();
  const tenant = await prisma.tenant.create({ data: { name: `ft-${s}`, slug: `ft-${s}` } });
  let domainId: string | undefined;
  const cleanup = async () => {
    await cleanupDomains(prisma, [domainId]);
    await prisma.tenant.deleteMany({ where: { id: tenant.id } });
  };
  try {
    const domain = await prisma.domain.create({ data: { name: `ft-${s}`, slug: `ft-${s}`, tenantId: tenant.id } });
    domainId = domain.id;
    const product = await prisma.product.create({ data: { domainId: domain.id, name: `ft ${s}`, slug: `ft-p-${s}` } });
    const entity = await prisma.entity.create({
      data: {
        name: `Foreign${s}`, slug: `foreign-${s}`, tenantId: tenant.id, domainId: domain.id, productId: product.id,
        ownerId: ctx.userId, typespecSource: "model Foreign {\n  id: string;\n}\n",
      },
    });
    return { tenant, domain, product, entity, cleanup };
  } catch (e) {
    await cleanup();
    throw e;
  }
}
