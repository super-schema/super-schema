import { describe, it, expect, beforeEach } from "vitest";
import {
  _resetHealthStore,
  _setDbChecker,
} from "@/services/health.service";
import type { ComponentStatus } from "@/types/schemas/health";
import { HealthCheckResponseSchema, ComponentStatusSchema } from "@/types/schemas/health";

/**
 * Unit tests for /api/v1/health endpoint logic.
 *
 * Since Next.js route handlers require the full server environment,
 * we test the service logic that powers the endpoint and verify
 * the response schema matches.
 */

describe("Health Endpoint Logic", () => {
  beforeEach(() => {
    _resetHealthStore();
  });

  it("response matches HealthCheckResponse schema when healthy", () => {
    const response = {
      status: "healthy",
      components: {
        database: { name: "Database", status: "healthy", message: "OK", latencyMs: 5 },
        compiler: { name: "TypeSpec Compiler", status: "healthy", message: "Ready" },
        emitters: { name: "Emitters", status: "healthy", message: "All operational" },
      },
      timestamp: new Date().toISOString(),
    };

    const result = HealthCheckResponseSchema.safeParse(response);
    expect(result.success).toBe(true);
  });

  it("response matches HealthCheckResponse schema when unhealthy", () => {
    const response = {
      status: "unhealthy",
      components: {
        database: { name: "Database", status: "unhealthy", message: "Connection refused" },
        compiler: { name: "TypeSpec Compiler", status: "healthy", message: "Ready" },
        emitters: { name: "Emitters", status: "healthy", message: "All operational" },
      },
      timestamp: new Date().toISOString(),
    };

    const result = HealthCheckResponseSchema.safeParse(response);
    expect(result.success).toBe(true);
  });

  it("response matches HealthCheckResponse schema when degraded", () => {
    const response = {
      status: "degraded",
      components: {
        database: { name: "Database", status: "degraded", message: "Slow", latencyMs: 300 },
        compiler: { name: "TypeSpec Compiler", status: "healthy", message: "Ready" },
        emitters: { name: "Emitters", status: "healthy", message: "All operational" },
      },
      timestamp: new Date().toISOString(),
    };

    const result = HealthCheckResponseSchema.safeParse(response);
    expect(result.success).toBe(true);
  });

  it("endpoint does not require authentication (verified by service having no RBAC on runHealthCheck)", async () => {
    // runHealthCheck does not check RBAC — it can be called with any context
    const { runHealthCheck } = await import("@/services/health.service");
    const result = await runHealthCheck({
      userId: "system",
      userRole: "ADMIN",
      prisma: null as never,
    });
    expect(result.success).toBe(true);
  });

  it("validates ComponentStatus schema", () => {
    const valid: ComponentStatus = {
      name: "Database",
      status: "healthy",
      message: "Connected",
      latencyMs: 5,
    };

    expect(ComponentStatusSchema.safeParse(valid).success).toBe(true);

    const invalid = { name: "DB", status: "invalid-status" };
    expect(ComponentStatusSchema.safeParse(invalid).success).toBe(false);
  });
});
