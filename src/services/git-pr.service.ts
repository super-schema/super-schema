/**
 * Git PR Service
 *
 * Legacy review formatting and migration history. Real delivery is owned by
 * deployment-workflow.service.ts and the deployment GitHub adapter.
 *
 * Pure helper functions for PR body generation and branch naming
 * are exported separately for unit testing.
 */

import { prisma } from "@/lib/db";
import { ctxCan } from "@/lib/access/context";
import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";
import type { GitExportResult } from "@/types/schemas/git";
import type { GitPrResult } from "@/types/schemas/git-pr";
import type { ChangeRecord } from "@/services/version-history/version.types";
import type { MigrationArtifacts } from "@/lib/migration/migration.types";
import type { TargetOutput } from "@/lib/emission/emission.types";
import {
  slugify,
  type ExportedTargetSummary,
} from "./git.service";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChangeRecordWithClassification {
  /** Whether this change is breaking */
  isBreaking: boolean;
  /** Type description, e.g., "breaking", "non-breaking" */
  changeType: string;
  /** Summary of changes */
  summary: string;
  /** The underlying change record from versioning */
  changeRecord: ChangeRecord | null;
}

export interface EntityForPr {
  id: string;
  name: string;
  description: string;
  domain: { name: string };
}

export interface VersionForPr {
  id: string;
  version: number;
}

export interface PrBodyInput {
  entity: EntityForPr;
  version: VersionForPr;
  changeInfo: ChangeRecordWithClassification;
  /** Legacy: the first emission pipeline's outputs. Listed only when `exportedTargets` is absent or empty. */
  emittedOutputs: Record<string, TargetOutput>;
  /**
   * The targets the export writes (`exportedTargetSummary`): the Compatibility Report lists them with version, status and file count
   * (a target has no valid/invalid verdict in a stored version).
   */
  exportedTargets?: ExportedTargetSummary[];
  migrationArtifacts?: MigrationArtifacts;
  governanceStatus?: string;
  appUrl?: string;
}

export interface GitPullRequestRecord {
  id: string;
  entityId: string;
  versionId: string;
  prUrl: string;
  prNumber: number;
  branchName: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Pure helper functions (no I/O — unit-testable)
// ---------------------------------------------------------------------------

/**
 * Build the branch name for a PR.
 *
 * @param entityName - Entity display name
 * @param version - Version number
 * @returns Branch name, e.g., "schema/transaction/v3"
 */
export function buildPrBranchName(
  entityName: string,
  version: number
): string {
  return `schema/${slugify(entityName)}/v${version}`;
}

/**
 * Build the PR title.
 *
 * @param entityName - Entity display name
 * @param version - Version number
 * @param changeType - "breaking" or "non-breaking"
 * @returns PR title, e.g., "Schema: Transaction v3 — breaking"
 */
export function buildPrTitle(
  entityName: string,
  version: number,
  changeType: string
): string {
  return `Schema: ${entityName} v${version} — ${changeType}`;
}

/**
 * Determine whether a PR should be created based on the review mode
 * and the change classification.
 *
 * @param prReviewMode - The configured review mode
 * @param isBreaking - Whether the change is breaking
 * @returns true if a PR should be created
 */
export function shouldCreatePr(
  prReviewMode: string,
  isBreaking: boolean
): boolean {
  switch (prReviewMode) {
    case "ALWAYS":
      return true;
    case "NEVER":
      return false;
    case "BREAKING_ONLY":
    default:
      return isBreaking;
  }
}

/**
 * Build a rich Markdown PR body with compatibility report.
 *
 * Includes:
 * - Change summary
 * - Change classification (breaking/non-breaking)
 * - Per-target compatibility report
 * - Collapsible migration artifacts
 * - Governance status
 * - Link back to Super Schema UI
 */
export function buildPrBody(input: PrBodyInput): string {
  const {
    entity,
    version,
    changeInfo,
    emittedOutputs,
    exportedTargets = [],
    migrationArtifacts,
    governanceStatus,
    appUrl,
  } = input;

  const sections: string[] = [];

  // Header
  sections.push(`# Schema Change: ${entity.name} v${version.version}`);
  sections.push("");

  // Change Summary
  sections.push("## Change Summary");
  sections.push("");
  sections.push(changeInfo.summary || "No summary provided.");
  sections.push("");

  // Change Classification
  sections.push("## Change Classification");
  sections.push("");
  if (changeInfo.isBreaking) {
    sections.push(
      "**:warning: BREAKING CHANGE** — This change may require downstream consumers to update."
    );
  } else {
    sections.push(
      "**:white_check_mark: Non-breaking change** — This change is backward-compatible."
    );
  }
  sections.push("");

  // Compatibility Report — per-target
  sections.push("## Compatibility Report");
  sections.push("");

  const targetNames = Object.keys(emittedOutputs);
  if (exportedTargets.length > 0) {
    // The generated targets of the entity (schemaVersions): what the PR adds. A stored version has no valid/invalid verdict.
    sections.push("| Target | Version | Status | Files | Details |");
    sections.push("|--------|---------|--------|-------|---------|");
    for (const target of exportedTargets) {
      const details =
        [target.status === "draft" ? "draft" : "", target.preview ? "preview" : ""].filter(Boolean).join(", ") || "-";
      sections.push(
        `| ${target.displayName} | v${target.version} | ${target.status} | ${target.fileCount} | ${details} |`
      );
    }
  } else if (targetNames.length === 0) {
    sections.push("No emission targets configured.");
  } else {
    sections.push("| Target | Status | Details |");
    sections.push("|--------|--------|---------|");
    for (const targetName of targetNames) {
      const target = emittedOutputs[targetName];
      const status = target.isValid ? "Valid" : "Invalid";
      const warningCount = target.warnings?.length ?? 0;
      const details =
        warningCount > 0 ? `${warningCount} warning(s)` : "No issues";
      sections.push(`| ${targetName} | ${status} | ${details} |`);
    }
  }
  sections.push("");

  // Migration Artifacts (collapsible)
  if (migrationArtifacts && migrationArtifacts.targets.length > 0) {
    sections.push("## Migration Artifacts");
    sections.push("");

    for (const targetMigration of migrationArtifacts.targets) {
      for (const artifact of targetMigration.artifacts) {
        sections.push(
          `<details><summary>${targetMigration.targetFormat} — ${artifact.type}</summary>`
        );
        sections.push("");
        sections.push("```");
        sections.push(artifact.content);
        sections.push("```");
        sections.push("");
        if (artifact.warnings.length > 0) {
          sections.push("**Warnings:**");
          for (const warning of artifact.warnings) {
            sections.push(`- ${warning}`);
          }
          sections.push("");
        }
        sections.push("</details>");
        sections.push("");
      }
    }
  }

  // Change Record Details (collapsible)
  if (changeInfo.changeRecord && changeInfo.changeRecord.changes.length > 0) {
    sections.push(
      "<details><summary>Detailed Field Changes</summary>"
    );
    sections.push("");

    const changes = changeInfo.changeRecord.changes;
    const added = changes.filter((c) => c.type === "added");
    const removed = changes.filter((c) => c.type === "removed");
    const modified = changes.filter((c) => c.type === "modified");

    if (added.length > 0) {
      sections.push("### Added Fields");
      for (const c of added) {
        sections.push(`- **${c.fieldName}**`);
      }
      sections.push("");
    }
    if (removed.length > 0) {
      sections.push("### Removed Fields");
      for (const c of removed) {
        sections.push(`- **${c.fieldName}**`);
      }
      sections.push("");
    }
    if (modified.length > 0) {
      sections.push("### Modified Fields");
      for (const c of modified) {
        const props = c.details.changedProperties.join(", ");
        sections.push(`- **${c.fieldName}**: changed ${props}`);
      }
      sections.push("");
    }

    sections.push("</details>");
    sections.push("");
  }

  // Governance Status
  sections.push("## Governance Status");
  sections.push("");
  sections.push(governanceStatus ?? "No governance review required.");
  sections.push("");

  // Link back to Super Schema UI
  sections.push("## Super Schema");
  sections.push("");
  if (appUrl) {
    sections.push(
      `[View in Super Schema](${appUrl}/entities/${entity.id})`
    );
  } else {
    sections.push(`Entity ID: ${entity.id}`);
  }
  sections.push("");

  sections.push("---");
  sections.push("_Generated by Super Schema Git Integration_");

  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Service functions (interact with Prisma + audit)
// ---------------------------------------------------------------------------

/**
 * Legacy export is disabled: a real delivery requires an explicit frozen workflow plan.
 */
export async function exportWithReview(
  _entityId: string,
  _versionId: string,
  _changeInfo: ChangeRecordWithClassification,
  ctx: ServiceContext
): Promise<Result<GitExportResult & { pr?: GitPrResult }>> {
  if (!ctxCan(ctx, "git.manage")) return err({ code: "FORBIDDEN", message: "Platform administrator access is required" });
  return err({ code: "WORKFLOW_REQUIRED", message: "Select a published schema version in Deployments > Git PR. Legacy exports cannot publish an unpinned artifact.", suggestedFix: "Import the legacy Git settings into a tenant deployment connection, then save and preview a workflow." });
}

/**
 * Sync PR status from GitHub API.
 */
export async function syncPrStatus(
  _prId: string,
  ctx: ServiceContext
): Promise<Result<GitPullRequestRecord>> {
  if (!ctxCan(ctx, "git.manage")) return err({ code: "FORBIDDEN", message: "Platform administrator access is required" });
  return err({ code: "WORKFLOW_REQUIRED", message: "Legacy PR records have no verified connection. Refresh the real delivery receipt in Deployments > Git PR." });
}

/**
 * Get PR history for an entity.
 */
export async function getPrHistory(
  entityId: string,
  ctx: ServiceContext
): Promise<Result<GitPullRequestRecord[]>> {
  if (!ctxCan(ctx, "git.manage")) return err({ code: "FORBIDDEN", message: "Platform administrator access is required" });
  const prs = await prisma.gitPullRequest.findMany({
    where: { entityId },
    orderBy: { createdAt: "desc" },
  });

  return ok(prs as unknown as GitPullRequestRecord[]);
}

/**
 * Get the latest PR for an entity.
 */
export async function getLatestPr(
  entityId: string,
  ctx: ServiceContext
): Promise<Result<GitPullRequestRecord | null>> {
  if (!ctxCan(ctx, "git.manage")) return err({ code: "FORBIDDEN", message: "Platform administrator access is required" });
  const pr = await prisma.gitPullRequest.findFirst({
    where: { entityId },
    orderBy: { createdAt: "desc" },
  });

  return ok((pr as unknown as GitPullRequestRecord) ?? null);
}
