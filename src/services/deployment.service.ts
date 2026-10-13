/**
 * Deployment Tracking Service — manages deployment status for emission targets.
 *
 * Tracks which schema versions are deployed to which environments, and provides
 * a system-wide deployment overview.
 *
 * Persisted via Prisma `deploymentRecord` table.
 *
 * MVP approach: deployment marking is manual (user clicks "Mark as Deployed").
 * Automated CI/CD integration deferred to Phase 2.
 *
 * Service layer pattern: all functions return Result<T, ServiceError>.
 */

import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { ok } from "@/types/result";
import type { Result } from "@/types/result";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DeploymentTrackingStatus =
  | "DEPLOYED"
  | "STAGED"
  | "DRIFTED"
  | "UNKNOWN";

export interface DeploymentRecord {
  id: string;
  emissionTargetId: string;
  environment: string;
  status: DeploymentTrackingStatus;
  deployedVersionId: string | null;
  driftReport: Record<string, unknown> | null;
  checkedAt: string;
  markedDeployedAt: string | null;
  markedDeployedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnvironmentDeployment {
  name: string;
  deployedVersion: string | null;
  status: DeploymentTrackingStatus;
  driftStatus: "in-sync" | "drifted" | "unknown";
  lastChecked: string | null;
  markedDeployedAt: string | null;
}

export interface DeploymentStatus {
  targetFormat: string;
  targetId: string;
  emittedVersion: string | null;
  environments: EnvironmentDeployment[];
}

export interface DeploymentOverviewRow {
  entityId: string;
  entityName: string;
  entitySlug?: string;
  domain: string;
  domainSlug?: string;
  currentVersion: string | null;
  targets: {
    format: string;
    deployedVersion: string | null;
    driftStatus: "in-sync" | "drifted" | "unknown";
  }[];
}

export interface MarkAsDeployedInput {
  emissionTargetId: string;
  environment: string;
  versionId: string;
  currentEmittedVersionId?: string;
}

export interface DeploymentOverviewFilters {
  domain?: string;
  driftStatus?: "in-sync" | "drifted" | "unknown";
  targetFormat?: string;
}

// ---------------------------------------------------------------------------
// clearStore — no-op, kept for test compatibility
// ---------------------------------------------------------------------------

export function clearDeploymentStore(): void {
  // No-op — Prisma persistence is managed via test mocks
}

// ---------------------------------------------------------------------------
// Helper: map Prisma row to DeploymentRecord
// ---------------------------------------------------------------------------

function toDeploymentRecord(row: {
  id: string;
  entityId: string;
  target: string;
  environment: string;
  version: number;
  status: string;
  driftReport: unknown;
  isDrifted: boolean;
  deployedBy: string | null;
  deployedAt: Date;
  updatedAt: Date;
}): DeploymentRecord {
  const isDrifted = row.isDrifted;
  const status: DeploymentTrackingStatus = isDrifted
    ? "DRIFTED"
    : (row.status as DeploymentTrackingStatus);

  return {
    id: row.id,
    emissionTargetId: row.target,
    environment: row.environment,
    status,
    deployedVersionId: String(row.version),
    driftReport: (row.driftReport as Record<string, unknown>) ?? null,
    checkedAt: row.updatedAt.toISOString(),
    markedDeployedAt: row.deployedAt.toISOString(),
    markedDeployedBy: row.deployedBy,
    createdAt: row.deployedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// markAsDeployed
// ---------------------------------------------------------------------------

export async function markAsDeployed(
  input: MarkAsDeployedInput,
  userId: string
): Promise<Result<DeploymentRecord>> {
  const now = new Date();

  // Determine status: DEPLOYED if version matches current emission, STAGED otherwise
  const status =
    input.currentEmittedVersionId &&
    input.versionId !== input.currentEmittedVersionId
      ? "STAGED"
      : "DEPLOYED";

  // We use entityId as emissionTargetId for upsert key
  // The Prisma model uses @@unique([entityId, target, environment])
  const row = await prisma.deploymentRecord.upsert({
    where: {
      entityId_target_environment: {
        entityId: input.emissionTargetId,
        target: input.emissionTargetId,
        environment: input.environment,
      },
    },
    create: {
      entityId: input.emissionTargetId,
      target: input.emissionTargetId,
      environment: input.environment,
      version: parseInt(input.versionId.replace(/\D/g, "")) || 0,
      status: status as "DEPLOYED" | "STAGED",
      deployedBy: userId,
      deployedAt: now,
    },
    update: {
      version: parseInt(input.versionId.replace(/\D/g, "")) || 0,
      status: status as "DEPLOYED" | "STAGED",
      deployedBy: userId,
      deployedAt: now,
    },
  });

  return ok(toDeploymentRecord(row));
}

// ---------------------------------------------------------------------------
// getDeploymentStatus — get per-target deployment status for an entity
// ---------------------------------------------------------------------------

export async function getDeploymentStatus(
  _entityId: string,
  emissionTargets: {
    id: string;
    targetFormat: string;
    emittedVersion?: string | null;
  }[]
): Promise<Result<DeploymentStatus[]>> {
  const statuses: DeploymentStatus[] = [];

  for (const target of emissionTargets) {
    const rows = await prisma.deploymentRecord.findMany({
      where: { target: target.id },
    });

    const environments: EnvironmentDeployment[] = rows.map((row) => {
      const rec = toDeploymentRecord(row);
      return {
        name: rec.environment,
        deployedVersion: rec.deployedVersionId,
        status: rec.status,
        // Drift is tracked on the isDrifted flag (set by updateDriftStatus); the
        // status enum has no DRIFTED member, so derive the badge from the flag.
        driftStatus: row.isDrifted
          ? ("drifted" as const)
          : rec.status === "DEPLOYED"
            ? ("in-sync" as const)
            : ("unknown" as const),
        lastChecked: rec.checkedAt,
        markedDeployedAt: rec.markedDeployedAt,
      };
    });

    statuses.push({
      targetFormat: target.targetFormat,
      targetId: target.id,
      emittedVersion: target.emittedVersion || null,
      environments,
    });
  }

  return ok(statuses);
}

// ---------------------------------------------------------------------------
// getDeploymentOverview — system-wide overview with filtering + pagination
// ---------------------------------------------------------------------------

export async function getDeploymentOverview(
  entities: {
    entityId: string;
    entityName: string;
    domain: string;
    currentVersion: string | null;
    targets: {
      id: string;
      format: string;
    }[];
  }[],
  filters?: DeploymentOverviewFilters,
  offset = 0,
  limit = 25
): Promise<Result<{ rows: DeploymentOverviewRow[]; total: number }>> {
  // Collect all target IDs for batch query
  const allTargetIds = entities.flatMap((e) => e.targets.map((t) => t.id));

  const allRecords = await prisma.deploymentRecord.findMany({
    where: { target: { in: allTargetIds } },
  });

  // Group records by target ID
  const recordsByTarget = new Map<string, typeof allRecords>();
  for (const rec of allRecords) {
    const existing = recordsByTarget.get(rec.target) ?? [];
    existing.push(rec);
    recordsByTarget.set(rec.target, existing);
  }

  let rows: DeploymentOverviewRow[] = entities.map((entity) => ({
    entityId: entity.entityId,
    entityName: entity.entityName,
    domain: entity.domain,
    currentVersion: entity.currentVersion,
    targets: entity.targets.map((target) => {
      const records = recordsByTarget.get(target.id) ?? [];
      // Find the latest deployment record for this target
      let latestRecord: (typeof allRecords)[0] | null = null;
      for (const record of records) {
        if (
          !latestRecord ||
          record.updatedAt > latestRecord.updatedAt
        ) {
          latestRecord = record;
        }
      }

      const rec = latestRecord ? toDeploymentRecord(latestRecord) : null;

      return {
        format: target.format,
        deployedVersion: rec?.deployedVersionId || null,
        driftStatus: (latestRecord?.isDrifted
          ? "drifted"
          : rec?.status === "DEPLOYED"
            ? "in-sync"
            : "unknown") as "in-sync" | "drifted" | "unknown",
      };
    }),
  }));

  // Apply filters
  if (filters?.domain) {
    rows = rows.filter((r) => r.domain === filters.domain);
  }
  if (filters?.driftStatus) {
    rows = rows.filter((r) =>
      r.targets.some((t) => t.driftStatus === filters.driftStatus)
    );
  }
  if (filters?.targetFormat) {
    rows = rows.filter((r) =>
      r.targets.some((t) => t.format === filters.targetFormat)
    );
  }

  const total = rows.length;
  const paginated = rows.slice(offset, offset + limit);

  return ok({ rows: paginated, total });
}

// ---------------------------------------------------------------------------
// unmarkDeployment — remove a deployment tracking record
// ---------------------------------------------------------------------------

export async function unmarkDeployment(
  emissionTargetId: string,
  environment: string
): Promise<Result<void>> {
  try {
    await prisma.deploymentRecord.deleteMany({
      where: {
        target: emissionTargetId,
        environment,
      },
    });
  } catch {
    // Ignore — record may not exist
  }
  return ok(undefined as unknown as void);
}

// ---------------------------------------------------------------------------
// updateDriftStatus — update drift report on a deployment record
// ---------------------------------------------------------------------------

export async function updateDriftStatus(
  emissionTargetId: string,
  environment: string,
  driftReport: Record<string, unknown>,
  isDrifted: boolean
): Promise<Result<DeploymentRecord | null>> {
  const rows = await prisma.deploymentRecord.findMany({
    where: {
      target: emissionTargetId,
      environment,
    },
  });

  if (rows.length === 0) {
    return ok(null);
  }

  const updated = await prisma.deploymentRecord.update({
    where: { id: rows[0].id },
    data: {
      driftReport: driftReport as unknown as Prisma.InputJsonValue,
      isDrifted,
    },
  });

  return ok(toDeploymentRecord(updated));
}
