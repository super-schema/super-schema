import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

let prisma: PrismaClient;
const TENANT = "tenant_default";

// Every table that gained a required tenantId in 20261013_add_asset_levels.
const LEVEL_TABLES = ["entities", "shared_enums", "custom_scalars", "union_types", "service_definitions"] as const;

beforeAll(async () => {
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
});
afterAll(async () => prisma.$disconnect());

describe("asset levels", () => {
  it("allows a tenant-level entity (no domain, no product)", async () => {
    const user = await prisma.user.findFirstOrThrow();
    let entityId: string | undefined;
    try {
      const e = await prisma.entity.create({
        data: { name: `TenantEnt${Date.now()}`, slug: `tenant-ent-${Date.now()}`, tenantId: TENANT, ownerId: user.id },
      });
      entityId = e.id;
      expect(e.domainId).toBeNull();
    } finally {
      if (entityId) await prisma.entity.deleteMany({ where: { id: entityId } });
    }
  });

  it("rejects an entity at domain level (CHECK)", async () => {
    const user = await prisma.user.findFirstOrThrow();
    let domainId: string | undefined;
    try {
      const d = await prisma.domain.create({ data: { name: `lvl-${Date.now()}`, slug: `lvl-${Date.now()}`, tenantId: TENANT } });
      domainId = d.id;
      await expect(
        prisma.entity.create({ data: { name: "X", slug: "x", tenantId: TENANT, domainId: d.id, ownerId: user.id } })
      ).rejects.toThrow(/entities_level_check/);
    } finally {
      // Cascades to any entity that slipped past the CHECK.
      if (domainId) await prisma.domain.deleteMany({ where: { id: domainId } });
    }
  });

  it("rejects a data type with productId but no domainId (CHECK)", async () => {
    let domainId: string | undefined;
    try {
      const d = await prisma.domain.create({ data: { name: `lvl2-${Date.now()}`, slug: `lvl2-${Date.now()}`, tenantId: TENANT } });
      domainId = d.id;
      const p = await prisma.product.create({ data: { domainId: d.id, name: "P", slug: `p-${Date.now()}` } });
      await expect(
        prisma.sharedEnum.create({ data: { name: "E", values: ["A"], tenantId: TENANT, productId: p.id } })
      ).rejects.toThrow(/shared_enums_level_check/);
    } finally {
      // Cascades to the product and to any enum that slipped past the CHECK.
      if (domainId) await prisma.domain.deleteMany({ where: { id: domainId } });
    }
  });

  it("backfilled tenantId on existing rows in every level table", async () => {
    for (const table of LEVEL_TABLES) {
      const missing = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT count(*)::bigint AS n FROM "${table}" WHERE "tenantId" IS NULL`
      );
      expect({ table, missing: Number(missing[0].n) }).toEqual({ table, missing: 0 });
    }
  });
});
