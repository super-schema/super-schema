/**
 * Zod schemas for drift detection.
 */

import { z } from "zod";

export const DriftDifferenceTypeSchema = z.enum([
  "added",
  "removed",
  "type-mismatch",
  "metadata-mismatch",
]);

export const DriftDifferenceSchema = z.object({
  fieldName: z.string(),
  type: DriftDifferenceTypeSchema,
  logicalValue: z.string().nullable(),
  implementationValue: z.string().nullable(),
});

export const DriftStatusSchema = z.enum(["in-sync", "drifted", "unknown"]);

export const DriftTargetStatusSchema = z.object({
  targetFormat: z.string(),
  driftStatus: DriftStatusSchema,
  differences: z.array(DriftDifferenceSchema),
});

export const DriftReportSchema = z.object({
  entityId: z.string(),
  entityName: z.string(),
  targets: z.array(DriftTargetStatusSchema),
});

export const DeploymentTrackingStatusSchema = z.enum([
  "DEPLOYED",
  "STAGED",
  "DRIFTED",
  "UNKNOWN",
]);

export const DetectDriftInput = z.object({
  entityId: z.string().min(1, "Entity ID is required"),
});

export const DetectDriftBulkInput = z.object({
  entityIds: z.array(z.string().min(1)),
});

export type DriftDifferenceType = z.infer<typeof DriftDifferenceTypeSchema>;
export type DriftReportType = z.infer<typeof DriftReportSchema>;
export type DriftTargetStatusType = z.infer<typeof DriftTargetStatusSchema>;
