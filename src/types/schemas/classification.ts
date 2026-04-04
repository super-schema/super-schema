/**
 * Change Classification Types & Schemas
 *
 * Types for the change classification engine that evaluates schema changes
 * and classifies them as breaking, non-breaking, or classification-change.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const ChangeTypeEnum = z.enum([
  "non-breaking",
  "breaking",
  "classification-change",
]);
export type ChangeType = z.infer<typeof ChangeTypeEnum>;

export const SeverityEnum = z.enum(["low", "medium", "high", "critical"]);
export type Severity = z.infer<typeof SeverityEnum>;

// ---------------------------------------------------------------------------
// Per-Target Classification
// ---------------------------------------------------------------------------

export const PerTargetClassificationSchema = z.object({
  target: z.string(),
  changeType: ChangeTypeEnum,
  details: z.string(),
});
export type PerTargetClassification = z.infer<
  typeof PerTargetClassificationSchema
>;

// ---------------------------------------------------------------------------
// Change Classification
// ---------------------------------------------------------------------------

export const ChangeClassificationSchema = z.object({
  changeType: ChangeTypeEnum,
  severity: SeverityEnum,
  reasons: z.array(z.string()),
  perTarget: z.array(PerTargetClassificationSchema),
});
export type ChangeClassification = z.infer<typeof ChangeClassificationSchema>;
