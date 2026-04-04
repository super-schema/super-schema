import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock Prisma with configurable return values
// ---------------------------------------------------------------------------

const mockEntityCount = vi.fn().mockResolvedValue(0);
const mockFieldCount = vi.fn().mockResolvedValue(0);
const mockDomainCount = vi.fn().mockResolvedValue(0);
const mockUserCount = vi.fn().mockResolvedValue(0);
const mockEmissionTargetStatusCount = vi.fn().mockResolvedValue(0);
const mockAuditLogFindMany = vi.fn().mockResolvedValue([]);
const mockAuditLogCount = vi.fn().mockResolvedValue(0);
const mockGovernanceRequestCount = vi.fn().mockResolvedValue(0);
const mockQueryRaw = vi.fn().mockResolvedValue([{ result: 1 }]);

vi.mock("@/lib/db", () => ({
  prisma: {
    entity: { count: (...args: unknown[]) => mockEntityCount(...args) },
    field: { count: (...args: unknown[]) => mockFieldCount(...args) },
    domain: { count: (...args: unknown[]) => mockDomainCount(...args) },
    user: { count: (...args: unknown[]) => mockUserCount(...args) },
    emissionTargetStatus: { count: (...args: unknown[]) => mockEmissionTargetStatusCount(...args) },
    auditLog: {
      findMany: (...args: unknown[]) => mockAuditLogFindMany(...args),
      count: (...args: unknown[]) => mockAuditLogCount(...args),
    },
    governanceRequest: { count: (...args: unknown[]) => mockGovernanceRequestCount(...args) },
    $queryRaw: (...args: unknown[]) => mockQueryRaw(...args),
  },
}));

import {
  checkDatabase,
  checkCompiler,
  checkEmitters,
  runHealthCheck,
  getUsageMetrics,
  getActivityMetrics,
  getErrorSummary,
  getErrorDetails,
  _resetHealthStore,
  _setUsageMetrics,
  _setActivityMetrics,
  _setErrorSummary,
  _addAuditLog,
  _setDbChecker,
  _setCompilerChecker,
  _setEmitterChecker,
} from "@/services/health.service";
import type { ServiceContext } from "@/types/service-context";

const adminCtx: ServiceContext = {
  userId: "admin-1",
  userRole: "ADMIN",
  prisma: null as unknown as ServiceContext["prisma"],
};

const viewerCtx: ServiceContext = {
  userId: "viewer-1",
  userRole: "VIEWER",
  prisma: null as unknown as ServiceContext["prisma"],
};

describe("Health Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetHealthStore();
    // Reset mock return values
    mockEntityCount.mockResolvedValue(0);
    mockFieldCount.mockResolvedValue(0);
    mockDomainCount.mockResolvedValue(0);
    mockUserCount.mockResolvedValue(0);
    mockEmissionTargetStatusCount.mockResolvedValue(0);
    mockAuditLogFindMany.mockResolvedValue([]);
    mockAuditLogCount.mockResolvedValue(0);
    mockGovernanceRequestCount.mockResolvedValue(0);
  });

  describe("checkDatabase", () => {
    it("returns healthy on successful query", async () => {
      const result = await checkDatabase(adminCtx);
      expect(result.status).toBe("healthy");
      expect(result.name).toBe("Database");
    });

    it("returns unhealthy on query failure", async () => {
      _setDbChecker(async () => {
        throw new Error("Connection refused");
      });

      const result = await checkDatabase(adminCtx);
      expect(result.status).toBe("unhealthy");
      expect(result.message).toContain("Connection refused");
    });
  });

  describe("checkCompiler", () => {
    it("returns healthy when trivial model compiles", async () => {
      const result = await checkCompiler(adminCtx);
      expect(result.status).toBe("healthy");
    });

    it("returns unhealthy when compiler fails", async () => {
      _setCompilerChecker(async () => {
        throw new Error("Compiler not found");
      });

      const result = await checkCompiler(adminCtx);
      expect(result.status).toBe("unhealthy");
      expect(result.message).toContain("Compiler not found");
    });
  });

  describe("checkEmitters", () => {
    it("returns correct status based on emitter results", async () => {
      const result = await checkEmitters(adminCtx);
      expect(result.status).toBe("healthy");
    });

    it("returns unhealthy when emitters fail", async () => {
      _setEmitterChecker(async () => {
        throw new Error("Emitter timeout");
      });

      const result = await checkEmitters(adminCtx);
      expect(result.status).toBe("unhealthy");
    });
  });

  describe("runHealthCheck", () => {
    it("aggregates component statuses correctly — all healthy", async () => {
      const result = await runHealthCheck(adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe("healthy");
        expect(result.data.components.database.status).toBe("healthy");
        expect(result.data.components.compiler.status).toBe("healthy");
        expect(result.data.components.emitters.status).toBe("healthy");
        expect(result.data.timestamp).toBeTruthy();
      }
    });

    it("reports degraded when any component is degraded", async () => {
      _setDbChecker(async () => ({
        name: "Database",
        status: "degraded",
        message: "Slow",
        latencyMs: 200,
      }));

      const result = await runHealthCheck(adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe("degraded");
      }
    });

    it("reports unhealthy when any component is unhealthy", async () => {
      _setCompilerChecker(async () => {
        throw new Error("Crash");
      });

      const result = await runHealthCheck(adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe("unhealthy");
      }
    });
  });

  describe("getUsageMetrics", () => {
    it("returns correct counts", async () => {
      mockEntityCount.mockResolvedValue(10);
      mockFieldCount.mockResolvedValue(50);
      mockDomainCount.mockResolvedValue(3);
      mockUserCount.mockResolvedValue(5);
      mockEmissionTargetStatusCount.mockResolvedValue(20);

      const result = await getUsageMetrics(adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.totalEntities).toBe(10);
        expect(result.data.totalFields).toBe(50);
        expect(result.data.totalDomains).toBe(3);
        expect(result.data.totalUsers).toBe(5);
        expect(result.data.totalEmissions).toBe(20);
      }
    });

    it("requires Admin role", async () => {
      const result = await getUsageMetrics(viewerCtx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("FORBIDDEN");
      }
    });
  });

  describe("getActivityMetrics", () => {
    it("returns correct 24h activity counts", async () => {
      // Mock distinct userId query
      mockAuditLogFindMany.mockResolvedValue([
        { userId: "u-1" },
        { userId: "u-2" },
        { userId: "u-3" },
      ]);
      // Mock count calls: emissions, schema changes
      mockAuditLogCount
        .mockResolvedValueOnce(7)   // emissionsToday
        .mockResolvedValueOnce(12); // schemaChangesToday
      mockGovernanceRequestCount.mockResolvedValue(2);

      const result = await getActivityMetrics(adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.activeUsers24h).toBe(3);
        expect(result.data.emissionsToday).toBe(7);
        expect(result.data.schemaChangesToday).toBe(12);
        expect(result.data.governanceRequestsPending).toBe(2);
      }
    });

    it("requires Admin role", async () => {
      const result = await getActivityMetrics(viewerCtx);
      expect(result.success).toBe(false);
    });
  });

  describe("getErrorSummary", () => {
    it("returns correct error counts from audit_log", async () => {
      mockAuditLogCount
        .mockResolvedValueOnce(5)  // compilationErrors24h
        .mockResolvedValueOnce(2)  // emissionValidationFailures24h
        .mockResolvedValueOnce(1); // apiErrors24h

      const result = await getErrorSummary(adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.compilationErrors24h).toBe(5);
        expect(result.data.emissionValidationFailures24h).toBe(2);
        expect(result.data.apiErrors24h).toBe(1);
      }
    });

    it("requires Admin role", async () => {
      const result = await getErrorSummary(viewerCtx);
      expect(result.success).toBe(false);
    });
  });

  describe("getErrorDetails", () => {
    it("returns filtered audit entries for compilation errors", async () => {
      mockAuditLogFindMany.mockResolvedValue([
        {
          id: "log-1",
          action: "compilation.error",
          entityType: "Entity",
          entityId: "e-1",
          userId: "u-1",
          timestamp: new Date(),
          afterState: null,
        },
      ]);

      const result = await getErrorDetails("compilation", adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0].action).toBe("compilation.error");
      }
    });

    it("returns filtered audit entries for emission failures", async () => {
      mockAuditLogFindMany.mockResolvedValue([
        {
          id: "log-3",
          action: "emission.validation.failure",
          entityType: "Emission",
          entityId: "em-1",
          userId: "u-1",
          timestamp: new Date(),
          afterState: null,
        },
      ]);

      const result = await getErrorDetails("emission", adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(1);
      }
    });

    it("requires Admin role", async () => {
      const result = await getErrorDetails("compilation", viewerCtx);
      expect(result.success).toBe(false);
    });
  });
});
