import "dotenv/config"; // first: @/lib/db (pulled in by the route) reads DB_PROVIDER at import time
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ExplorerTree } from "@/lib/navigation/build-explorer-tree";
import { cleanupTenantTraits, connectTestDb, stamp, TENANT, testContext } from "../services/events/helpers";
import { createForeignTenant } from "../services/events/foreign-tenant";

const active = vi.hoisted(() => ({ tenantId: "" }));
vi.mock("@/lib/active-tenant", () => ({ getActiveTenantId: async () => active.tenantId }));

let prisma: PrismaClient;
beforeAll(() => {
  prisma = connectTestDb();
});
afterAll(async () => prisma.$disconnect());

async function fetchTree(tenantId: string): Promise<ExplorerTree> {
  const { GET } = await import("@/app/api/domains-tree/route");
  active.tenantId = tenantId;
  return (await (await GET()).json()) as ExplorerTree;
}

describe("GET /api/domains-tree — events counts", () => {
  it("aggregates traits per level and self-contained (v2) events per product, scoped to the active tenant", async () => {
    const ctx = await testContext(prisma);
    // The foreign tenant is a clean slate (one domain, product and entity), so every count is exact.
    const ft = await createForeignTenant(prisma, ctx);
    const defaultTenantTraitIds: string[] = [];
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
      // Two v2 events count; a legacy v1 (catalog-id) row is not an Event any more.
      await prisma.eventSpec.createMany({
        data: [
          { name: "checkout-events", document: { documentVersion: 2, info: { title: "x" } }, ...product },
          { name: "refund-events", document: { documentVersion: 2, info: { title: "y" } }, ...product },
          { name: "legacy-events", document: { info: { title: "x" }, servers: [], operations: [] }, ...product },
        ],
      });

      // Tenant-level rows all share one key ("no domain, no product"), so only they can leak across tenants.
      // The default tenant gets its own tenant-level trait; the foreign tenant's Enterprise count must not include it.
      const leaked = await prisma.trait.create({ data: { kind: "MESSAGE", name: `DefaultTenantTrait-${stamp()}`, tenantId: TENANT } });
      defaultTenantTraitIds.push(leaked.id);

      const tree = await fetchTree(ft.tenant.id);
      expect(tree.enterprise.counts.traits).toBe(2);
      expect(tree.domains).toHaveLength(1);
      expect(tree.domains[0].counts.traits).toBe(1);
      const counts = tree.domains[0].products[0].counts;
      expect(counts).toMatchObject({ traits: 1, events: 2 });
      // The old catalog kinds are gone from the tree.
      expect(Object.keys(counts).sort()).toEqual(["apis", "dataTypes", "entities", "events", "traits"]);

      // The other direction: the default tenant sees its own tenant-level trait, never the foreign tenant's rows.
      const defaultTree = await fetchTree(TENANT);
      expect(defaultTree.enterprise.counts.traits).toBeGreaterThanOrEqual(1);
      expect(defaultTree.domains.some((d) => d.id === ft.domain.id)).toBe(false);
    } finally {
      await cleanupTenantTraits(prisma, defaultTenantTraitIds);
      await ft.cleanup();
    }
  });
});
