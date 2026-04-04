/**
 * Staged Emission Service
 *
 * Manages per-target staged emission. Allows partial emission to selected targets
 * while deferring others. Tracks per-target emission status and version snapshots
 * for deferred emission.
 *
 * Uses in-memory store for MVP — no Prisma migration required.
 */

import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import type {
  EmissionTargetStatus,
  StagedTarget,
} from "@/types/schemas/governance";

// ---------------------------------------------------------------------------
// In-Memory Stores
// ---------------------------------------------------------------------------

/** Per-target emission status: key = `${entityId}:${target}` */
const emissionTargetStatus = new Map<string, EmissionTargetStatus>();

/** Staged targets awaiting deferred emission: key = `${entityId}:${target}` */
const stagedTargets = new Map<string, StagedTarget>();

/** Emitted outputs: key = `${entityId}:${target}` */
const emittedOutputs = new Map<string, { output: string; version: number }>();

function targetKey(entityId: string, target: string): string {
  return `${entityId}:${target}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Emit to selected targets only.
 * Returns results per target. Unselected targets are not touched.
 */
export function emitToTargets(
  entityId: string,
  versionId: number,
  selectedTargets: string[],
  emitFn: (target: string) => Result<string>
): Result<
  Array<{
    target: string;
    success: boolean;
    output?: string;
    error?: string;
  }>
> {
  const results: Array<{
    target: string;
    success: boolean;
    output?: string;
    error?: string;
  }> = [];

  for (const target of selectedTargets) {
    const key = targetKey(entityId, target);
    const emitResult = emitFn(target);

    if (emitResult.success) {
      // Update emission status
      emittedOutputs.set(key, {
        output: emitResult.data,
        version: versionId,
      });

      emissionTargetStatus.set(key, {
        target,
        emittedVersion: versionId,
        stagedVersion: null,
        lastEmittedAt: new Date().toISOString(),
        status: "current",
      });

      // Clear any staged marker for this target
      stagedTargets.delete(key);

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
export function stageForLater(
  entityId: string,
  target: string,
  versionId: number,
  compatible: boolean,
  migrationComplexity: StagedTarget["migrationComplexity"]
): Result<StagedTarget> {
  const key = targetKey(entityId, target);

  const staged: StagedTarget = {
    targetId: key,
    targetName: target,
    stagedVersionId: versionId,
    compatible,
    migrationComplexity,
    createdAt: new Date().toISOString(),
  };

  stagedTargets.set(key, staged);

  // Update emission status
  const existingStatus = emissionTargetStatus.get(key);
  emissionTargetStatus.set(key, {
    target,
    emittedVersion: existingStatus?.emittedVersion ?? null,
    stagedVersion: versionId,
    lastEmittedAt: existingStatus?.lastEmittedAt ?? null,
    status: "staged",
  });

  return ok(staged);
}

/**
 * Emit a previously staged target using the stored version snapshot.
 */
export function emitStagedTarget(
  entityId: string,
  target: string,
  emitFn: (target: string, versionId: number) => Result<string>
): Result<{ target: string; output: string; version: number }> {
  const key = targetKey(entityId, target);
  const staged = stagedTargets.get(key);

  if (!staged) {
    return err({
      code: "NOT_FOUND",
      message: `No staged emission for target "${target}" on entity "${entityId}"`,
      suggestedFix: "Stage the target first before emitting.",
    });
  }

  const emitResult = emitFn(target, staged.stagedVersionId);

  if (!emitResult.success) {
    return err(emitResult.error);
  }

  // Update emission status
  emittedOutputs.set(key, {
    output: emitResult.data,
    version: staged.stagedVersionId,
  });

  emissionTargetStatus.set(key, {
    target,
    emittedVersion: staged.stagedVersionId,
    stagedVersion: null,
    lastEmittedAt: new Date().toISOString(),
    status: "current",
  });

  // Clear staged marker
  stagedTargets.delete(key);

  return ok({
    target,
    output: emitResult.data,
    version: staged.stagedVersionId,
  });
}

/**
 * Get all staged targets for an entity.
 */
export function getStagedTargets(
  entityId: string
): Result<StagedTarget[]> {
  const result: StagedTarget[] = [];
  for (const [key, staged] of stagedTargets) {
    if (key.startsWith(`${entityId}:`)) {
      result.push(staged);
    }
  }
  return ok(result);
}

/**
 * Get per-target emission status for an entity.
 */
export function getTargetStatuses(
  entityId: string,
  targets: string[]
): Result<EmissionTargetStatus[]> {
  const result: EmissionTargetStatus[] = targets.map((target) => {
    const key = targetKey(entityId, target);
    const existing = emissionTargetStatus.get(key);

    if (existing) return existing;

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
export function getEmittedOutput(
  entityId: string,
  target: string
): Result<{ output: string; version: number } | null> {
  const key = targetKey(entityId, target);
  const output = emittedOutputs.get(key);
  return ok(output ?? null);
}

// ---------------------------------------------------------------------------
// Reset (for testing)
// ---------------------------------------------------------------------------

export function _resetStagedEmissionStore(): void {
  emissionTargetStatus.clear();
  stagedTargets.clear();
  emittedOutputs.clear();
}
