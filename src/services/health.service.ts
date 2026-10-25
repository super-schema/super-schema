/**
 * Health Service — system health checks and metrics computation.
 *
 * Provides health check for database, compiler, and emitters,
 * plus usage, activity, and error metrics via Prisma aggregate queries.
 * All functions return Result<T>.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db";
import { getSchemaTargetCatalog } from "@/lib/schema-targets/catalog";
import { countPendingRequests } from "@/services/governance.service";
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
// Configurable check functions (overridable for testing)
// ---------------------------------------------------------------------------

let dbChecker: () => Promise<ComponentStatus> = defaultDbCheck;
let compilerChecker: () => Promise<ComponentStatus> = defaultCompilerCheck;
let emitterChecker: () => Promise<ComponentStatus> = defaultEmitterCheck;

// ---------------------------------------------------------------------------
// Reset / seed helpers — kept for test compatibility
// ---------------------------------------------------------------------------

export function _resetHealthStore(): void {
  // Reset checkers to defaults
  dbChecker = defaultDbCheck;
  compilerChecker = defaultCompilerCheck;
  emitterChecker = defaultEmitterCheck;
}

export function _setUsageMetrics(_metrics: Partial<UsageMetrics>): void {
  // No-op — usage metrics now come from Prisma aggregate queries
}

export function _setActivityMetrics(_metrics: Partial<ActivityMetrics>): void {
  // No-op — activity metrics now come from Prisma aggregate queries
}

export function _setErrorSummary(_errors: Partial<ErrorSummary>): void {
  // No-op — error summary now comes from Prisma aggregate queries
}

export function _addAuditLog(_entry: AuditLogEntry): void {
  // No-op — audit log entries are now managed via Prisma
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

/**
 * What this endpoint says about a failure is generic: it needs no login, and a database error carries the host, the user and
 * sometimes the connection string. The real error goes to the server's log (`[health] ...`).
 */
const DB_UNAVAILABLE = "Database unavailable";
const DB_TIMEOUT = "Database did not answer in time";

/** HEALTH_DB_DEGRADED_MS: a database that answers in this many ms or more is "degraded" (HTTP 200), not "unhealthy". */
const DEFAULT_DB_DEGRADED_MS = 500;
/** HEALTH_DB_TIMEOUT_MS: a database that has not answered by now FAILS the probe (HTTP 503), instead of hanging it. */
const DEFAULT_DB_TIMEOUT_MS = 5000;

/** A setting that is a positive number of milliseconds; anything else (unset, empty, text, zero, negative) is the default. */
function positiveMs(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return raw !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

class DbCheckTimeout extends Error {}

/**
 * `work` or a rejection after `ms`, whichever is first. Prisma's `$queryRaw` cannot be cancelled, so a hung query keeps running in the
 * background; what is bounded is the PROBE. The loser's later rejection is handled (it must not become an unhandled rejection) and the
 * timer is cleared.
 */
async function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DbCheckTimeout()), ms);
  });
  work.catch(() => {});
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function defaultDbCheck(): Promise<ComponentStatus> {
  const degradedAfterMs = positiveMs(process.env.HEALTH_DB_DEGRADED_MS, DEFAULT_DB_DEGRADED_MS);
  const timeoutMs = positiveMs(process.env.HEALTH_DB_TIMEOUT_MS, DEFAULT_DB_TIMEOUT_MS);
  const start = Date.now();
  try {
    await within(Promise.resolve(prisma.$queryRaw`SELECT 1`), timeoutMs);
    const latency = Date.now() - start;
    return latency < degradedAfterMs
      ? { name: "Database", status: "healthy", message: `Connection OK (${latency}ms)`, latencyMs: latency }
      : { name: "Database", status: "degraded", message: `Slow answer (${latency}ms)`, latencyMs: latency };
  } catch (e) {
    const latency = Date.now() - start;
    const timedOut = e instanceof DbCheckTimeout;
    console.error(timedOut ? `[health] the database did not answer within ${timeoutMs} ms` : "[health] the database check failed", e instanceof Error ? e : { message: String(e) });
    return { name: "Database", status: "unhealthy", message: timedOut ? DB_TIMEOUT : DB_UNAVAILABLE, latencyMs: latency };
  }
}

/** The version of an installed package (`<root>/node_modules/<name>/package.json`), or null when it is not installed or unreadable. */
async function installedVersion(name: string, root: string): Promise<string | null> {
  try {
    const manifest = JSON.parse(await readFile(path.join(root, "node_modules", name, "package.json"), "utf8")) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : "unknown version";
  } catch {
    return null;
  }
}

/**
 * A cheap, TRUTHFUL check of what a component runs on: the packages are installed where the emission looks for them
 * (`<root>/node_modules`, the project's own, which is where `tsp` is pinned to). It does not compile anything, so it says nothing about
 * a package that is installed but broken; it no longer says "healthy" for a missing one. Every package missing is unhealthy, some is
 * degraded. The names of what is missing go to the server's log only: this answer is public (`/api/v1/health`).
 */
export async function checkInstalledPackages(name: string, packages: readonly string[], root: string = process.cwd()): Promise<ComponentStatus> {
  const start = Date.now();
  const found = await Promise.all(packages.map(async (pkg) => ({ pkg, version: await installedVersion(pkg, root) })));
  const latencyMs = Date.now() - start;
  const missing = found.filter((f) => f.version === null).map((f) => f.pkg);
  if (missing.length > 0) console.error(`[health] ${name}: not installed: ${missing.join(", ")}`);
  if (packages.length === 1) {
    return missing.length === 0
      ? { name, status: "healthy", message: `${found[0].pkg} ${found[0].version} installed`, latencyMs }
      : { name, status: "unhealthy", message: `${name} is not installed`, latencyMs };
  }
  const present = packages.length - missing.length;
  const message = `${present} of ${packages.length} emitter packages installed`;
  if (missing.length === 0) return { name, status: "healthy", message, latencyMs };
  return { name, status: present === 0 ? "unhealthy" : "degraded", message, latencyMs };
}

async function defaultCompilerCheck(): Promise<ComponentStatus> {
  return checkInstalledPackages("TypeSpec Compiler", ["@typespec/compiler"]);
}

async function defaultEmitterCheck(): Promise<ComponentStatus> {
  // The emitter packages of the targets the application generates (`enabledInSchemaTab`).
  const packages = [...new Set(getSchemaTargetCatalog().flatMap((target) => (target.enabledInSchemaTab && target.packageName ? [target.packageName] : [])))];
  return checkInstalledPackages("Emitters", packages);
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
    console.error("[health] the database check threw", e);
    return { name: "Database", status: "unhealthy", message: DB_UNAVAILABLE };
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
    console.error("[health] the compiler check threw", e);
    return { name: "TypeSpec Compiler", status: "unhealthy", message: "Compiler check failed" };
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
    console.error("[health] the emitter check threw", e);
    return { name: "Emitters", status: "unhealthy", message: "Emitter check failed" };
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
// getUsageMetrics — Admin only, uses Prisma aggregate queries
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

  const [totalEntities, totalFields, totalDomains, totalUsers] =
    await Promise.all([
      prisma.entity.count(),
      prisma.field.count(),
      prisma.domain.count(),
      prisma.user.count(),
    ]);

  // Count total emissions from emissionTargetStatus records with CURRENT status
  const totalEmissions = await prisma.emissionTargetStatus.count({
    where: { status: "CURRENT" },
  });

  return ok({
    totalEntities,
    totalFields,
    totalDomains,
    totalUsers,
    totalEmissions,
  });
}

// ---------------------------------------------------------------------------
// getActivityMetrics — Admin only, uses Prisma queries on audit_log
// ---------------------------------------------------------------------------

export async function getActivityMetrics(
  ctx: ServiceContext,
  /** The tenant being viewed: "Pending Governance" then counts the way the governance dashboard lists (requests of entities of that tenant). */
  tenantId?: string
): Promise<Result<ActivityMetrics>> {
  if (ctx.userRole !== "ADMIN") {
    return err({
      code: "FORBIDDEN",
      message: "Requires ADMIN role",
      suggestedFix: "Contact your administrator",
    });
  }

  const now = new Date();
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // Active users in last 24h — distinct userIds in audit_log
  const activeUsersResult = await prisma.auditLog.findMany({
    where: { timestamp: { gte: twentyFourHoursAgo } },
    select: { userId: true },
    distinct: ["userId"],
  });
  const activeUsers24h = activeUsersResult.length;

  // Emissions today: a schema version was generated (`generateSchemaAction` audits every successful generation as GENERATE).
  const emissionsToday = await prisma.auditLog.count({
    where: { action: "GENERATE", timestamp: { gte: startOfToday } },
  });

  // Schema changes today: an entity or a field was created, edited or deleted (the writers audit CREATE / UPDATE / DELETE).
  const schemaChangesToday = await prisma.auditLog.count({
    where: {
      action: { in: ["CREATE", "UPDATE", "DELETE"] },
      entityType: { in: ["Entity", "Field"] },
      timestamp: { gte: startOfToday },
    },
  });

  // Pending governance requests: the dashboard list's rule (tenant scoped, an entity that no longer exists does not count)
  const governanceRequestsPending = await countPendingRequests(tenantId);

  return ok({
    activeUsers24h,
    emissionsToday,
    schemaChangesToday,
    governanceRequestsPending,
  });
}

// ---------------------------------------------------------------------------
// getErrorSummary — Admin only, uses Prisma queries on audit_log
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

  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // Only failures the application records are counted: EMISSION_FAILED (a generation whose emission was invalid) and COMPILATION_ERROR
  // (the TypeSpec compiler refused a source). There is no count of API errors: nothing records one.
  const [compilationErrors24h, emissionValidationFailures24h] = await Promise.all([
    prisma.auditLog.count({ where: { action: "COMPILATION_ERROR", timestamp: { gte: twentyFourHoursAgo } } }),
    prisma.auditLog.count({ where: { action: "EMISSION_FAILED", timestamp: { gte: twentyFourHoursAgo } } }),
  ]);

  return ok({
    compilationErrors24h,
    emissionValidationFailures24h,
  });
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

  let actionFilter: Record<string, unknown>;
  if (errorType === "compilation") {
    actionFilter = { action: "COMPILATION_ERROR" };
  } else if (errorType === "emission") {
    actionFilter = { action: "EMISSION_FAILED" };
  } else {
    return ok([]);
  }

  const rows = await prisma.auditLog.findMany({
    where: actionFilter,
    orderBy: { timestamp: "desc" },
    take: 50,
  });

  return ok(
    rows.map((row) => ({
      id: row.id,
      action: row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      userId: row.userId,
      timestamp: row.timestamp,
      details: (row.afterState as Record<string, unknown>) ?? undefined,
    }))
  );
}
