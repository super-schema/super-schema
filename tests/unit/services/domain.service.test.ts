import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    domain: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    tenant: {
      upsert: vi.fn().mockResolvedValue({ id: "tenant_default" }),
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: "audit-1" }),
    },
    user: {
      findUnique: vi.fn().mockResolvedValue({ id: "user-1" }),
    },
  },
}));

import { createDomain, getDomains, getDomainById } from "@/services/domain.service";
import { prisma } from "@/lib/db";
import type { ServiceContext } from "@/types/service-context";

const mockCtx: ServiceContext = {
  userId: "user-1",
  userRole: "AUTHOR",
  prisma: prisma as unknown as ServiceContext["prisma"],
};

describe("Domain Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("createDomain", () => {
    it("returns success result on valid input", async () => {
      const mockDomain = { id: "dom-1", name: "Payment", description: "Payment domain" };
      vi.mocked(prisma.domain.create).mockResolvedValue(mockDomain as never);

      const result = await createDomain(
        { name: "Payment", description: "Payment domain" },
        mockCtx
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe("Payment");
      }
    });

    it("returns validation error for empty name", async () => {
      const result = await createDomain(
        { name: "", description: "Test" },
        mockCtx
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
      }
    });

    it("rejects names that collide with schema utility routes", async () => {
      const result = await createDomain(
        { name: "Type Mappings", description: "Reserved route" },
        mockCtx
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
        expect(result.error.message).toContain("reserved");
      }
      expect(prisma.domain.create).not.toHaveBeenCalled();
    });

    it("returns error for invalid policyTemplate JSONB", async () => {
      const result = await createDomain(
        {
          name: "Test",
          description: "Test",
          policyTemplate: { defaultClassification: "INVALID_LEVEL" } as never,
        },
        mockCtx
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
        expect(result.error.suggestedFix).toBeDefined();
      }
    });
  });

  describe("getDomains", () => {
    it("returns list of domains", async () => {
      const mockDomains = [
        { id: "dom-1", name: "Public", isSystem: true },
        { id: "dom-2", name: "Payment", isSystem: false },
      ];
      vi.mocked(prisma.domain.findMany).mockResolvedValue(mockDomains as never);

      const result = await getDomains(mockCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(2);
      }
    });
  });

  describe("getDomainById", () => {
    it("returns domain when found", async () => {
      const mockDomain = { id: "dom-1", name: "Public" };
      vi.mocked(prisma.domain.findUnique).mockResolvedValue(mockDomain as never);

      const result = await getDomainById("dom-1", mockCtx);

      expect(result.success).toBe(true);
    });

    it("returns not-found error for missing domain", async () => {
      vi.mocked(prisma.domain.findUnique).mockResolvedValue(null);

      const result = await getDomainById("nonexistent", mockCtx);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });
  });
});
