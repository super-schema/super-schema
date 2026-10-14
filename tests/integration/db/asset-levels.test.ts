import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { readFileSync } from "node:fs";
import { join } from "node:path";

let prisma: PrismaClient;
const TENANT = "tenant_default";

// Every table that gained a required tenantId in 20261013_add_asset_levels.
const LEVEL_TABLES = ["entities", "shared_enums", "custom_scalars", "union_types", "service_definitions"] as const;

// The statement shipped in the backfill migration, re-run here to prove it fixes legacy rows.
const BACKFILL_SQL = readFileSync(
  join(process.cwd(), "prisma/migrations/20261014_backfill_entity_service_product/migration.sql"),
  "utf8"
)
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

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

  it("backfilled productId on entity-scoped services whose entity is product-level", async () => {
    // 20261014_backfill_entity_service_product: entity APIs live at their entity's product scope.
    const orphaned = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM "service_definitions" s
         JOIN "entities" e ON e."id" = s."entityId"
        WHERE s."scope" = 'ENTITY' AND s."productId" IS NULL AND e."productId" IS NOT NULL`
    );
    expect(Number(orphaned[0].n)).toBe(0);
  });

  it("places a freshly backfilled entity service at its entity's product", async () => {
    // Re-running the backfill statement is a no-op on correct rows and fixes legacy ones.
    const user = await prisma.user.findFirstOrThrow();
    let domainId: string | undefined;
    try {
      const d = await prisma.domain.create({ data: { name: `lvl3-${Date.now()}`, slug: `lvl3-${Date.now()}`, tenantId: TENANT } });
      domainId = d.id;
      const p = await prisma.product.create({ data: { domainId: d.id, name: "P", slug: `p-${Date.now()}` } });
      const e = await prisma.entity.create({
        data: { name: "E", slug: `e-${Date.now()}`, tenantId: TENANT, domainId: d.id, productId: p.id, ownerId: user.id },
      });
      // A legacy row: entity-scoped, placed at domain level (productId NULL).
      const svc = await prisma.serviceDefinition.create({
        data: { name: "LegacyApi", tenantId: TENANT, domainId: d.id, scope: "ENTITY", entityId: e.id },
      });
      expect(svc.productId).toBeNull();

      await prisma.$executeRawUnsafe(BACKFILL_SQL);

      const after = await prisma.serviceDefinition.findUniqueOrThrow({ where: { id: svc.id } });
      expect(after.productId).toBe(p.id);
    } finally {
      // Cascades to the product, its entities and their services.
      if (domainId) await prisma.domain.deleteMany({ where: { id: domainId } });
    }
  });
});
