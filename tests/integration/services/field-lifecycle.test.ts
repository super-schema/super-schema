import "dotenv/config";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { createDomain } from "@/services/domain.service";
import { createEntity } from "@/services/entity.service";
import {
  createField,
  updateField,
  reorderFields,
  deleteField,
} from "@/services/field.service";
import type { ServiceContext } from "@/types/service-context";

let prisma: PrismaClient;
let ctx: ServiceContext;
let testDomainId: string;
let testEntityId: string;

beforeAll(async () => {
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL!,
  });
  prisma = new PrismaClient({ adapter });

  const user = await prisma.user.findFirst();
  if (!user) throw new Error("No user found");

  ctx = { userId: user.id, userRole: "AUTHOR", prisma };

  // Create test domain + entity
  const domResult = await createDomain(
    { name: `field-test-${Date.now()}`, description: "Test" },
    ctx
  );
  if (!domResult.success) throw new Error("Domain creation failed");
  testDomainId = domResult.data.id;

  const entResult = await createEntity(
    { name: "FieldTestEntity", domainId: testDomainId, description: "Test" },
    ctx
  );
  if (!entResult.success) throw new Error("Entity creation failed");
  testEntityId = entResult.data.id;
});

afterAll(async () => {
  if (testDomainId) {
    await prisma.domain.delete({ where: { id: testDomainId } }).catch(() => {});
  }
  await prisma.$disconnect();
});

describe("Field Lifecycle Integration", () => {
  it("full lifecycle: create -> update -> reorder -> delete", async () => {
    // Create fields
    const f1 = await createField(
      testEntityId,
      { name: "customer_id", type: "string", isKey: true },
      ctx
    );
    expect(f1.success).toBe(true);
    if (!f1.success) throw new Error("Field 1 creation failed");
    expect(f1.data.sortOrder).toBe(0);

    const f2 = await createField(
      testEntityId,
      { name: "email", type: "string", classification: "PII" },
      ctx
    );
    expect(f2.success).toBe(true);
    if (!f2.success) throw new Error("Field 2 creation failed");
    expect(f2.data.sortOrder).toBe(1);

    const f3 = await createField(
      testEntityId,
      {
        name: "amount",
        type: "decimal",
        precision: 10,
        scale: 2,
        decorators: { classification: { level: "SENSITIVE" } },
      },
      ctx
    );
    expect(f3.success).toBe(true);
    if (!f3.success) throw new Error("Field 3 creation failed");
    expect(f3.data.sortOrder).toBe(2);

    // Update field
    const updated = await updateField(
      f2.data.id,
      { description: "Customer email address" },
      ctx
    );
    expect(updated.success).toBe(true);
    if (updated.success) {
      expect(updated.data.description).toBe("Customer email address");
    }

    // Reorder fields: amount, customer_id, email
    const reordered = await reorderFields(
      testEntityId,
      [f3.data.id, f1.data.id, f2.data.id],
      ctx
    );
    expect(reordered.success).toBe(true);

    // Verify sort order after reorder
    const reorderedFields = await prisma.field.findMany({
      where: { entityId: testEntityId },
      orderBy: { sortOrder: "asc" },
    });
    expect(reorderedFields[0].name).toBe("amount");
    expect(reorderedFields[1].name).toBe("customer_id");
    expect(reorderedFields[2].name).toBe("email");

    // Delete field
    const deleted = await deleteField(f3.data.id, ctx);
    expect(deleted.success).toBe(true);

    // Verify audit log entries exist
    const auditLogs = await prisma.auditLog.findMany({
      where: { entityType: "Field", userId: ctx.userId },
      orderBy: { timestamp: "desc" },
      take: 10,
    });
    const actions = auditLogs.map((l) => l.action);
    expect(actions).toContain("CREATE");
    expect(actions).toContain("UPDATE");
    expect(actions).toContain("REORDER");
    expect(actions).toContain("DELETE");
  });
});
