import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { createDomain } from "@/services/domain.service";
import {
  createEntity,
  getEntityById,
  updateEntity,
  deleteEntity,
} from "@/services/entity.service";
import type { ServiceContext } from "@/types/service-context";

let prisma: PrismaClient;
let ctx: ServiceContext;
let testDomainId: string;
let testUserId: string;

beforeAll(async () => {
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL!,
  });
  prisma = new PrismaClient({ adapter });

  // Get or create a test user
  const user = await prisma.user.findFirst();
  if (!user) throw new Error("No user found — register a user first");
  testUserId = user.id;

  ctx = {
    userId: testUserId,
    userRole: "AUTHOR",
    prisma,
  };
});

afterAll(async () => {
  // Clean up test domain (cascades to entities)
  if (testDomainId) {
    await prisma.domain.delete({ where: { id: testDomainId } }).catch(() => {});
  }
  await prisma.$disconnect();
});

describe("Entity Lifecycle Integration", () => {
  it("full lifecycle: create domain -> create entity -> read -> update -> delete", async () => {
    // 1. Create domain
    const domainResult = await createDomain(
      { name: `lifecycle-test-${Date.now()}`, description: "Integration test domain" },
      ctx
    );
    expect(domainResult.success).toBe(true);
    if (!domainResult.success) throw new Error("Domain creation failed");
    testDomainId = domainResult.data.id;

    // 2. Create entity
    const createResult = await createEntity(
      {
        name: "Customer",
        domainId: testDomainId,
        description: "Customer entity",
      },
      ctx
    );
    expect(createResult.success).toBe(true);
    if (!createResult.success) throw new Error("Entity creation failed");
    const entityId = createResult.data.id;
    expect(createResult.data.name).toBe("Customer");
    expect(createResult.data.status).toBe("DRAFT");

    // 3. Read entity
    const readResult = await getEntityById(entityId, ctx);
    expect(readResult.success).toBe(true);
    if (readResult.success) {
      expect(readResult.data.name).toBe("Customer");
    }

    // 4. Update entity
    const updateResult = await updateEntity(
      entityId,
      { description: "Updated description", status: "ACTIVE" },
      ctx
    );
    expect(updateResult.success).toBe(true);
    if (updateResult.success) {
      expect(updateResult.data.description).toBe("Updated description");
    }

    // 5. Delete entity
    const deleteResult = await deleteEntity(entityId, ctx);
    expect(deleteResult.success).toBe(true);

    // 6. Verify deleted
    const deletedResult = await getEntityById(entityId, ctx);
    expect(deletedResult.success).toBe(false);
  });

  it("audit_log contains entries for write operations", async () => {
    const domainResult = await createDomain(
      { name: `audit-test-${Date.now()}`, description: "Audit test" },
      ctx
    );
    if (!domainResult.success) throw new Error("Domain creation failed");
    const domId = domainResult.data.id;

    const entityResult = await createEntity(
      { name: "AuditTestEntity", domainId: domId, description: "Test" },
      ctx
    );
    if (!entityResult.success) throw new Error("Entity creation failed");

    // Check audit log has CREATE entries
    const auditLogs = await prisma.auditLog.findMany({
      where: {
        entityType: { in: ["Domain", "Entity"] },
        userId: testUserId,
        action: "CREATE",
      },
      orderBy: { timestamp: "desc" },
      take: 5,
    });

    expect(auditLogs.length).toBeGreaterThanOrEqual(2);

    // Clean up
    await prisma.domain.delete({ where: { id: domId } });
  });
});
