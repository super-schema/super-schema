import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

let prisma: PrismaClient;

beforeAll(async () => {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL not set");
  const adapter = new PrismaPg({ connectionString });
  prisma = new PrismaClient({ adapter });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("Database Schema", () => {
  it("domains table exists and supports CRUD", async () => {
    const domain = await prisma.domain.create({
      data: { name: `test-domain-${Date.now()}`, slug: `test-domain-${Date.now()}`, description: "Test domain" },
    });
    expect(domain.id).toBeDefined();
    expect(domain.name).toContain("test-domain-");

    await prisma.domain.delete({ where: { id: domain.id } });
  });

  it("entities table exists with unique constraint on (name, domainId)", async () => {
    const domain = await prisma.domain.create({
      data: { name: `ent-test-${Date.now()}`, slug: `ent-test-${Date.now()}`, description: "Test" },
    });
    const user = await prisma.user.findFirst();
    if (!user) throw new Error("No user found — register a user first");

    const entity = await prisma.entity.create({
      data: {
        name: "Customer",
        slug: "customer",
        domainId: domain.id,
        ownerId: user.id,
        description: "Customer entity",
      },
    });
    expect(entity.version).toBe(1);
    expect(entity.status).toBe("DRAFT");

    // Duplicate name in same domain should fail
    await expect(
      prisma.entity.create({
        data: {
          name: "Customer",
          slug: "customer",
          domainId: domain.id,
          ownerId: user.id,
        },
      })
    ).rejects.toThrow();

    await prisma.entity.delete({ where: { id: entity.id } });
    await prisma.domain.delete({ where: { id: domain.id } });
  });

  it("fields table exists with unique constraint on (entityId, name)", async () => {
    const domain = await prisma.domain.create({
      data: { name: `field-test-${Date.now()}`, slug: `field-test-${Date.now()}`, description: "Test" },
    });
    const user = await prisma.user.findFirst();
    if (!user) throw new Error("No user found");

    const entity = await prisma.entity.create({
      data: {
        name: "Order",
        slug: "order",
        domainId: domain.id,
        ownerId: user.id,
      },
    });

    const field = await prisma.field.create({
      data: {
        entityId: entity.id,
        name: "order_id",
        type: "string",
        sortOrder: 0,
        isKey: true,
      },
    });
    expect(field.nullable).toBe(true);
    expect(field.isKey).toBe(true);

    // Duplicate field name in same entity should fail
    await expect(
      prisma.field.create({
        data: {
          entityId: entity.id,
          name: "order_id",
          type: "integer",
          sortOrder: 1,
        },
      })
    ).rejects.toThrow();

    await prisma.field.delete({ where: { id: field.id } });
    await prisma.entity.delete({ where: { id: entity.id } });
    await prisma.domain.delete({ where: { id: domain.id } });
  });

  it("cascade delete: deleting domain deletes its entities and fields", async () => {
    const domain = await prisma.domain.create({
      data: { name: `cascade-test-${Date.now()}`, slug: `cascade-test-${Date.now()}`, description: "Test" },
    });
    const user = await prisma.user.findFirst();
    if (!user) throw new Error("No user found");

    const entity = await prisma.entity.create({
      data: {
        name: "Product",
        slug: "product",
        domainId: domain.id,
        ownerId: user.id,
      },
    });

    await prisma.field.create({
      data: {
        entityId: entity.id,
        name: "product_name",
        type: "string",
        sortOrder: 0,
      },
    });

    // Delete domain — should cascade
    await prisma.domain.delete({ where: { id: domain.id } });

    const deletedEntity = await prisma.entity.findUnique({
      where: { id: entity.id },
    });
    expect(deletedEntity).toBeNull();
  });
});

describe("Audit Log Trigger", () => {
  it("allows INSERT on audit_log", async () => {
    const user = await prisma.user.findFirst();
    if (!user) throw new Error("No user found");

    const log = await prisma.auditLog.create({
      data: {
        action: "TEST",
        entityType: "test",
        entityId: "test-id",
        userId: user.id,
        afterState: { test: true },
      },
    });
    expect(log.id).toBeDefined();

    // Clean up using raw SQL to bypass the trigger
    await prisma.$executeRawUnsafe(
      `DELETE FROM audit_log WHERE id = '${log.id}'`
    ).catch(() => {
      // Expected to fail due to trigger — that's OK, we'll verify in next test
    });
  });

  it("prevents UPDATE on audit_log rows", async () => {
    const user = await prisma.user.findFirst();
    if (!user) throw new Error("No user found");

    const log = await prisma.auditLog.create({
      data: {
        action: "TEST_IMMUTABLE",
        entityType: "test",
        entityId: "test-id-immutable",
        userId: user.id,
      },
    });

    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE audit_log SET action = 'MODIFIED' WHERE id = '${log.id}'`
      )
    ).rejects.toThrow(/immutable/i);
  });

  it("prevents DELETE on audit_log rows", async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `DELETE FROM audit_log WHERE "entityType" = 'test'`
      )
    ).rejects.toThrow(/immutable/i);
  });
});
