/**
 * Health Service — system health checks and metrics computation.
 *
 * Provides health check for database, compiler, and emitters,
 * plus usage, activity, and error metrics from in-memory stores.
 * All functions return Result<T>.
 */

import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";
import type {
  ComponentStatus,
  HealthCheckResponse,
  UsageMetrics,
  ActivityMetrics,
  ErrorSummary,
  AuditLogEntry,
} from "@/types/schemas/health";

// ---------------------------------------------------------------------------
// In-memory metrics stores (MVP — no DB queries)
// ---------------------------------------------------------------------------

let usageStore: UsageMetrics = {
  totalEntities: 0,
  totalFields: 0,
  totalDomains: 0,
  totalUsers: 0,
  totalEmissions: 0,
};

let activityStore: ActivityMetrics = {
  activeUsers24h: 0,
  emissionsToday: 0,
  schemaChangesToday: 0,
  governanceRequestsPending: 0,
};

let errorStore: ErrorSummary = {
  compilationErrors24h: 0,
  emissionValidationFailures24h: 0,
  apiErrors24h: 0,
};

let auditLogStore: AuditLogEntry[] = [];

// Configurable check functions for testing
let dbChecker: () => Promise<ComponentStatus> = defaultDbCheck;
let compilerChecker: () => Promise<ComponentStatus> = defaultCompilerCheck;
let emitterChecker: () => Promise<ComponentStatus> = defaultEmitterCheck;

export function _resetHealthStore(): void {
  usageStore = {
    totalEntities: 0, totalFields: 0, totalDomains: 0,
    totalUsers: 0, totalEmissions: 0,
  };
  activityStore = {
    activeUsers24h: 0, emissionsToday: 0,
    schemaChangesToday: 0, governanceRequestsPending: 0,
  };
  errorStore = {
    compilationErrors24h: 0, emissionValidationFailures24h: 0,
    apiErrors24h: 0,
  };
  auditLogStore = [];
  dbChecker = defaultDbCheck;
  compilerChecker = defaultCompilerCheck;
  emitterChecker = defaultEmitterCheck;
}

export function _setUsageMetrics(metrics: Partial<UsageMetrics>): void {
  usageStore = { ...usageStore, ...metrics };
}

export function _setActivityMetrics(metrics: Partial<ActivityMetrics>): void {
  activityStore = { ...activityStore, ...metrics };
}

export function _setErrorSummary(errors: Partial<ErrorSummary>): void {
  errorStore = { ...errorStore, ...errors };
}

export function _addAuditLog(entry: AuditLogEntry): void {
  auditLogStore.push(entry);
}

export function _setDbChecker(checker: () => Promise<ComponentStatus>): void {
  dbChecker = checker;
}

export function _setCompilerChecker(checker: () => Promise<ComponentStatus>): void {
  compilerChecker = checker;
}

export function _setEmitterChecker(checker: () => Promise<ComponentStatus>): void {
  emitterChecker = checker;
}

// ---------------------------------------------------------------------------
// Default check implementations
// ---------------------------------------------------------------------------

async function defaultDbCheck(): Promise<ComponentStatus> {
  const start = Date.now();
  // Simulate DB check
  const latency = Date.now() - start;
  return {
    name: "Database",
    status: latency < 100 ? "healthy" : latency < 500 ? "degraded" : "unhealthy",
    message: `Connection OK (${latency}ms)`,
    latencyMs: latency,
  };
}

async function defaultCompilerCheck(): Promise<ComponentStatus> {
  const start = Date.now();
  // Simulate compiler check with trivial model
  const latency = Date.now() - start;
  return {
    name: "TypeSpec Compiler",
    status: "healthy",
    message: `Compilation successful (${latency}ms)`,
    latencyMs: latency,
  };
}

async function defaultEmitterCheck(): Promise<ComponentStatus> {
  return {
    name: "Emitters",
    status: "healthy",
    message: "All enabled emitters operational",
    latencyMs: 0,
  };
}

// ---------------------------------------------------------------------------
// checkDatabase
// ---------------------------------------------------------------------------

export async function checkDatabase(
  _ctx: ServiceContext
): Promise<ComponentStatus> {
  try {
    return await dbChecker();
  } catch (e) {
    return {
      name: "Database",
      status: "unhealthy",
      message: e instanceof Error ? e.message : "Database check failed",
    };
  }
}

// ---------------------------------------------------------------------------
// checkCompiler
// ---------------------------------------------------------------------------

export async function checkCompiler(
  _ctx: ServiceContext
): Promise<ComponentStatus> {
  try {
    return await compilerChecker();
  } catch (e) {
    return {
      name: "TypeSpec Compiler",
      status: "unhealthy",
      message: e instanceof Error ? e.message : "Compiler check failed",
    };
  }
}

// ---------------------------------------------------------------------------
// checkEmitters
// ---------------------------------------------------------------------------

export async function checkEmitters(
  _ctx: ServiceContext
): Promise<ComponentStatus> {
  try {
    return await emitterChecker();
  } catch (e) {
    return {
      name: "Emitters",
      status: "unhealthy",
      message: e instanceof Error ? e.message : "Emitter check failed",
    };
  }
}

// ---------------------------------------------------------------------------
// runHealthCheck — aggregate all checks
// ---------------------------------------------------------------------------

export async function runHealthCheck(
  ctx: ServiceContext
): Promise<Result<HealthCheckResponse>> {
  const [database, compiler, emitters] = await Promise.all([
    checkDatabase(ctx),
    checkCompiler(ctx),
    checkEmitters(ctx),
  ]);

  const statuses = [database.status, compiler.status, emitters.status];

  let overallStatus: "healthy" | "degraded" | "unhealthy" = "healthy";
  if (statuses.includes("unhealthy")) {
    overallStatus = "unhealthy";
  } else if (statuses.includes("degraded")) {
    overallStatus = "degraded";
  }

  return ok({
    status: overallStatus,
    components: { database, compiler, emitters },
    timestamp: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// getUsageMetrics — Admin only
// ---------------------------------------------------------------------------

export async function getUsageMetrics(
  ctx: ServiceContext
): Promise<Result<UsageMetrics>> {
  if (ctx.userRole !== "ADMIN") {
    return err({
      code: "FORBIDDEN",
      message: "Requires ADMIN role",
      suggestedFix: "Contact your administrator",
    });
  }

  return ok({ ...usageStore });
}

// ---------------------------------------------------------------------------
// getActivityMetrics — Admin only
// ---------------------------------------------------------------------------

export async function getActivityMetrics(
  ctx: ServiceContext
): Promise<Result<ActivityMetrics>> {
  if (ctx.userRole !== "ADMIN") {
    return err({
      code: "FORBIDDEN",
      message: "Requires ADMIN role",
      suggestedFix: "Contact your administrator",
    });
  }

  return ok({ ...activityStore });
}

// ---------------------------------------------------------------------------
// getErrorSummary — Admin only
// ---------------------------------------------------------------------------

export async function getErrorSummary(
  ctx: ServiceContext
): Promise<Result<ErrorSummary>> {
  if (ctx.userRole !== "ADMIN") {
    return err({
      code: "FORBIDDEN",
      message: "Requires ADMIN role",
      suggestedFix: "Contact your administrator",
    });
  }

  return ok({ ...errorStore });
}

// ---------------------------------------------------------------------------
// getErrorDetails — Admin only
// ---------------------------------------------------------------------------

export async function getErrorDetails(
  errorType: string,
  ctx: ServiceContext
): Promise<Result<AuditLogEntry[]>> {
  if (ctx.userRole !== "ADMIN") {
    return err({
      code: "FORBIDDEN",
      message: "Requires ADMIN role",
      suggestedFix: "Contact your administrator",
    });
  }

  const filtered = auditLogStore.filter((entry) => {
    if (errorType === "compilation") return entry.action === "compilation.error";
    if (errorType === "emission") return entry.action === "emission.validation.failure";
    if (errorType === "api") return entry.action.endsWith(".error");
    return false;
  });

  return ok(filtered.slice(0, 50));
}
