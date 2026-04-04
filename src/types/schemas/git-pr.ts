/**
 * Git PR Zod Schemas
 *
 * Validation schemas for PR-based change review and compatibility reports.
 */

import { z } from "zod";
import { PrReviewModeSchema } from "./git";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const GitPrStatusSchema = z.enum(["OPEN", "MERGED", "CLOSED"]);
export type GitPrStatus = z.infer<typeof GitPrStatusSchema>;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export const ExportWithReviewInputSchema = z.object({
  entityId: z.string().min(1),
  versionId: z.string().min(1),
});
export type ExportWithReviewInput = z.infer<typeof ExportWithReviewInputSchema>;

export const SyncPrStatusInputSchema = z.object({
  prId: z.string().min(1),
});
export type SyncPrStatusInput = z.infer<typeof SyncPrStatusInputSchema>;

export const GetPrHistoryInputSchema = z.object({
  entityId: z.string().min(1),
});
export type GetPrHistoryInput = z.infer<typeof GetPrHistoryInputSchema>;

export const GetLatestPrInputSchema = z.object({
  entityId: z.string().min(1),
});
export type GetLatestPrInput = z.infer<typeof GetLatestPrInputSchema>;

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export const GitPrResultSchema = z.object({
  prUrl: z.string(),
  prNumber: z.number().int(),
  branchName: z.string(),
});
export type GitPrResult = z.infer<typeof GitPrResultSchema>;

export const GitPullRequestSchema = z.object({
  id: z.string(),
  entityId: z.string(),
  versionId: z.string(),
  prUrl: z.string(),
  prNumber: z.number().int(),
  branchName: z.string(),
  status: GitPrStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string().optional(),
});
export type GitPullRequest = z.infer<typeof GitPullRequestSchema>;

// Re-export for convenience
export { PrReviewModeSchema };
