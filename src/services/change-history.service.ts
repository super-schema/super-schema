/**
 * Change History Service
 *
 * Merges version snapshots (from entity metadata) and audit log entries
 * into a unified, sorted, filterable, paginated timeline.
 */

import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { withoutStoredSchemaVersions } from "@/lib/access/schema-version-redaction";
import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";
import type { VersionSnapshot } from "@/services/version-history/version.types";
import type {
  TimelineEntry,
  ChangeHistoryFilters,
  ChangeHistoryPage,
  ChangeType,
} from "@/types/schemas/change-history";

const DEFAULT_PAGE_SIZE = 50;

/**
 * A drag reorder of an entity's fields: the entity's own UPDATE entry carries the field order (`fieldOrder`) in its state.
 */
function isFieldReorder(action: string, entityType: string, afterState: unknown): boolean {
  return (
    action.toUpperCase() === "UPDATE" &&
    entityType === "Entity" &&
    afterState !== null &&
    typeof afterState === "object" &&
    Array.isArray((afterState as { fieldOrder?: unknown }).fieldOrder)
  );
}

/**
 * Infer the change type from an audit log action string.
 */
function inferChangeType(action: string, entityType: string, afterState: unknown): ChangeType {
  const a = action.toUpperCase();

  if (isFieldReorder(action, entityType, afterState)) return "field_edit";
  if (a === "CREATE_VERSION" || a.includes("VERSION")) return "version";
  if (a.includes("EMIT") || a === "GENERATE" || a === "EMISSION_FAILED") return "emission";
  if (a.includes("STATUS") || a.includes("DEPRECAT") || a.includes("RETIRE"))
    return "status_change";
  if (a.includes("DECORATOR")) return "decorator_change";
  if (
    entityType === "Field" ||
    a.includes("FIELD") ||
    a === "CREATE" ||
    a === "UPDATE" ||
    a === "DELETE"
  ) {
    if (entityType === "Field") return "field_edit";
  }
  if (a.includes("GOVERNANCE") || a.includes("OVERRIDE")) return "governance";

  return "other";
}

/**
 * Build a human-readable summary for an audit log entry.
 */
function buildAuditSummary(
  action: string,
  entityType: string,
  _beforeState: unknown,
  afterState: unknown
): string {
  const a = action.toUpperCase();

  if (a === "CREATE_VERSION") return "Created a new version snapshot";
  if (isFieldReorder(action, entityType, afterState)) return "Reordered fields";
  if (a === "CREATE" && entityType === "Field") return "Added a new field";
  if (a === "UPDATE" && entityType === "Field") return "Updated a field";
  if (a === "DELETE" && entityType === "Field") return "Deleted a field";
  if (a === "CREATE" && entityType === "Entity") return "Created entity";
  if (a === "UPDATE" && entityType === "Entity") return "Updated entity";
  if (a.includes("STATUS")) return "Changed entity status";
  if (a === "GENERATE") return "Generated a schema version";
  if (a === "EMISSION_FAILED") return "A schema generation failed";
  if (a === "COMPILATION_ERROR") return "The TypeSpec source did not compile";
  if (a.includes("EMIT")) return "Ran emission pipeline";

  return `${action} on ${entityType}`;
}

/**
 * Convert version snapshots into timeline entries.
 */
function versionSnapshotsToTimeline(
  versions: VersionSnapshot[]
): TimelineEntry[] {
  return versions.map((v) => {
    let summary = `Version v${v.version} created`;
    if (v.changeRecord && v.changeRecord.changes.length > 0) {
      const added = v.changeRecord.changes.filter(
        (c) => c.type === "added"
      ).length;
      const modified = v.changeRecord.changes.filter(
        (c) => c.type === "modified"
      ).length;
      const removed = v.changeRecord.changes.filter(
        (c) => c.type === "removed"
      ).length;
      const parts: string[] = [];
      if (added > 0) parts.push(`${added} field${added !== 1 ? "s" : ""} added`);
      if (modified > 0)
        parts.push(`${modified} field${modified !== 1 ? "s" : ""} modified`);
      if (removed > 0)
        parts.push(`${removed} field${removed !== 1 ? "s" : ""} removed`);
      summary = `Version v${v.version}: ${parts.join(", ")}`;
    }

    return {
      id: `version-${v.version}`,
      timestamp: v.timestamp,
      entryType: "version" as const,
      changeType: "version" as ChangeType,
      summary,
      userId: v.createdBy,
      versionNumber: v.version,
      changeRecord: v.changeRecord,
    };
  });
}

/**
 * Convert audit log records into timeline entries.
 */
function auditRecordsToTimeline(
  auditRecords: {
    id: string;
    action: string;
    entityType: string;
    entityId: string;
    userId: string;
    timestamp: Date;
    beforeState: unknown;
    afterState: unknown;
  }[]
): TimelineEntry[] {
  return auditRecords.map((a) => ({
    id: `audit-${a.id}`,
    timestamp: a.timestamp.toISOString(),
    entryType: "audit" as const,
    changeType: inferChangeType(a.action, a.entityType, a.afterState),
    summary: buildAuditSummary(
      a.action,
      a.entityType,
      a.beforeState,
      a.afterState
    ),
    userId: a.userId,
    action: a.action,
    entityType: a.entityType,
    // A state is the entity row as it was, and the row holds the stored generated schemas (the files of whole closures, a wider role's included): every
    // reader of the entity reads this log, so those stay out of it (KD-046). The log shows what changed, never the generated files.
    metadata: {
      entityId: a.entityId,
      beforeState: withoutStoredSchemaVersions(a.beforeState),
      afterState: withoutStoredSchemaVersions(a.afterState),
    },
  }));
}

/**
 * Apply filters to timeline entries.
 */
export function applyFilters(
  entries: TimelineEntry[],
  filters?: ChangeHistoryFilters
): TimelineEntry[] {
  if (!filters) return entries;

  let filtered = entries;

  if (filters.changeTypes && filters.changeTypes.length > 0) {
    filtered = filtered.filter((e) =>
      filters.changeTypes!.includes(e.changeType)
    );
  }

  if (filters.userId) {
    filtered = filtered.filter((e) => e.userId === filters.userId);
  }

  if (filters.dateFrom) {
    const from = filters.dateFrom.getTime();
    filtered = filtered.filter((e) => new Date(e.timestamp).getTime() >= from);
  }

  if (filters.dateTo) {
    const to = filters.dateTo.getTime();
    filtered = filtered.filter((e) => new Date(e.timestamp).getTime() <= to);
  }

  return filtered;
}

/**
 * Sort timeline entries by timestamp descending.
 */
export function sortByTimestampDesc(entries: TimelineEntry[]): TimelineEntry[] {
  return [...entries].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );
}

/**
 * Apply cursor-based pagination to sorted entries.
 */
export function paginate(
  entries: TimelineEntry[],
  cursor?: string,
  pageSize: number = DEFAULT_PAGE_SIZE
): ChangeHistoryPage {
  let startIndex = 0;

  if (cursor) {
    const cursorIndex = entries.findIndex((e) => e.id === cursor);
    if (cursorIndex >= 0) {
      startIndex = cursorIndex + 1;
    }
  }

  const page = entries.slice(startIndex, startIndex + pageSize);
  const hasMore = startIndex + pageSize < entries.length;
  const nextCursor = hasMore ? page[page.length - 1]?.id : undefined;

  return {
    entries: page,
    hasMore,
    nextCursor,
    totalCount: entries.length,
  };
}

/**
 * The audit rows about an entity, as its change log reads them. Its own rows carry its id. A field's rows carry the field's id (an edit, a
 * delete) or the placeholder "pending" (a create), so every field row is found through the entity its state names. The entity's own creation
 * carries the placeholder too, and its state names its id. Only the rows of the entity's tenant are read, and the rows no tenant owns (written
 * before the tenant column, or whose tenant could not be found when they were written).
 */
function entityAuditWhere(entityId: string, tenantId: string): Prisma.AuditLogWhereInput {
  return {
    AND: [
      { OR: [{ tenantId }, { tenantId: null }] },
      {
        OR: [
          { entityId },
          { entityType: "Field", beforeState: { path: ["entityId"], equals: entityId } },
          { entityType: "Field", afterState: { path: ["entityId"], equals: entityId } },
          { entityType: "Entity", entityId: "pending", afterState: { path: ["id"], equals: entityId } },
        ],
      },
    ],
  };
}

/**
 * Get the unified change history for an entity.
 *
 * Merges version snapshots from entity metadata and audit log entries,
 * applies filters and pagination, and returns a unified timeline.
 */
export async function getChangeHistory(
  entityId: string,
  _ctx: ServiceContext,
  filters?: ChangeHistoryFilters,
  cursor?: string,
  pageSize: number = DEFAULT_PAGE_SIZE
): Promise<Result<ChangeHistoryPage>> {
  // 1. Get version history from entity metadata
  const entity = await prisma.entity.findUnique({
    where: { id: entityId },
    select: { metadata: true, tenantId: true },
  });

  if (!entity) {
    return err({
      code: "NOT_FOUND",
      message: `Entity with ID "${entityId}" not found`,
      suggestedFix: "Verify the entity ID and try again.",
    });
  }

  const metadata = (entity.metadata as Record<string, unknown>) ?? {};
  const versionHistory = Array.isArray(metadata.versionHistory)
    ? (metadata.versionHistory as VersionSnapshot[])
    : [];

  const versionEntries = versionSnapshotsToTimeline(versionHistory);

  // 2. Get audit log entries — gracefully handle if table doesn't exist
  let auditEntries: TimelineEntry[] = [];
  try {
    const auditRecords = await prisma.auditLog.findMany({
      where: entityAuditWhere(entityId, entity.tenantId),
      // Rows written in the same millisecond are ordered by id, so the pages of the timeline neither repeat nor skip one.
      orderBy: [{ timestamp: "desc" }, { id: "desc" }],
    });
    auditEntries = auditRecordsToTimeline(auditRecords);
  } catch {
    // If audit_log table doesn't exist or query fails, fall back to version history only
    auditEntries = [];
  }

  // 3. Merge, deduplicate (skip audit entries that are version creation if we already have version entries),
  //    filter, sort, and paginate
  // Remove audit CREATE_VERSION entries to avoid duplication with version entries
  const dedupedAudit = auditEntries.filter(
    (a) => a.action !== "CREATE_VERSION"
  );

  const allEntries = [...versionEntries, ...dedupedAudit];
  const sorted = sortByTimestampDesc(allEntries);
  const filtered = applyFilters(sorted, filters);
  const page = paginate(filtered, cursor, pageSize);

  return ok(page);
}
