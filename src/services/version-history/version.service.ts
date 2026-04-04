/**
 * Version History Service
 *
 * MVP: Stores version snapshots in entity metadata JSONB under `versionHistory` key.
 * No Prisma migration required.
 */

import { prisma } from "@/lib/db";
import { withAudit } from "@/lib/audit";
import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import type { Prisma } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import type {
  VersionSnapshot,
  VersionDiff,
  FieldSnapshot,
  EntitySnapshot,
  ChangeRecord,
  DiffResult,
} from "./version.types";
import { computeFieldDiff, computeDiffResult } from "@/lib/diff/field-diff";

/**
 * Extract version history array from entity metadata.
 */
function getVersionHistoryFromMetadata(
  metadata: Record<string, unknown> | null
): VersionSnapshot[] {
  if (!metadata) return [];
  const history = metadata.versionHistory;
  if (!Array.isArray(history)) return [];
  return history as VersionSnapshot[];
}

/**
 * Build a field snapshot from a database field record.
 */
function toFieldSnapshot(field: {
  id: string;
  name: string;
  type: string;
  precision: number | null;
  scale: number | null;
  nullable: boolean;
  isKey: boolean;
  fieldNumber: number | null;
  description: string;
  classification: string | null;
  aliases: string[];
  decorators: unknown;
  sortOrder: number;
}): FieldSnapshot {
  return {
    id: field.id,
    name: field.name,
    type: field.type,
    precision: field.precision,
    scale: field.scale,
    nullable: field.nullable,
    isKey: field.isKey,
    fieldNumber: field.fieldNumber,
    description: field.description,
    classification: field.classification,
    aliases: field.aliases,
    decorators: (field.decorators as Record<string, unknown>) ?? {},
    sortOrder: field.sortOrder,
  };
}

/**
 * Build an entity snapshot from a database entity record.
 */
function toEntitySnapshot(entity: {
  id: string;
  name: string;
  description: string;
  status: string;
  version: number;
  domainId: string;
  metadata: unknown;
}): EntitySnapshot {
  return {
    id: entity.id,
    name: entity.name,
    description: entity.description,
    status: entity.status,
    version: entity.version,
    domainId: entity.domainId,
    metadata: (entity.metadata as Record<string, unknown>) ?? null,
  };
}

/**
 * Create a new version snapshot for an entity.
 *
 * Captures current entity + fields state, computes diff against previous version,
 * increments the entity version number, and stores the snapshot in metadata JSONB.
 */
export async function createSnapshot(
  entityId: string,
  ctx: ServiceContext
): Promise<Result<VersionSnapshot>> {
  // Fetch entity with fields
  const entity = await prisma.entity.findUnique({
    where: { id: entityId },
    include: {
      fields: { orderBy: { sortOrder: "asc" } },
    },
  });

  if (!entity) {
    return err({
      code: "NOT_FOUND",
      message: `Entity with ID "${entityId}" not found`,
      suggestedFix: "Verify the entity ID and try again.",
    });
  }

  const metadata = (entity.metadata as Record<string, unknown>) ?? {};
  const existingHistory = getVersionHistoryFromMetadata(metadata);

  // Determine new version number
  const newVersionNumber =
    existingHistory.length > 0
      ? Math.max(...existingHistory.map((v) => v.version)) + 1
      : 1;

  // Build current snapshot
  const currentFields = entity.fields.map(toFieldSnapshot);

  // Strip versionHistory from the entity snapshot metadata to avoid recursion
  const snapshotMetadata = { ...metadata };
  delete snapshotMetadata.versionHistory;

  const entitySnapshot = toEntitySnapshot({
    ...entity,
    metadata: Object.keys(snapshotMetadata).length > 0 ? snapshotMetadata : null,
  });

  // Compute change record against previous version
  let changeRecord: ChangeRecord | null = null;
  if (existingHistory.length > 0) {
    // Sort by version descending to get the latest
    const sorted = [...existingHistory].sort((a, b) => b.version - a.version);
    const previousSnapshot = sorted[0];
    const previousFields = previousSnapshot.snapshot.fields;
    const changes = computeFieldDiff(previousFields, currentFields);
    changeRecord = {
      previousVersion: previousSnapshot.version,
      changes,
    };
  }

  // Build version snapshot
  const versionSnapshot: VersionSnapshot = {
    version: newVersionNumber,
    timestamp: new Date().toISOString(),
    createdBy: ctx.userId,
    snapshot: {
      entity: entitySnapshot,
      fields: currentFields,
    },
    changeRecord,
  };

  // Store in metadata and increment entity version
  const updatedHistory = [...existingHistory, versionSnapshot];
  const updatedMetadata = {
    ...metadata,
    versionHistory: updatedHistory,
  };

  await withAudit({
    action: "CREATE_VERSION",
    entityType: "Entity",
    entityId,
    userId: ctx.userId,
    fn: async () => {
      return prisma.entity.update({
        where: { id: entityId },
        data: {
          version: newVersionNumber,
          metadata: updatedMetadata as unknown as Prisma.InputJsonValue,
        },
      });
    },
  });

  return ok(versionSnapshot);
}

/**
 * Get the full version history for an entity (reverse chronological order).
 */
export async function getVersionHistory(
  entityId: string,
  _ctx: ServiceContext
): Promise<Result<VersionSnapshot[]>> {
  const entity = await prisma.entity.findUnique({
    where: { id: entityId },
    select: { metadata: true },
  });

  if (!entity) {
    return err({
      code: "NOT_FOUND",
      message: `Entity with ID "${entityId}" not found`,
      suggestedFix: "Verify the entity ID and try again.",
    });
  }

  const metadata = (entity.metadata as Record<string, unknown>) ?? {};
  const history = getVersionHistoryFromMetadata(metadata);

  // Return in reverse chronological order (latest first)
  const sorted = [...history].sort((a, b) => b.version - a.version);
  return ok(sorted);
}

/**
 * Get a specific version snapshot by version number.
 */
export async function getVersion(
  entityId: string,
  versionNumber: number,
  _ctx: ServiceContext
): Promise<Result<VersionSnapshot>> {
  const entity = await prisma.entity.findUnique({
    where: { id: entityId },
    select: { metadata: true },
  });

  if (!entity) {
    return err({
      code: "NOT_FOUND",
      message: `Entity with ID "${entityId}" not found`,
      suggestedFix: "Verify the entity ID and try again.",
    });
  }

  const metadata = (entity.metadata as Record<string, unknown>) ?? {};
  const history = getVersionHistoryFromMetadata(metadata);
  const version = history.find((v) => v.version === versionNumber);

  if (!version) {
    return err({
      code: "NOT_FOUND",
      message: `Version ${versionNumber} not found for entity "${entityId}"`,
      suggestedFix: "Check the version number and try again.",
    });
  }

  return ok(version);
}

/**
 * Compare two versions by computing a diff between their field snapshots.
 */
export async function compareVersions(
  entityId: string,
  v1: number,
  v2: number,
  _ctx: ServiceContext
): Promise<Result<VersionDiff>> {
  const entity = await prisma.entity.findUnique({
    where: { id: entityId },
    select: { metadata: true },
  });

  if (!entity) {
    return err({
      code: "NOT_FOUND",
      message: `Entity with ID "${entityId}" not found`,
      suggestedFix: "Verify the entity ID and try again.",
    });
  }

  const metadata = (entity.metadata as Record<string, unknown>) ?? {};
  const history = getVersionHistoryFromMetadata(metadata);

  const version1 = history.find((v) => v.version === v1);
  const version2 = history.find((v) => v.version === v2);

  if (!version1) {
    return err({
      code: "NOT_FOUND",
      message: `Version ${v1} not found`,
      suggestedFix: "Check the version number and try again.",
    });
  }
  if (!version2) {
    return err({
      code: "NOT_FOUND",
      message: `Version ${v2} not found`,
      suggestedFix: "Check the version number and try again.",
    });
  }

  const changes = computeFieldDiff(
    version1.snapshot.fields,
    version2.snapshot.fields
  );

  const summary = {
    added: changes.filter((c) => c.type === "added").length,
    removed: changes.filter((c) => c.type === "removed").length,
    modified: changes.filter((c) => c.type === "modified").length,
  };

  return ok({
    fromVersion: v1,
    toVersion: v2,
    changes,
    summary,
  });
}

/**
 * Compare two versions with structured field-level diff including
 * unchanged fields and property-level changes for modified fields.
 */
export async function compareVersionsStructured(
  entityId: string,
  v1: number,
  v2: number,
  _ctx: ServiceContext
): Promise<Result<DiffResult>> {
  const entity = await prisma.entity.findUnique({
    where: { id: entityId },
    select: { metadata: true },
  });

  if (!entity) {
    return err({
      code: "NOT_FOUND",
      message: `Entity with ID "${entityId}" not found`,
      suggestedFix: "Verify the entity ID and try again.",
    });
  }

  const metadata = (entity.metadata as Record<string, unknown>) ?? {};
  const history = getVersionHistoryFromMetadata(metadata);

  const version1 = history.find((v) => v.version === v1);
  const version2 = history.find((v) => v.version === v2);

  if (!version1) {
    return err({
      code: "NOT_FOUND",
      message: `Version ${v1} not found`,
      suggestedFix: "Check the version number and try again.",
    });
  }
  if (!version2) {
    return err({
      code: "NOT_FOUND",
      message: `Version ${v2} not found`,
      suggestedFix: "Check the version number and try again.",
    });
  }

  const diffResult = computeDiffResult(
    version1.snapshot.fields,
    version2.snapshot.fields,
    v1,
    v2
  );

  return ok(diffResult);
}
