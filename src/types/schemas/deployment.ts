/**
 * Zod schemas for deployment tracking.
 */

import { z } from "zod";
import { DriftStatusSchema } from "./drift";

export const EnvironmentSchema = z
  .enum(["production", "staging", "development"])
  .or(z.string().min(1));

export const DeploymentTrackingStatusSchema = z.enum([
  "DEPLOYED",
  "STAGED",
  "DRIFTED",
  "UNKNOWN",
]);

export const MarkAsDeployedInput = z.object({
  emissionTargetId: z.string().min(1, "Emission target ID is required"),
  environment: EnvironmentSchema,
  versionId: z.string().min(1, "Version ID is required"),
});

export const GetDeploymentStatusInput = z.object({
  entityId: z.string().min(1, "Entity ID is required"),
});

export const DeploymentOverviewFilters = z.object({
  domain: z.string().optional(),
  driftStatus: DriftStatusSchema.optional(),
  targetFormat: z.string().optional(),
});

export const GetDeploymentOverviewInput = z.object({
  filters: DeploymentOverviewFilters.optional(),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(25),
});

export const UnmarkDeploymentInput = z.object({
  emissionTargetId: z.string().min(1, "Emission target ID is required"),
  environment: EnvironmentSchema,
});

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export const EnvironmentDeploymentSchema = z.object({
  name: z.string(),
  deployedVersion: z.string().nullable(),
  status: DeploymentTrackingStatusSchema,
  driftStatus: DriftStatusSchema,
  lastChecked: z.string().nullable(),
  markedDeployedAt: z.string().nullable(),
});

export const DeploymentStatusSchema = z.object({
  targetFormat: z.string(),
  targetId: z.string(),
  emittedVersion: z.string().nullable(),
  environments: z.array(EnvironmentDeploymentSchema),
});

export const DeploymentOverviewRowSchema = z.object({
  entityId: z.string(),
  entityName: z.string(),
  domain: z.string(),
  currentVersion: z.string().nullable(),
  targets: z.array(
    z.object({
      format: z.string(),
      deployedVersion: z.string().nullable(),
      driftStatus: DriftStatusSchema,
    })
  ),
});

export type MarkAsDeployedInputType = z.infer<typeof MarkAsDeployedInput>;
export type GetDeploymentStatusInputType = z.infer<typeof GetDeploymentStatusInput>;
export type DeploymentOverviewFiltersType = z.infer<typeof DeploymentOverviewFilters>;
export type GetDeploymentOverviewInputType = z.infer<typeof GetDeploymentOverviewInput>;
export type UnmarkDeploymentInputType = z.infer<typeof UnmarkDeploymentInput>;
export type DeploymentStatusType = z.infer<typeof DeploymentStatusSchema>;
export type DeploymentOverviewRowType = z.infer<typeof DeploymentOverviewRowSchema>;
