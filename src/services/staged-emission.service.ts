/**
 * Staged Emission Service
 *
 * Manages per-target staged emission. Allows partial emission to selected targets
 * while deferring others. Tracks per-target emission status and version snapshots
 * for deferred emission.
 *
 * Persisted via Prisma `emissionTargetStatus` table.
 */

import { prisma } from "@/lib/db";
import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import type {
  EmissionTargetStatus,
  StagedTarget,
} from "@/types/schemas/governance";

// ---------------------------------------------------------------------------
// Reset (no-op for test compatibility)
// ---------------------------------------------------------------------------

export function _resetStagedEmissionStore(): void {
  // No-op — Prisma persistence is managed via test mocks
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Emit to selected targets only.
 * Returns results per target. Unselected targets are not touched.
 */
export async function emitToTargets(
  entityId: string,
  versionId: number,
  selectedTargets: string[],
  emitFn: (target: string) => Result<string>
): Promise<
  Result<
    Array<{
      target: string;
      success: boolean;
      output?: string;
      error?: string;
    }>
  >
> {
  const results: Array<{
    target: string;
    success: boolean;
    output?: string;
    error?: string;
  }> = [];

  for (const target of selectedTargets) {
    const emitResult = emitFn(target);

    if (emitResult.success) {
      // Upsert emission status
      await prisma.emissionTargetStatus.upsert({
        where: {
          entityId_target: { entityId, target },
        },
        create: {
          entityId,
          target,
          emittedVersion: versionId,
          stagedVersion: null,
          lastEmittedAt: new Date(),
          status: "CURRENT",
          output: emitResult.data,
        },
        update: {
          emittedVersion: versionId,
          stagedVersion: null,
          lastEmittedAt: new Date(),
          status: "CURRENT",
          output: emitResult.data,
        },
      });

      results.push({
        target,
        success: true,
        output: emitResult.data,
      });
    } else {
      results.push({
        target,
        success: false,
        error: emitResult.error.message,
      });
    }
  }

  return ok(results);
}

/**
 * Stage a target for deferred emission.
 * Records the version snapshot reference so the correct version
 * is used when eventually emitted.
 */
export async function stageForLater(
  entityId: string,
  target: string,
  versionId: number,
  compatible: boolean,
  migrationComplexity: StagedTarget["migrationComplexity"]
): Promise<Result<StagedTarget>> {
  // Get existing status for emittedVersion
  const existing = await prisma.emissionTargetStatus.findUnique({
    where: { entityId_target: { entityId, target } },
  });

  await prisma.emissionTargetStatus.upsert({
    where: {
      entityId_target: { entityId, target },
    },
    create: {
      entityId,
      target,
      emittedVersion: null,
      stagedVersion: versionId,
      lastEmittedAt: null,
      status: "STAGED",
    },
    update: {
      stagedVersion: versionId,
      status: "STAGED",
    },
  });

  const staged: StagedTarget = {
    targetId: `${entityId}:${target}`,
    targetName: target,
    stagedVersionId: versionId,
    compatible,
    migrationComplexity,
    createdAt: new Date().toISOString(),
  };

  return ok(staged);
}

/**
 * Emit a previously staged target using the stored version snapshot.
 */
export async function emitStagedTarget(
  entityId: string,
  target: string,
  emitFn: (target: string, versionId: number) => Result<string>
): Promise<Result<{ target: string; output: string; version: number }>> {
  const row = await prisma.emissionTargetStatus.findUnique({
    where: { entityId_target: { entityId, target } },
  });

  if (!row || row.stagedVersion === null) {
    return err({
      code: "NOT_FOUND",
      message: `No staged emission for target "${target}" on entity "${entityId}"`,
      suggestedFix: "Stage the target first before emitting.",
    });
  }

  const emitResult = emitFn(target, row.stagedVersion);

  if (!emitResult.success) {
    return err(emitResult.error);
  }

  // Update emission status
  await prisma.emissionTargetStatus.update({
    where: { entityId_target: { entityId, target } },
    data: {
      emittedVersion: row.stagedVersion,
      stagedVersion: null,
      lastEmittedAt: new Date(),
      status: "CURRENT",
      output: emitResult.data,
    },
  });

  return ok({
    target,
    output: emitResult.data,
    version: row.stagedVersion,
  });
}

/**
 * Get all staged targets for an entity.
 */
export async function getStagedTargets(
  entityId: string
): Promise<Result<StagedTarget[]>> {
  const rows = await prisma.emissionTargetStatus.findMany({
    where: {
      entityId,
      status: "STAGED",
      stagedVersion: { not: null },
    },
  });

  const result: StagedTarget[] = rows.map((row) => ({
    targetId: `${row.entityId}:${row.target}`,
    targetName: row.target,
    stagedVersionId: row.stagedVersion!,
    compatible: true, // Compatibility info not stored in DB — default
    migrationComplexity: "trivial" as const, // Not stored in DB — default
    createdAt: row.createdAt.toISOString(),
  }));

  return ok(result);
}

/**
 * Get per-target emission status for an entity.
 */
export async function getTargetStatuses(
  entityId: string,
  targets: string[]
): Promise<Result<EmissionTargetStatus[]>> {
  const rows = await prisma.emissionTargetStatus.findMany({
    where: {
      entityId,
      target: { in: targets },
    },
  });

  const rowMap = new Map(rows.map((r) => [r.target, r]));

  const result: EmissionTargetStatus[] = targets.map((target) => {
    const row = rowMap.get(target);

    if (row) {
      return {
        target: row.target,
        emittedVersion: row.emittedVersion,
        stagedVersion: row.stagedVersion,
        lastEmittedAt: row.lastEmittedAt?.toISOString() ?? null,
        status: row.status.toLowerCase() as "current" | "staged" | "behind",
      };
    }

    // Default: no emission yet
    return {
      target,
      emittedVersion: null,
      stagedVersion: null,
      lastEmittedAt: null,
      status: "behind" as const,
    };
  });

  return ok(result);
}

/**
 * Get the emitted output for a target.
 */
export async function getEmittedOutput(
  entityId: string,
  target: string
): Promise<Result<{ output: string; version: number } | null>> {
  const row = await prisma.emissionTargetStatus.findUnique({
    where: { entityId_target: { entityId, target } },
  });

  if (!row || row.emittedVersion === null || row.output === null) {
    return ok(null);
  }

  return ok({
    output: row.output,
    version: row.emittedVersion,
  });
}
