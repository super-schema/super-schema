import { prisma } from "@/lib/db";
import { can, ctxCan, readableScopes, type ActionId } from "@/lib/access";
import { withAudit } from "@/lib/audit";
import { fieldProtection, isMethod, type FieldProtection } from "@/lib/compliance/field-protection";
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
  AuditExportEntry,
} from "@/types/schemas/compliance";
import { MAX_EXPORT_ROWS } from "@/types/schemas/compliance";
import { domainLabel } from "@/lib/entity-placement";

export { parseRetentionToYears } from "@/lib/compliance/field-protection";

// ============================================================
// Access: the policy over the caller's assignments (no role names here)
// ============================================================

type ComplianceAction = Extract<ActionId, "compliance.query" | "compliance.gaps" | "compliance.audit">;

const FORBIDDEN = { code: "FORBIDDEN", message: "You do not have permission to do this" } as const;

/** The tenant a context with no tenant in view is judged over: no tenant has this id, so only a GLOBAL role (a platform administrator) covers it. */
const NO_TENANT = "-";

/**
 * Tenant-wide access (the audit trail and its export): `action` must be held over the TENANT as a whole (a tenant or global role). A domain-
 * or product-scoped role does not reach it. With no tenant in view (`ctx.tenantId` absent) only a platform administrator passes.
 */
function assertComplianceTenant(ctx: ServiceContext, action: ComplianceAction): Result<void> {
  return can([...(ctx.assignments ?? [])], action, { tenantId: ctx.tenantId ?? NO_TENANT }) ? ok(undefined as unknown as void) : err({ ...FORBIDDEN });
}

/**
 * Access to the FIELDS of the entities of the tenant in view (Query and Gaps, judged per entity, and the Query's export, which is the same
 * decision): a role over the whole tenant reads them all, a domain- or product-scoped one only the entities under its domains and products
 * (`entityRestriction`, applied in the query), one that reaches none is refused. With no tenant in view only a platform administrator passes,
 * over every entity.
 */
function complianceEntityScope(ctx: ServiceContext, action: ComplianceAction): Result<{ entityRestriction: Record<string, unknown> | null }> {
  const assignments = [...(ctx.assignments ?? [])];
  if (ctx.tenantId === undefined) {
    return can(assignments, action, { tenantId: NO_TENANT }) ? ok({ entityRestriction: null }) : err({ ...FORBIDDEN });
  }
  const scopes = readableScopes(assignments, action, ctx.tenantId);
  if (scopes.all) return ok({ entityRestriction: null });
  if (scopes.domainIds.length === 0 && scopes.productIds.length === 0) return err({ ...FORBIDDEN });
  return ok({ entityRestriction: { OR: [{ domainId: { in: scopes.domainIds } }, { productId: { in: scopes.productIds } }] } });
}

/**
 * An unexpected failure of a query: the details (a driver error carries the invocation, the source path and the offending value) are logged
 * server-side under the service's name, and the caller gets fixed words.
 */
function internalFailure(service: string, message: string, cause: unknown): Result<never> {
  console.error(`[compliance.${service}] unexpected error`, cause);
  return err({ code: "INTERNAL_ERROR", message });
}

/** What an export audit entry records: how many rows went out, of how many, and the filters that chose them (as JSON, the way the audit row stores them). */
function exportRecord(rows: number, total: number, truncated: boolean, filters: unknown) {
  return { rows, total, truncated, filters: JSON.parse(JSON.stringify(filters)) as unknown };
}

const recordOf = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});

// ============================================================
// Story 6.1 — queryFields (and its export)
// ============================================================

/** A field as the queries read it: the field, and its entity placed in a domain and a product, with the entity's metadata (its retention policy). */
type FieldRow = {
  id: string;
  name: string;
  type: string;
  classification: string | null;
  decorators: unknown;
  entity: {
    id: string;
    name: string;
    slug: string;
    metadata: unknown;
    domain: { id: string; name: string; slug: string } | null;
    product: { slug: string } | null;
  };
};

/** The whole of a field row, its entity placed. */
const FIELD_INCLUDE = { entity: { include: { domain: true, product: true } } } as const;

/** What a protection filter reads of each candidate: the values it judges and the entity they are in (the entity's metadata is read once, apart). */
const CANDIDATE_SELECT = { id: true, decorators: true, entityId: true } as const;

/**
 * The database filter of a field query: the entities the caller's roles cover (`entityRestriction`), the tenant in view, and the domain, text and
 * classification filters. The protection filters (retention, anonymization, encryption) are not in it: they are judged on the stored values.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fieldWhere(filters: ComplianceFilter, entityRestriction: Record<string, unknown> | null, tenantId: string | undefined): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: any = {};
  const entityWhere: Record<string, unknown> = {};
  // Only the entities the caller's roles cover (a domain- or product-scoped caller; absent for a tenant-wide role)
  if (entityRestriction) entityWhere.AND = [entityRestriction];

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

  // Classification filter: the column, or for a row with no column value the level its decorators carry (the legacy shape that the column and the
  // Gaps rule read), so that the filter finds every row the list shows a classification for.
  if (filters.classifications && filters.classifications.length > 0) {
    const levels = filters.classifications;
    where.AND = [
      ...(where.AND ?? []),
      {
        OR: [
          { classification: { in: levels } },
          { classification: null, OR: levels.map((level) => ({ decorators: { path: ["classification", "level"], equals: level } })) },
        ],
      },
    ];
  }

  // The tenant being viewed (a field has no tenant of its own: its entity does)
  if (tenantId !== undefined) entityWhere.tenantId = tenantId;

  if (Object.keys(entityWhere).length > 0) {
    where.entity = entityWhere;
  }
  return where;
}

/** The order of a field list: its sort, then the field's id, so that the rows that tie on the sort key come in one order on every page. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fieldOrderBy(sortBy: string, sortOrder: "asc" | "desc"): any[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let primary: any;
  switch (sortBy) {
    case "entityName":
      primary = { entity: { name: sortOrder } };
      break;
    case "fieldName":
      primary = { name: sortOrder };
      break;
    case "fieldType":
      primary = { type: sortOrder };
      break;
    case "classification":
      primary = { classification: sortOrder };
      break;
    case "domain":
      primary = { entity: { domain: { name: sortOrder } } };
      break;
    default:
      primary = { entity: { name: sortOrder } };
  }
  return [primary, { id: "asc" }];
}

/** A filter that names a value: present and not "any". */
const isFilterSet = (value: string | undefined): value is string => value !== undefined && value !== "" && value !== "any";

/** Whether a protection filter narrows the query. Those are judged on the stored values, so the database does not count or page for them. */
function hasProtectionFilter(filters: ComplianceFilter): boolean {
  return isFilterSet(filters.retention) || isFilterSet(filters.anonymization) || isFilterSet(filters.encryption);
}

/** Whether a retention of `years` (`null`: indefinite, unset or unreadable, which is in no range) is in the range the filter names. */
function matchRetention(years: number | null, range: string): boolean {
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

function matchesProtection(protection: FieldProtection, filters: ComplianceFilter): boolean {
  if (isFilterSet(filters.retention) && !matchRetention(protection.retentionYears, filters.retention)) return false;
  if (isFilterSet(filters.anonymization) && !isMethod(protection.anonymization, filters.anonymization)) return false;
  if (isFilterSet(filters.encryption) && !isMethod(protection.encryption, filters.encryption)) return false;
  return true;
}

/**
 * The fields `where` selects, in `orderBy`: `take` of them from `skip`, and how many are selected in all.
 *
 * Without a protection filter the database counts and pages, as it always did. A protection filter is judged on values the database does not
 * filter (the entity's retention policy, the field's decorators). Then every candidate of the scope is read with those values alone (the entities'
 * metadata once per entity, not once per field), the matches are counted, and only the page's rows are read in full by id, so the total, the pages
 * and the rows all come from one filtered set. The cost is that every request reads all the candidates of the caller's scope (as the Gaps tab does).
 */
async function selectFields(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  where: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  orderBy: any[],
  filters: ComplianceFilter,
  skip: number,
  take: number
): Promise<{ total: number; rows: FieldRow[] }> {
  if (!hasProtectionFilter(filters)) {
    const total = await prisma.field.count({ where });
    const rows = await prisma.field.findMany({ where, include: FIELD_INCLUDE, orderBy, skip, take });
    return { total, rows };
  }

  const candidates = await prisma.field.findMany({ where, orderBy, select: CANDIDATE_SELECT });
  // The entities in the scope of the fields (`where.entity`, the same scope): each candidate's entity is one of them.
  const entities = await prisma.entity.findMany({ where: where.entity ?? {}, select: { id: true, metadata: true } });
  const metadataOf = new Map(entities.map((entity) => [entity.id, entity.metadata]));
  const matching = candidates
    .filter((candidate) => matchesProtection(fieldProtection(candidate.decorators, metadataOf.get(candidate.entityId)), filters))
    .map((candidate) => candidate.id);
  const ids = matching.slice(skip, skip + take);
  if (ids.length === 0) return { total: matching.length, rows: [] };

  const found = await prisma.field.findMany({ where: { id: { in: ids } }, include: FIELD_INCLUDE });
  const byId = new Map(found.map((row) => [row.id, row]));
  const rows: FieldRow[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (row) rows.push(row);
  }
  return { total: matching.length, rows };
}

function toFieldResult(f: FieldRow): ComplianceFieldResult {
  const decorators = recordOf(f.decorators);
  const protection = fieldProtection(f.decorators, f.entity.metadata);
  const classification = f.classification || ((decorators.classification as Record<string, string>)?.level ?? null);

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
    retention: protection.retention,
    anonymization: protection.anonymization,
    encryption: protection.encryption,
    targetSystems: [] as string[],
    domain: domainLabel(f.entity.domain),
    domainId: f.entity.domain?.id ?? null,
  };
}

export async function queryFields(
  filters: ComplianceFilter = {},
  pagination: Pagination = { page: 1, pageSize: 25, sortBy: "entityName", sortOrder: "asc" },
  ctx: ServiceContext
): Promise<Result<{ fields: ComplianceFieldResult[]; total: number }>> {
  const scope = complianceEntityScope(ctx, "compliance.query");
  if (!scope.success) return scope as Result<never>;

  try {
    const where = fieldWhere(filters, scope.data.entityRestriction, ctx.tenantId);
    const skip = (pagination.page - 1) * pagination.pageSize;
    const { total, rows } = await selectFields(where, fieldOrderBy(pagination.sortBy, pagination.sortOrder), filters, skip, pagination.pageSize);
    return ok({ fields: rows.map(toFieldResult), total });
  } catch (e: unknown) {
    return internalFailure("queryFields", "Failed to query fields", e);
  }
}

/** The export of the Query tab: what `queryFields` lists, for every page of it, up to `MAX_EXPORT_ROWS`. `truncated`: more matched than were exported. */
export type FieldExport = { fields: ComplianceFieldResult[]; total: number; truncated: boolean };

/** The fields the filters select, in the sort the list uses, the whole set up to `MAX_EXPORT_ROWS`. Decided as the list is (`compliance.query`). */
export async function exportFields(
  filters: ComplianceFilter = {},
  sort: { sortBy: string; sortOrder: "asc" | "desc" } = { sortBy: "entityName", sortOrder: "asc" },
  ctx: ServiceContext
): Promise<Result<FieldExport>> {
  const scope = complianceEntityScope(ctx, "compliance.query");
  if (!scope.success) return scope as Result<never>;

  try {
    const where = fieldWhere(filters, scope.data.entityRestriction, ctx.tenantId);
    const { total, rows } = await selectFields(where, fieldOrderBy(sort.sortBy, sort.sortOrder), filters, 0, MAX_EXPORT_ROWS);
    const fields = rows.map(toFieldResult);
    const truncated = total > fields.length;
    await withAudit({
      action: "compliance.export",
      entityType: "Compliance",
      entityId: "fields",
      userId: ctx.userId,
      tenantId: ctx.tenantId ?? null,
      fn: async () => exportRecord(fields.length, total, truncated, filters),
    });
    return ok({ fields, total, truncated });
  } catch (e: unknown) {
    return internalFailure("exportFields", "Failed to export fields", e);
  }
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
  const scope = complianceEntityScope(ctx, "compliance.gaps");
  if (!scope.success) return scope as Result<never>;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = {};

    const entityWhere: Record<string, unknown> = {};
    if (scope.data.entityRestriction) entityWhere.AND = [scope.data.entityRestriction];
    if (filters.domains && filters.domains.length > 0) entityWhere.domainId = { in: filters.domains };
    // The tenant being viewed (a field has no tenant of its own: its entity does)
    if (ctx.tenantId !== undefined) entityWhere.tenantId = ctx.tenantId;
    if (Object.keys(entityWhere).length > 0) where.entity = entityWhere;
    if (filters.entities && filters.entities.length > 0) {
      where.entityId = { in: filters.entities };
    }

    const allFields = await prisma.field.findMany({ where, include: FIELD_INCLUDE });

    const gaps: ComplianceGap[] = [];

    for (const field of allFields) {
      const decorators = (field.decorators || {}) as Record<string, unknown>;
      const classificationObj = (decorators.classification || {}) as Record<
        string,
        string
      >;
      const classLevel =
        field.classification || classificationObj.level || null;
      // What the product stores for the field: its Data Protection values, and the retention of its entity (see field-protection.ts).
      const protection = fieldProtection(field.decorators, field.entity.metadata);

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
      if (classLevel === "PII" && isMethod(protection.anonymization, "none")) {
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
      if (classLevel === "SENSITIVE" && isMethod(protection.encryption, "none")) {
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
      if ((classLevel === "PII" || classLevel === "SENSITIVE") && protection.retention === null) {
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
// Story 6.5 — queryAuditTrail (and its export)
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
  const access = assertComplianceTenant(ctx, "compliance.audit");
  if (!access.success) return access as Result<never>;
  return readAuditTrail(filters, pagination, auditTenantScope(ctx), { service: "queryAuditTrail", message: "Failed to query audit trail" });
}

/**
 * Whose audit rows the caller reads (KD-016): the entries of the tenant in view (`audit_log.tenantId`, written by `withAudit`), nothing of another
 * tenant's. Rows no tenant owns (`tenantId` NULL: written before the column existed and not derivable from their row, or about the platform: a
 * user, the git connection) are the platform administrators' to read, so they are added for them and for nobody else. With no tenant in view only a
 * platform administrator got this far (`assertComplianceTenant`), and reads every row.
 */
function auditTenantScope(ctx: ServiceContext): Record<string, unknown> {
  if (ctx.tenantId === undefined) return {};
  return ctxCan(ctx, "platform.admin") ? { OR: [{ tenantId: ctx.tenantId }, { tenantId: null }] } : { tenantId: ctx.tenantId };
}

/**
 * The database filter of the audit trail: the scope, then each filter. The date range is `from` inclusive and `to` EXCLUSIVE: the screen sends the
 * start of the day after the last day it shows, so that the whole day is in (`lte` would drop everything after midnight of that day).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function auditWhere(filters: AuditTrailFilter, scope: Record<string, unknown>): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: any = { ...scope };

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
    const timestamp: Record<string, Date> = {};
    if (filters.dateRange.from) timestamp.gte = filters.dateRange.from;
    if (filters.dateRange.to) timestamp.lt = filters.dateRange.to;
    if (Object.keys(timestamp).length > 0) where.timestamp = timestamp;
  }
  return where;
}

/** The name a failure is logged under, and the fixed words its caller is answered with (the list and the export say their own). */
type FailureLabel = { service: string; message: string };

/**
 * The audit trail itself, after the caller's access was decided (`compliance.audit`) and its scope (`auditTenantScope`). The newest first, and the
 * id breaks a tie in the timestamp, so that rows written in the same instant page in one order.
 */
async function readAuditTrail(
  filters: AuditTrailFilter,
  pagination: AuditPagination,
  scope: Record<string, unknown>,
  failure: FailureLabel
): Promise<Result<{ entries: AuditTrailEntry[]; total: number }>> {
  try {
    const where = auditWhere(filters, scope);

    const total = await prisma.auditLog.count({ where });

    const skip = (pagination.page - 1) * pagination.pageSize;

    const entries = await prisma.auditLog.findMany({
      where,
      include: {
        user: { select: { id: true, name: true, image: true } },
      },
      orderBy: [{ timestamp: "desc" }, { id: "desc" }],
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
    return internalFailure(failure.service, failure.message, e);
  }
}

/** The export of the Audit Trail: every entry of the filter up to `MAX_EXPORT_ROWS`, as its file holds them. `truncated`: more matched than were exported. */
export type AuditExport = { entries: AuditExportEntry[]; total: number; truncated: boolean };

/** The entries the filters select, up to `MAX_EXPORT_ROWS`. Decided as the list is (`compliance.audit`: the tenant as a whole). */
export async function exportAuditTrail(
  filters: AuditTrailFilter = {},
  ctx: ServiceContext
): Promise<Result<AuditExport>> {
  const access = assertComplianceTenant(ctx, "compliance.audit");
  if (!access.success) return access as Result<never>;
  // A failed read is an export that failed: logged and answered as one (the list's words would say a query failed).
  const result = await readAuditTrail(filters, { page: 1, pageSize: MAX_EXPORT_ROWS }, auditTenantScope(ctx), {
    service: "exportAuditTrail",
    message: "Failed to export the audit trail",
  });
  if (!result.success) return result as Result<never>;

  const { total } = result.data;
  const entries: AuditExportEntry[] = result.data.entries.map((entry) => ({
    timestamp: entry.timestamp,
    userName: entry.userName,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId,
    changeSummary: entry.changeSummary,
  }));
  const truncated = total > entries.length;
  try {
    await withAudit({
      action: "compliance.export",
      entityType: "Compliance",
      entityId: "audit-trail",
      userId: ctx.userId,
      tenantId: ctx.tenantId ?? null,
      fn: async () => exportRecord(entries.length, total, truncated, filters),
    });
    return ok({ entries, total, truncated });
  } catch (e: unknown) {
    return internalFailure("exportAuditTrail", "Failed to export the audit trail", e);
  }
}
