/**
 * Governance Types & Schemas
 *
 * Types for governance workflow, approval routing, and impact reports.
 */

import { z } from "zod";
import { ChangeClassificationSchema } from "./classification";

// ---------------------------------------------------------------------------
// Governance Status Enums
// ---------------------------------------------------------------------------

export const GovernanceStatusEnum = z.enum([
  "PENDING",
  "APPROVED",
  "REJECTED",
  "AUTO_APPROVED",
]);
export type GovernanceStatus = z.infer<typeof GovernanceStatusEnum>;

export const GovernanceDecisionEnum = z.enum(["APPROVED", "REJECTED"]);
export type GovernanceDecision = z.infer<typeof GovernanceDecisionEnum>;

// ---------------------------------------------------------------------------
// Impact Report Types
// ---------------------------------------------------------------------------

export const MigrationComplexityEnum = z.enum([
  "trivial",
  "moderate",
  "complex",
]);
export type MigrationComplexity = z.infer<typeof MigrationComplexityEnum>;

export const PerTargetImpactSchema = z.object({
  target: z.string(),
  compatible: z.boolean(),
  migrationRequired: z.boolean(),
  migrationComplexity: MigrationComplexityEnum,
  details: z.string(),
});
export type PerTargetImpact = z.infer<typeof PerTargetImpactSchema>;

export const AffectedConsumerSchema = z.object({
  entityName: z.string(),
  fieldName: z.string(),
  relationship: z.string(),
  ownerEmail: z.string(),
});
export type AffectedConsumer = z.infer<typeof AffectedConsumerSchema>;

export const MigrationArtifactsSummarySchema = z.object({
  bigquery: z.string(),
  avro: z.string(),
  openapi: z.string(),
});
export type MigrationArtifactsSummary = z.infer<
  typeof MigrationArtifactsSummarySchema
>;

export const ImpactReportSchema = z.object({
  summary: z.string(),
  changeClassification: ChangeClassificationSchema,
  perTarget: z.array(PerTargetImpactSchema),
  affectedConsumers: z.array(AffectedConsumerSchema),
  migrationArtifactsSummary: MigrationArtifactsSummarySchema,
});
export type ImpactReport = z.infer<typeof ImpactReportSchema>;

// ---------------------------------------------------------------------------
// Governance Request
// ---------------------------------------------------------------------------

export const GovernanceRequestSchema = z.object({
  id: z.string(),
  entityId: z.string(),
  entityName: z.string().optional(),
  domainId: z.string().optional(),
  versionId: z.number(),
  changeType: z.string(),
  status: GovernanceStatusEnum,
  impactReport: ImpactReportSchema.nullable(),
  requestedBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type GovernanceRequest = z.infer<typeof GovernanceRequestSchema>;

// ---------------------------------------------------------------------------
// Governance Approval
// ---------------------------------------------------------------------------

export const GovernanceApprovalSchema = z.object({
  id: z.string(),
  requestId: z.string(),
  approverId: z.string(),
  decision: GovernanceDecisionEnum,
  comment: z.string().nullable(),
  decidedAt: z.string(),
});
export type GovernanceApproval = z.infer<typeof GovernanceApprovalSchema>;

// ---------------------------------------------------------------------------
// Staged Emission Types
// ---------------------------------------------------------------------------

export const StagedTargetSchema = z.object({
  targetId: z.string(),
  targetName: z.string(),
  stagedVersionId: z.number(),
  compatible: z.boolean(),
  migrationComplexity: MigrationComplexityEnum,
  createdAt: z.string(),
});
export type StagedTarget = z.infer<typeof StagedTargetSchema>;

export const EmissionTargetStatusSchema = z.object({
  target: z.string(),
  emittedVersion: z.number().nullable(),
  stagedVersion: z.number().nullable(),
  lastEmittedAt: z.string().nullable(),
  status: z.enum(["current", "staged", "behind"]),
});
export type EmissionTargetStatus = z.infer<typeof EmissionTargetStatusSchema>;
