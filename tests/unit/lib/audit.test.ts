import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@/generated/prisma/client";

// Mock the db module before importing audit
vi.mock("@/lib/db", () => ({
  prisma: {
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: "mock-audit-id" }),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue({ id: "user-1" }),
    },
  },
}));

import { AuditUserMissingError, withAudit } from "@/lib/audit";
import { prisma } from "@/lib/db";

describe("withAudit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("executes the wrapped function and returns its result", async () => {
    const mockResult = { id: "entity-1", name: "Customer" };

    const result = await withAudit({
      action: "CREATE",
      entityType: "Entity",
      entityId: "entity-1",
      userId: "user-1",
      fn: async () => mockResult,
    });

    expect(result).toEqual(mockResult);
  });

  it("creates an audit_log entry with correct data", async () => {
    const mockResult = { id: "entity-1", name: "Customer" };

    await withAudit({
      action: "CREATE",
      entityType: "Entity",
      entityId: "entity-1",
      userId: "user-1",
      fn: async () => mockResult,
    });

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        action: "CREATE",
        entityType: "Entity",
        entityId: "entity-1",
        userId: "user-1",
        beforeState: Prisma.JsonNull,
        afterState: mockResult,
      },
    });
  });

  it("includes beforeState when provided", async () => {
    const beforeState = { name: "OldName" };
    const afterResult = { id: "entity-1", name: "NewName" };

    await withAudit({
      action: "UPDATE",
      entityType: "Entity",
      entityId: "entity-1",
      userId: "user-1",
      beforeState,
      fn: async () => afterResult,
    });

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "UPDATE",
        beforeState,
        afterState: afterResult,
      }),
    });
  });

  it("handles null result (e.g., DELETE operations)", async () => {
    await withAudit({
      action: "DELETE",
      entityType: "Entity",
      entityId: "entity-1",
      userId: "user-1",
      beforeState: { id: "entity-1", name: "Customer" },
      fn: async () => null,
    });

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "DELETE",
        afterState: Prisma.JsonNull,
      }),
    });
  });

  it("propagates errors from the wrapped function", async () => {
    await expect(
      withAudit({
        action: "CREATE",
        entityType: "Entity",
        entityId: "entity-1",
        userId: "user-1",
        fn: async () => {
          throw new Error("DB connection failed");
        },
      })
    ).rejects.toThrow("DB connection failed");
  });

  it("fails before the wrapped write when the audit user is missing", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(null);
    const fn = vi.fn().mockResolvedValue({ id: "entity-1" });

    await expect(
      withAudit({
        action: "CREATE",
        entityType: "Entity",
        entityId: "entity-1",
        userId: "missing-user",
        fn,
      })
    ).rejects.toBeInstanceOf(AuditUserMissingError);

    expect(fn).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
