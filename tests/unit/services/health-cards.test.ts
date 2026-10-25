import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// FINAL WAVE 2b, G8: the Admin > Health cards count what the application really writes. The audit log holds CREATE / UPDATE / DELETE
// (entities and fields), PUBLISH_VERSION, GENERATE (a schema version was generated) and the failures that are recorded
// (EMISSION_FAILED, COMPILATION_ERROR). The service used to count action names nothing writes (`emission.*`, `field.create`,
// `compilation.error`, `*.error`), so five of the twelve cards were always zero. The compiler and emitters checks were constants.

const mockAuditLogFindMany = vi.fn().mockResolvedValue([]);
const mockAuditLogCount = vi.fn().mockResolvedValue(0);
const mockGovernanceRequestCount = vi.fn().mockResolvedValue(0);
const mockGovernanceRequestFindMany = vi.fn().mockResolvedValue([]);
const mockEntityFindMany = vi.fn().mockResolvedValue([]);

vi.mock("@/lib/db", () => ({
  prisma: {
    auditLog: {
      findMany: (...args: unknown[]) => mockAuditLogFindMany(...args),
      count: (...args: unknown[]) => mockAuditLogCount(...args),
    },
    governanceRequest: {
      count: (...args: unknown[]) => mockGovernanceRequestCount(...args),
      findMany: (...args: unknown[]) => mockGovernanceRequestFindMany(...args),
    },
    entity: { findMany: (...args: unknown[]) => mockEntityFindMany(...args) },
    $queryRaw: vi.fn().mockResolvedValue([{ result: 1 }]),
  },
}));

import {
  checkCompiler,
  checkEmitters,
  checkInstalledPackages,
  getActivityMetrics,
  getErrorDetails,
  getErrorSummary,
  _resetHealthStore,
} from "@/services/health.service";
import type { ServiceContext } from "@/types/service-context";

const adminCtx: ServiceContext = { userId: "admin-1", userRole: "ADMIN", prisma: null as unknown as ServiceContext["prisma"] };

describe("what the Health cards count (the audit actions that are written)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetHealthStore();
    mockAuditLogFindMany.mockResolvedValue([]);
    mockAuditLogCount.mockResolvedValue(0);
    mockGovernanceRequestCount.mockResolvedValue(0);
  });
  const wheres = () => mockAuditLogCount.mock.calls.map((call) => (call[0] as { where: Record<string, unknown> }).where);

  it("Emissions Today counts the GENERATE rows of today", async () => {
    await getActivityMetrics(adminCtx);
    expect(wheres()).toContainEqual({ action: "GENERATE", timestamp: { gte: expect.any(Date) } });
  });

  it("Schema Changes counts the CREATE / UPDATE / DELETE rows of an Entity or a Field of today", async () => {
    await getActivityMetrics(adminCtx);
    expect(wheres()).toContainEqual({ action: { in: ["CREATE", "UPDATE", "DELETE"] }, entityType: { in: ["Entity", "Field"] }, timestamp: { gte: expect.any(Date) } });
  });

  it("the cards of today start at midnight of today (the server's), not 24 hours ago", async () => {
    await getActivityMetrics(adminCtx);
    for (const where of wheres()) {
      const gte = (where.timestamp as { gte: Date }).gte;
      expect([gte.getHours(), gte.getMinutes(), gte.getSeconds()]).toEqual([0, 0, 0]);
    }
  });

  it("Compilation Errors and Emission Failures count COMPILATION_ERROR and EMISSION_FAILED rows of the last 24 hours", async () => {
    mockAuditLogCount.mockResolvedValueOnce(4).mockResolvedValueOnce(9);
    const result = await getErrorSummary(adminCtx);
    expect(result.success && result.data).toEqual({ compilationErrors24h: 4, emissionValidationFailures24h: 9 });
    expect(wheres()).toEqual([
      { action: "COMPILATION_ERROR", timestamp: { gte: expect.any(Date) } },
      { action: "EMISSION_FAILED", timestamp: { gte: expect.any(Date) } },
    ]);
  });

  it("Pending Governance is the dashboard's rule: PENDING requests of entities of the tenant being viewed (a deleted or foreign entity's do not count)", async () => {
    mockGovernanceRequestFindMany.mockResolvedValue([{ entityId: "e-a" }, { entityId: "e-a" }, { entityId: "e-b" }, { entityId: "e-gone" }]);
    mockEntityFindMany.mockResolvedValue([{ id: "e-a" }]);
    const scoped = await getActivityMetrics(adminCtx, "tenant-a");
    expect(scoped.success && scoped.data.governanceRequestsPending).toBe(2);
    expect(mockEntityFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ tenantId: "tenant-a" }) }));
    // without a tenant it is the plain count, as before
    mockGovernanceRequestCount.mockResolvedValue(7);
    const unscoped = await getActivityMetrics(adminCtx);
    expect(unscoped.success && unscoped.data.governanceRequestsPending).toBe(7);
  });

  it("there is no API error count: nothing counts API errors, so the summary does not claim one", async () => {
    const result = await getErrorSummary(adminCtx);
    expect(result.success && Object.keys(result.data).sort()).toEqual(["compilationErrors24h", "emissionValidationFailures24h"]);
  });

  it("the error details list the same rows the cards count, and nothing for an unknown type (api)", async () => {
    await getErrorDetails("compilation", adminCtx);
    await getErrorDetails("emission", adminCtx);
    expect(mockAuditLogFindMany.mock.calls.map((call) => (call[0] as { where: unknown }).where)).toEqual([{ action: "COMPILATION_ERROR" }, { action: "EMISSION_FAILED" }]);
    mockAuditLogFindMany.mockClear();
    const unknown = await getErrorDetails("api", adminCtx);
    expect(unknown.success && unknown.data).toEqual([]);
    expect(mockAuditLogFindMany).not.toHaveBeenCalled();
  });
});

describe("the compiler and emitters checks look at what is installed", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  function installed(...packages: Array<[string, string]>): string {
    const root = mkdtempSync(join(tmpdir(), "health-installed-"));
    roots.push(root);
    for (const [name, version] of packages) {
      mkdirSync(join(root, "node_modules", name), { recursive: true });
      writeFileSync(join(root, "node_modules", name, "package.json"), JSON.stringify({ name, version }));
    }
    return root;
  }

  it("the compiler is healthy with its version when @typespec/compiler is installed, unhealthy (without a path) when it is not", async () => {
    const ok = await checkInstalledPackages("TypeSpec Compiler", ["@typespec/compiler"], installed(["@typespec/compiler", "1.2.3"]));
    expect(ok).toMatchObject({ name: "TypeSpec Compiler", status: "healthy" });
    expect(ok.message).toContain("1.2.3");
    const missing = await checkInstalledPackages("TypeSpec Compiler", ["@typespec/compiler"], installed());
    expect(missing).toMatchObject({ name: "TypeSpec Compiler", status: "unhealthy" });
    expect(missing.message).not.toContain(tmpdir());
  });

  it("the emitters are healthy when every emitter package is installed, degraded when some are not, unhealthy when none is", async () => {
    const names = ["@typespec/avro", "@typespec/json-schema", "@typespec/protobuf"];
    expect((await checkInstalledPackages("Emitters", names, installed(...names.map((n): [string, string] => [n, "1.0.0"])))).status).toBe("healthy");
    const some = await checkInstalledPackages("Emitters", names, installed(["@typespec/avro", "1.0.0"]));
    expect(some.status).toBe("degraded");
    expect(some.message).toBe("1 of 3 emitter packages installed");
    expect((await checkInstalledPackages("Emitters", names, installed())).status).toBe("unhealthy");
  });

  it("a package whose package.json cannot be read is not installed", async () => {
    const root = installed();
    mkdirSync(join(root, "node_modules", "@typespec", "avro"), { recursive: true });
    expect((await checkInstalledPackages("Emitters", ["@typespec/avro"], root)).status).toBe("unhealthy");
  });

  it("the default checks run against this project and find the compiler and the emitters of the catalog", async () => {
    _resetHealthStore();
    expect((await checkCompiler(adminCtx)).status).toBe("healthy");
    expect((await checkEmitters(adminCtx)).status).toBe("healthy");
  });
});
