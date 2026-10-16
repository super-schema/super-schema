import type { PrismaClient } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import { cleanupDomains, stamp } from "./helpers";

/**
 * A second tenant with one product and one of everything an events service could be tricked into referencing
 * across the tenant boundary: a published entity version and a MESSAGE trait.
 * Rows are written directly (no publish audit rows); `cleanup()` removes the whole tenant.
 *
 * If building the fixture fails part-way, the half-built tenant is removed before the error is rethrown, so
 * callers can create it inside their `try` and only need `foreign?.cleanup()` in `finally`.
 */
export async function createForeignTenantFixture(prisma: PrismaClient, ctx: ServiceContext) {
  const s = stamp();
  const tenant = await prisma.tenant.create({ data: { name: `ft-${s}`, slug: `ft-${s}` } });
  const level = { tenantId: tenant.id } as const;

  async function cleanup() {
    const domains = await prisma.domain.findMany({ where: level, select: { id: true } });
    await cleanupDomains(prisma, domains.map((d) => d.id));
    await prisma.trait.deleteMany({ where: level });
    await prisma.tenant.delete({ where: { id: tenant.id } });
  }

  try {
    const domain = await prisma.domain.create({ data: { name: `ft-${s}`, slug: `ft-${s}`, ...level } });
    const product = await prisma.product.create({ data: { domainId: domain.id, name: `ft ${s}`, slug: `ft-p-${s}` } });
    const placed = { ...level, domainId: domain.id, productId: product.id };

    const entity = await prisma.entity.create({
      data: {
        name: "Foreign", slug: `foreign-${s}`, ...placed, ownerId: ctx.userId,
        typespecSource: "model Foreign {\n  id: string;\n}\n",
        fields: { create: [{ name: "id", slug: "id", type: "string", nullable: false, sortOrder: 0, fieldNumber: 1, decorators: {} }] },
      },
    });
    const version = await prisma.entityVersion.create({
      data: {
        entityId: entity.id, major: 1, minor: 0, sequence: 1, resolvedSource: entity.typespecSource ?? "", fieldSnapshot: [],
        changeKind: "INITIAL", publishedById: ctx.userId,
      },
    });
    await prisma.entity.update({ where: { id: entity.id }, data: { latestVersionId: version.id } });
    const trait = await prisma.trait.create({ data: { name: `ftrait-${s}`, kind: "MESSAGE", ...level } });

    return { s, tenant, domain, product, entity, version, trait, cleanup };
  } catch (e: unknown) {
    await cleanup().catch(() => undefined);
    throw e;
  }
}
