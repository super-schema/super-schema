import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

let prisma: PrismaClient;
const TENANT = "tenant_default";

beforeAll(async () => {
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
});
afterAll(async () => prisma.$disconnect());

describe("asset levels", () => {
  it("allows a tenant-level entity (no domain, no product)", async () => {
    const user = await prisma.user.findFirstOrThrow();
    const e = await prisma.entity.create({
      data: { name: `TenantEnt${Date.now()}`, slug: `tenant-ent-${Date.now()}`, tenantId: TENANT, ownerId: user.id },
    });
    expect(e.domainId).toBeNull();
    await prisma.entity.delete({ where: { id: e.id } });
  });

  it("rejects an entity at domain level (CHECK)", async () => {
    const user = await prisma.user.findFirstOrThrow();
    const d = await prisma.domain.create({ data: { name: `lvl-${Date.now()}`, slug: `lvl-${Date.now()}`, tenantId: TENANT } });
    await expect(
      prisma.entity.create({ data: { name: "X", slug: "x", tenantId: TENANT, domainId: d.id, ownerId: user.id } })
    ).rejects.toThrow(/entities_level_check/);
    await prisma.domain.delete({ where: { id: d.id } });
  });

  it("rejects a data type with productId but no domainId (CHECK)", async () => {
    const d = await prisma.domain.create({ data: { name: `lvl2-${Date.now()}`, slug: `lvl2-${Date.now()}`, tenantId: TENANT } });
    const p = await prisma.product.create({ data: { domainId: d.id, name: "P", slug: `p-${Date.now()}` } });
    await expect(
      prisma.sharedEnum.create({ data: { name: "E", values: ["A"], tenantId: TENANT, productId: p.id } })
    ).rejects.toThrow(/shared_enums_level_check/);
    await prisma.domain.delete({ where: { id: d.id } });
  });

  it("backfilled tenantId on existing rows", async () => {
    const missing = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*)::bigint AS n FROM "entities" WHERE "tenantId" IS NULL`;
    expect(Number(missing[0].n)).toBe(0);
  });
});
