import "dotenv/config"; // first: @/lib/db (pulled in by the route) reads DB_PROVIDER at import time
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ExplorerTree } from "@/lib/navigation/build-explorer-tree";
import { connectTestDb, testContext } from "../services/events/helpers";
import { createForeignTenant } from "../services/events/foreign-tenant";

const active = vi.hoisted(() => ({ tenantId: "" }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: async () => active.tenantId }));

let prisma: PrismaClient;
beforeAll(() => {
  prisma = connectTestDb();
});
afterAll(async () => prisma.$disconnect());

describe("GET /api/domains-tree — events counts", () => {
  it("aggregates traits per level and messages / channels / event specs per product, scoped to the active tenant", async () => {
    const { GET } = await import("@/app/api/domains-tree/route");
    const ctx = await testContext(prisma);
    // The foreign tenant is a clean slate (one domain, product, entity and message) and also proves tenant scoping.
    const ft = await createForeignTenant(prisma, ctx);
    try {
      const level = { tenantId: ft.tenant.id };
      const product = { ...level, domainId: ft.domain.id, productId: ft.product.id };
      await prisma.trait.createMany({
        data: [
          { kind: "MESSAGE", name: "TenantTrait", ...level },
          { kind: "MESSAGE", name: "TenantTrait2", ...level },
          { kind: "OPERATION", name: "DomainTrait", ...level, domainId: ft.domain.id },
          { kind: "OPERATION", name: "ProductTrait", ...product },
        ],
      });
      await prisma.channel.createMany({
        data: [
          { name: "orders", protocol: "kafka", format: "avro", ...product },
          { name: "refunds", protocol: "kafka", format: "avro", ...product },
        ],
      });
      await prisma.eventSpec.create({ data: { name: "checkout-events", document: { info: { title: "x" }, servers: [], operations: [] }, ...product } });

      // Another tenant's rows (the default tenant's) must not leak into the counts.
      active.tenantId = ft.tenant.id;
      const tree = (await (await GET()).json()) as ExplorerTree;

      expect(tree.enterprise.counts.traits).toBe(2);
      expect(tree.domains).toHaveLength(1);
      expect(tree.domains[0].counts.traits).toBe(1);
      expect(tree.domains[0].products[0].counts).toMatchObject({ traits: 1, messages: 1, channels: 2, eventSpecs: 1 });
    } finally {
      await ft.cleanup();
    }
  });
});
