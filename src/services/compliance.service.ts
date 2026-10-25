import { prisma } from "@/lib/db";
import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";
import type {
  ComplianceFilter,
  Pagination,
  ComplianceFieldResult,
  ComplianceGap,
  GapSummary,
  GapFilter,
  AuditTrailFilter,
  AuditPagination,
  AuditTrailEntry,
} from "@/types/schemas/compliance";
import { domainLabel } from "@/lib/entity-placement";

// ============================================================
// RBAC helpers
// ============================================================

const COMPLIANCE_ROLES = ["COMPLIANCE_OFFICER", "STEWARD", "ADMIN", "AUTHOR"];

function assertComplianceRole(ctx: ServiceContext): Result<void> {
  if (!COMPLIANCE_ROLES.includes(ctx.userRole)) {
    return err({
      code: "FORBIDDEN",
      message: "Insufficient permissions — requires Compliance Officer, Steward, or Admin role",
    });
  }
  return ok(undefined as unknown as void);
}

/**
 * An unexpected failure of a query: the details (a driver error carries the invocation, the source path and the offending value) are logged
 * server-side under the service's name, and the caller gets fixed words.
 */
function internalFailure(service: string, message: string, cause: unknown): Result<never> {
  console.error(`[compliance.${service}] unexpected error`, cause);
  return err({ code: "INTERNAL_ERROR", message });
}

// ============================================================
// Story 6.1 — queryFields
// ============================================================

export async function queryFields(
  filters: ComplianceFilter = {},
  pagination: Pagination = { page: 1, pageSize: 25, sortBy: "entityName", sortOrder: "asc" },
  ctx: ServiceContext
): Promise<Result<{ fields: ComplianceFieldResult[]; total: number }>> {
  const roleCheck = assertComplianceRole(ctx);
  if (!roleCheck.success) return roleCheck as Result<never>;

  try {
    // Build where clause
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = {};
    const entityWhere: Record<string, unknown> = {};

    // Domain filter
    if (filters.domains && filters.domains.length > 0) {
      entityWhere.domainId = { in: filters.domains };
    }

    // Text search — across entity name, field name, description
    if (filters.textSearch && filters.textSearch.trim()) {
      const q = filters.textSearch.trim();
      where.OR = [
        { name: { contains: q, mode: "insensitive" } },
        { description: { contains: q, mode: "insensitive" } },
        { entity: { name: { contains: q, mode: "insensitive" } } },
      ];
    }

    // Classification filter
    if (filters.classifications && filters.classifications.length > 0) {
      where.classification = { in: filters.classifications };
    }

    // The tenant being viewed (a field has no tenant of its own: its entity does)
    if (ctx.tenantId !== undefined) entityWhere.tenantId = ctx.tenantId;

    // Entity-level filters
    if (Object.keys(entityWhere).length > 0) {
      where.entity = { ...where.entity, ...entityWhere };
    }

    // Get total count
    const total = await prisma.field.count({ where });

    // Build orderBy
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let orderBy: any;
    switch (pagination.sortBy) {
      case "entityName":
        orderBy = { entity: { name: pagination.sortOrder } };
        break;
      case "fieldName":
        orderBy = { name: pagination.sortOrder };
        break;
      case "fieldType":
        orderBy = { type: pagination.sortOrder };
        break;
      case "classification":
        orderBy = { classification: pagination.sortOrder };
        break;
      case "domain":
        orderBy = { entity: { domain: { name: pagination.sortOrder } } };
        break;
      default:
        orderBy = { entity: { name: pagination.sortOrder } };
    }

    const skip = (pagination.page - 1) * pagination.pageSize;

    const fields = await prisma.field.findMany({
      where,
      include: {
        entity: {
          include: {
            domain: true,
            product: true,
          },
        },
      },
      orderBy,
      skip,
      take: pagination.pageSize,
    });

    const results: ComplianceFieldResult[] = fields
      .map((f) => {
        const decorators = (f.decorators || {}) as Record<string, unknown>;
        const policy = (decorators.policy || {}) as Record<string, string>;
        const classification =
          f.classification ||
          ((decorators.classification as Record<string, string>)?.level ?? null);

        return {
          entityId: f.entity.id,
          entityName: f.entity.name,
          entitySlug: f.entity.slug,
          domainSlug: f.entity.domain?.slug ?? null,
          productSlug: f.entity.product?.slug ?? null,
          fieldId: f.id,
          fieldName: f.name,
          fieldType: f.type,
          classification,
          retention: policy.retention || null,
          anonymization: policy.anonymization || null,
          encryption: policy.encryption || null,
          targetSystems: [] as string[],
          domain: domainLabel(f.entity.domain),
          domainId: f.entity.domain?.id ?? null,
        };
      })
      .filter((r) => {
        // Post-filter for JSONB-based filters (retention, anonymization, encryption)
        if (
          filters.retention &&
          filters.retention !== "any" &&
          !matchRetention(r.retention, filters.retention)
        ) {
          return false;
        }
        if (
          filters.anonymization &&
          filters.anonymization !== "any" &&
          r.anonymization !== filters.anonymization
        ) {
          return false;
        }
        if (
          filters.encryption &&
          filters.encryption !== "any" &&
          r.encryption !== filters.encryption
        ) {
          return false;
        }
        return true;
      });

    return ok({ fields: results, total });
  } catch (e: unknown) {
    return internalFailure("queryFields", "Failed to query fields", e);
  }
}

function matchRetention(
  retention: string | null,
  range: string
): boolean {
  if (!retention) return false;
  // Parse retention like "1 year", "3 years", "6 months", "90 days", etc.
  const years = parseRetentionToYears(retention);
  if (years === null) return false;
  switch (range) {
    case "lt_1_year":
      return years < 1;
    case "1_to_3_years":
      return years >= 1 && years <= 3;
    case "3_to_7_years":
      return years > 3 && years <= 7;
    case "gt_7_years":
      return years > 7;
    default:
      return true;
  }
}

export function parseRetentionToYears(retention: string | Record<string, unknown>): number | null {
  // Handle structured RetentionPolicy object
  if (typeof retention === "object" && retention !== null) {
    const policy = retention as { strategy?: string; period?: number; periodUnit?: string };
    if (policy.strategy === "indefinite") return null;
    if (!policy.period || !policy.periodUnit) return null;
    switch (policy.periodUnit) {
      case "years": return policy.period;
      case "months": return policy.period / 12;
      case "days": return policy.period / 365;
      default: return null;
    }
  }

  // Handle legacy string format
  const lower = (retention as string).toLowerCase().trim();
  // Handle compact format: "30d", "90d", "1y"
  const compactMatch = lower.match(/^(\d+)(d|y)$/);
  if (compactMatch) {
    const num = parseInt(compactMatch[1], 10);
    return compactMatch[2] === "y" ? num : num / 365;
  }
  // Handle verbose format: "1 year", "90 days"
  const match = lower.match(/^(\d+)\s*(year|yr|month|mo|day|d)s?$/);
  if (!match) return null;
  const num = parseInt(match[1], 10);
  const unit = match[2];
  if (unit.startsWith("year") || unit.startsWith("yr")) return num;
  if (unit.startsWith("month") || unit === "mo") return num / 12;
  if (unit.startsWith("day") || unit === "d") return num / 365;
  return null;
}

// ============================================================
// Story 6.2 — detectGaps
// ============================================================

const SUGGESTED_FIXES: Record<string, string> = {
  PII_NO_ANONYMIZATION:
    "Set anonymization policy for PII field (hash, mask, redact, or pseudonymize)",
  SENSITIVE_NO_ENCRYPTION:
    "Enable encryption for SENSITIVE field (AES-256 or field-level)",
  UNCLASSIFIED:
    "Add classification to field (PII, SENSITIVE, INTERNAL, or PUBLIC)",
  NO_RETENTION:
    "Define retention policy for classified field",
};

export async function detectGaps(
  filters: GapFilter = {},
  ctx: ServiceContext
): Promise<Result<{ gaps: ComplianceGap[]; summary: GapSummary }>> {
  const roleCheck = assertComplianceRole(ctx);
  if (!roleCheck.success) return roleCheck as Result<never>;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = {};

    const entityWhere: Record<string, unknown> = {};
    if (filters.domains && filters.domains.length > 0) entityWhere.domainId = { in: filters.domains };
    // The tenant being viewed (a field has no tenant of its own: its entity does)
    if (ctx.tenantId !== undefined) entityWhere.tenantId = ctx.tenantId;
    if (Object.keys(entityWhere).length > 0) where.entity = entityWhere;
    if (filters.entities && filters.entities.length > 0) {
      where.entityId = { in: filters.entities };
    }

    const allFields = await prisma.field.findMany({
      where,
      include: {
        entity: { include: { domain: true, product: true } },
      },
    });

    const gaps: ComplianceGap[] = [];

    for (const field of allFields) {
      const decorators = (field.decorators || {}) as Record<string, unknown>;
      const classificationObj = (decorators.classification || {}) as Record<
        string,
        string
      >;
      const policyObj = (decorators.policy || {}) as Record<string, string>;
      const classLevel =
        field.classification || classificationObj.level || null;

      const entityMeta = {
        entityId: field.entity.id,
        entityName: field.entity.name,
        entitySlug: field.entity.slug,
        domainSlug: field.entity.domain?.slug ?? null,
        productSlug: field.entity.product?.slug ?? null,
      };

      // Unclassified
      if (!classLevel) {
        gaps.push({
          ...entityMeta,
          fieldId: field.id,
          fieldName: field.name,
          gapType: "UNCLASSIFIED",
          severity: "CRITICAL",
          suggestedFix: SUGGESTED_FIXES.UNCLASSIFIED,
        });
        continue; // Skip further checks for unclassified
      }

      // PII without anonymization
      if (
        classLevel === "PII" &&
        (!policyObj.anonymization || policyObj.anonymization === "none")
      ) {
        gaps.push({
          ...entityMeta,
          fieldId: field.id,
          fieldName: field.name,
          gapType: "PII_NO_ANONYMIZATION",
          severity: "CRITICAL",
          suggestedFix: SUGGESTED_FIXES.PII_NO_ANONYMIZATION,
        });
      }

      // SENSITIVE without encryption
      if (
        classLevel === "SENSITIVE" &&
        (!policyObj.encryption || policyObj.encryption === "none")
      ) {
        gaps.push({
          ...entityMeta,
          fieldId: field.id,
          fieldName: field.name,
          gapType: "SENSITIVE_NO_ENCRYPTION",
          severity: "WARNING",
          suggestedFix: SUGGESTED_FIXES.SENSITIVE_NO_ENCRYPTION,
        });
      }

      // PII or SENSITIVE without retention
      if (
        (classLevel === "PII" || classLevel === "SENSITIVE") &&
        !policyObj.retention
      ) {
        gaps.push({
          ...entityMeta,
          fieldId: field.id,
          fieldName: field.name,
          gapType: "NO_RETENTION",
          severity: "WARNING",
          suggestedFix: SUGGESTED_FIXES.NO_RETENTION,
        });
      }
    }

    // Compute summary
    const affectedEntityIds = new Set(gaps.map((g) => g.entityId));
    const countsByGapType: Record<string, number> = {};
    let criticalCount = 0;
    let warningCount = 0;

    for (const gap of gaps) {
      countsByGapType[gap.gapType] = (countsByGapType[gap.gapType] || 0) + 1;
      if (gap.severity === "CRITICAL") criticalCount++;
      else warningCount++;
    }

    return ok({
      gaps,
      summary: {
        criticalCount,
        warningCount,
        affectedEntityCount: affectedEntityIds.size,
        countsByGapType,
      },
    });
  } catch (e: unknown) {
    return internalFailure("detectGaps", "Failed to detect gaps", e);
  }
}

// ============================================================
// Story 6.5 — queryAuditTrail
// ============================================================

export function generateChangeSummary(
  beforeState: unknown,
  afterState: unknown
): string {
  if (!beforeState && !afterState) return "No changes recorded";
  if (!beforeState) return "Created new record";
  if (!afterState) return "Deleted record";

  const before =
    typeof beforeState === "object" && beforeState !== null
      ? (beforeState as Record<string, unknown>)
      : {};
  const after =
    typeof afterState === "object" && afterState !== null
      ? (afterState as Record<string, unknown>)
      : {};

  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changedKeys: string[] = [];

  for (const key of allKeys) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      changedKeys.push(key);
    }
  }

  if (changedKeys.length === 0) return "No fields changed";
  return `Updated ${changedKeys.length} field${changedKeys.length > 1 ? "s" : ""}: ${changedKeys.join(", ")}`;
}

export async function queryAuditTrail(
  filters: AuditTrailFilter = {},
  pagination: AuditPagination = { page: 1, pageSize: 50 },
  ctx: ServiceContext
): Promise<Result<{ entries: AuditTrailEntry[]; total: number }>> {
  const roleCheck = assertComplianceRole(ctx);
  if (!roleCheck.success) return roleCheck as Result<never>;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = {};

    if (filters.actionTypes && filters.actionTypes.length > 0) {
      where.action = { in: filters.actionTypes };
    }
    if (filters.userId) {
      where.userId = filters.userId;
    }
    if (filters.entityType) {
      where.entityType = filters.entityType;
    }
    if (filters.entityName) {
      where.entityId = { contains: filters.entityName, mode: "insensitive" };
    }
    if (filters.dateRange) {
      where.timestamp = {};
      if (filters.dateRange.from) {
        where.timestamp.gte = filters.dateRange.from;
      }
      if (filters.dateRange.to) {
        where.timestamp.lte = filters.dateRange.to;
      }
    }

    const total = await prisma.auditLog.count({ where });

    const skip = (pagination.page - 1) * pagination.pageSize;

    const entries = await prisma.auditLog.findMany({
      where,
      include: {
        user: { select: { id: true, name: true, image: true } },
      },
      orderBy: { timestamp: "desc" },
      skip,
      take: pagination.pageSize,
    });

    const mapped: AuditTrailEntry[] = entries.map((entry) => ({
      id: entry.id,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      entityName: null, // Would need entity lookup — simplified
      userId: entry.userId,
      userName: entry.user?.name || null,
      userAvatar: entry.user?.image || null,
      timestamp: entry.timestamp,
      beforeState: entry.beforeState,
      afterState: entry.afterState,
      changeSummary: generateChangeSummary(entry.beforeState, entry.afterState),
    }));

    return ok({ entries: mapped, total });
  } catch (e: unknown) {
    return internalFailure("queryAuditTrail", "Failed to query audit trail", e);
  }
}

export async function exportAuditTrail(
  filters: AuditTrailFilter = {},
  ctx: ServiceContext
): Promise<Result<AuditTrailEntry[]>> {
  const result = await queryAuditTrail(
    filters,
    { page: 1, pageSize: 10000 },
    ctx
  );
  if (!result.success) return result as Result<never>;
  return ok(result.data.entries);
}
