import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { assertNameAvailable, withTenantNameLock } from "@/services/name-registry.service";

let prisma: PrismaClient;
const TENANT = "tenant_default";

beforeAll(async () => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL not set");
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  await prisma.tenant.upsert({
    where: { id: TENANT },
    update: {},
    create: { id: TENANT, name: "Default Tenant", slug: "default", isSystem: true },
  });
});
afterAll(async () => prisma.$disconnect());

describe("name registry (db)", () => {
  it("only one of two concurrent same-name creates succeeds", async () => {
    const stamp = Date.now();
    const domain = await prisma.domain.create({ data: { name: `nr-${stamp}`, slug: `nr-${stamp}`, tenantId: TENANT } });
    try {
      const name = `Race${stamp}`;
      const attempt = () =>
        withTenantNameLock(prisma, TENANT, async (tx) => {
          const free = await assertNameAvailable(tx, { name, tenantId: TENANT, domainId: domain.id, productId: null });
          if (!free.success) return "conflict";
          await tx.sharedEnum.create({ data: { name, values: ["A"], tenantId: TENANT, domainId: domain.id } });
          return "created";
        });
      const results = await Promise.all([attempt(), attempt()]);
      expect(results.sort()).toEqual(["conflict", "created"]);
    } finally {
      // Always clean up so a failing assertion never leaves rows in the shared dev DB.
      await prisma.sharedEnum.deleteMany({ where: { domainId: domain.id } });
      await prisma.domain.delete({ where: { id: domain.id } });
    }
  });
});
