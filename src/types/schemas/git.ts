/**
 * Git Export Zod Schemas
 *
 * Validation schemas for Git repository configuration and export operations.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const GitAuthMethodSchema = z.enum([
  "SSH_KEY",
  "PERSONAL_ACCESS_TOKEN",
  "GITHUB_APP",
]);
export type GitAuthMethod = z.infer<typeof GitAuthMethodSchema>;

export const GitSyncStatusSchema = z.enum(["SUCCESS", "FAILED", "PENDING"]);
export type GitSyncStatus = z.infer<typeof GitSyncStatusSchema>;

export const PrReviewModeSchema = z.enum([
  "ALWAYS",
  "BREAKING_ONLY",
  "NEVER",
]);
export type PrReviewMode = z.infer<typeof PrReviewModeSchema>;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * Whether a repository URL carries a credential in its user information. Such a token would be stored in clear text in the repository row,
 * returned with the configuration and copied into the audit trail, so it goes in the credential field instead, which is sealed. A password is a
 * secret in any scheme. A user name is the token-as-user-name form (`https://<token>@host/...`) in every scheme but ssh, where it names an account
 * (`ssh://git@host/...`): the scp form (`git@host:path`) has no URL user information at all and stays allowed.
 */
function carriesUrlCredentials(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.password !== "") return true;
  return url.username !== "" && !/ssh/i.test(url.protocol);
}

export const ConfigureRepositoryInputSchema = z.object({
  repositoryUrl: z
    .string()
    .min(1, "Repository URL is required")
    .refine((value) => !carriesUrlCredentials(value), "Keep the credential out of the repository URL: enter it in the credential field."),
  branch: z.string().min(1).default("main"),
  basePath: z.string().min(1).default("schemas/"),
  authMethod: GitAuthMethodSchema,
  authCredential: z.string().min(1, "Auth credential is required"),
  prReviewMode: PrReviewModeSchema.default("BREAKING_ONLY"),
});
export type ConfigureRepositoryInput = z.infer<
  typeof ConfigureRepositoryInputSchema
>;

export const TestConnectionInputSchema = z.object({
  configId: z.string().min(1),
});
export type TestConnectionInput = z.infer<typeof TestConnectionInputSchema>;

export const ExportEntityInputSchema = z.object({
  entityId: z.string().min(1),
});
export type ExportEntityInput = z.infer<typeof ExportEntityInputSchema>;

export const EnableDisableInputSchema = z.object({
  configId: z.string().min(1),
});
export type EnableDisableInput = z.infer<typeof EnableDisableInputSchema>;

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export const GitConfigResponseSchema = z.object({
  id: z.string(),
  repositoryUrl: z.string(),
  branch: z.string(),
  basePath: z.string(),
  authMethod: GitAuthMethodSchema,
  prReviewMode: PrReviewModeSchema,
  enabled: z.boolean(),
  lastSyncAt: z.string().nullable(),
  lastSyncStatus: GitSyncStatusSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // authCredential is intentionally omitted — never sent to client
});
export type GitConfigResponse = z.infer<typeof GitConfigResponseSchema>;

export const GitExportResultSchema = z.object({
  success: z.boolean(),
  filesExported: z.number(),
  commitSha: z.string().optional(),
  error: z.string().optional(),
  /** Files the export skipped or kept apart (an unsafe path, two files on one path); the export itself went ahead. */
  warnings: z.array(z.string()).optional(),
});
export type GitExportResult = z.infer<typeof GitExportResultSchema>;

// ---------------------------------------------------------------------------
// Export file format enum
// ---------------------------------------------------------------------------

export type ExportFormat = "superschema" | "bigquery" | "avro" | "openapi";

/** File extension map for each export format */
export const FORMAT_EXTENSIONS: Record<ExportFormat, string> = {
  superschema: ".superschema.json",
  bigquery: ".bq.sql",
  avro: ".avro.json",
  openapi: ".openapi.yaml",
};
