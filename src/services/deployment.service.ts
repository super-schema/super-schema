/**
 * Deployment Tracking Service — manages deployment status for emission targets.
 *
 * Tracks which schema versions are deployed to which environments, and provides
 * a system-wide deployment overview.
 *
 * MVP approach: deployment marking is manual (user clicks "Mark as Deployed").
 * Automated CI/CD integration deferred to Phase 2.
 *
 * Service layer pattern: all functions return Result<T, ServiceError>.
 */

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
  domain: string;
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
// In-memory deployment tracking store (MVP — no Prisma migration)
// ---------------------------------------------------------------------------

const deploymentStore = new Map<string, DeploymentRecord>();

function makeKey(emissionTargetId: string, environment: string): string {
  return `${emissionTargetId}::${environment}`;
}

let idCounter = 0;
function generateId(): string {
  return `deploy-${++idCounter}`;
}

// ---------------------------------------------------------------------------
// markAsDeployed
// ---------------------------------------------------------------------------

export function markAsDeployed(
  input: MarkAsDeployedInput,
  userId: string
): Result<DeploymentRecord> {
  const key = makeKey(input.emissionTargetId, input.environment);
  const now = new Date().toISOString();

  // Determine status: DEPLOYED if version matches current emission, STAGED otherwise
  const status: DeploymentTrackingStatus =
    input.currentEmittedVersionId &&
    input.versionId !== input.currentEmittedVersionId
      ? "STAGED"
      : "DEPLOYED";

  const existing = deploymentStore.get(key);

  const record: DeploymentRecord = {
    id: existing?.id || generateId(),
    emissionTargetId: input.emissionTargetId,
    environment: input.environment,
    status,
    deployedVersionId: input.versionId,
    driftReport: existing?.driftReport || null,
    checkedAt: existing?.checkedAt || now,
    markedDeployedAt: now,
    markedDeployedBy: userId,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  deploymentStore.set(key, record);

  return ok(record);
}

// ---------------------------------------------------------------------------
// getDeploymentStatus — get per-target deployment status for an entity
// ---------------------------------------------------------------------------

export function getDeploymentStatus(
  entityId: string,
  emissionTargets: {
    id: string;
    targetFormat: string;
    emittedVersion?: string | null;
  }[]
): Result<DeploymentStatus[]> {
  const statuses: DeploymentStatus[] = [];

  for (const target of emissionTargets) {
    const environments: EnvironmentDeployment[] = [];

    // Find all deployment records for this target
    for (const [, record] of deploymentStore) {
      if (record.emissionTargetId === target.id) {
        environments.push({
          name: record.environment,
          deployedVersion: record.deployedVersionId,
          status: record.status,
          driftStatus: record.status === "DRIFTED" ? "drifted" : record.status === "DEPLOYED" ? "in-sync" : "unknown",
          lastChecked: record.checkedAt,
          markedDeployedAt: record.markedDeployedAt,
        });
      }
    }

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

export function getDeploymentOverview(
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
): Result<{ rows: DeploymentOverviewRow[]; total: number }> {
  let rows: DeploymentOverviewRow[] = entities.map((entity) => ({
    entityId: entity.entityId,
    entityName: entity.entityName,
    domain: entity.domain,
    currentVersion: entity.currentVersion,
    targets: entity.targets.map((target) => {
      // Find the latest deployment record for this target
      let latestRecord: DeploymentRecord | null = null;
      for (const [, record] of deploymentStore) {
        if (record.emissionTargetId === target.id) {
          if (
            !latestRecord ||
            record.updatedAt > latestRecord.updatedAt
          ) {
            latestRecord = record;
          }
        }
      }

      return {
        format: target.format,
        deployedVersion: latestRecord?.deployedVersionId || null,
        driftStatus: (latestRecord?.status === "DRIFTED"
          ? "drifted"
          : latestRecord?.status === "DEPLOYED"
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

export function unmarkDeployment(
  emissionTargetId: string,
  environment: string
): Result<void> {
  const key = makeKey(emissionTargetId, environment);
  deploymentStore.delete(key);
  return ok(undefined as unknown as void);
}

// ---------------------------------------------------------------------------
// updateDriftStatus — update drift report on a deployment record
// ---------------------------------------------------------------------------

export function updateDriftStatus(
  emissionTargetId: string,
  environment: string,
  driftReport: Record<string, unknown>,
  isDrifted: boolean
): Result<DeploymentRecord | null> {
  const key = makeKey(emissionTargetId, environment);
  const existing = deploymentStore.get(key);

  if (!existing) {
    return ok(null);
  }

  existing.driftReport = driftReport;
  existing.status = isDrifted ? "DRIFTED" : existing.status;
  existing.checkedAt = new Date().toISOString();
  existing.updatedAt = new Date().toISOString();

  deploymentStore.set(key, existing);
  return ok(existing);
}

// ---------------------------------------------------------------------------
// clearStore — for testing
// ---------------------------------------------------------------------------

export function clearDeploymentStore(): void {
  deploymentStore.clear();
  idCounter = 0;
}
