/**
 * Legacy Version History Service (read-only).
 *
 * Reads the pre-Epic-14 snapshots stored in entity metadata JSONB under
 * `versionHistory`. Nothing writes them any more: Story 2-22's "every save
 * creates a version" is superseded by Draft + Publish (spec D1). Published
 * versions live in `entity_versions` (src/services/entity-version.service.ts).
 */

import { prisma } from "@/lib/db";
import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";
import type { VersionSnapshot, VersionDiff, DiffResult } from "./version.types";
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
