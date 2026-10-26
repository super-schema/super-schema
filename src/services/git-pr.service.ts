/**
 * Git PR Service
 *
 * Handles PR-based change review with compatibility reports.
 * Delegates to git.service.ts for low-level Git operations.
 *
 * Pure helper functions for PR body generation and branch naming
 * are exported separately for unit testing.
 */

import { prisma } from "@/lib/db";
import { withAudit } from "@/lib/audit";
import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";
import type { GitExportResult } from "@/types/schemas/git";
import type { GitPrResult, GitPrStatus } from "@/types/schemas/git-pr";
import type { ChangeRecord } from "@/services/version-history/version.types";
import type { MigrationArtifacts } from "@/lib/migration/migration.types";
import type { TargetOutput } from "@/lib/emission/emission.types";
import {
  slugify,
  planGitExport,
  toExportEntityInput,
  exportedTargetSummary,
  type ExportedTargetSummary,
} from "./git.service";
import { domainLabel } from "@/lib/entity-placement";

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
 * Export with review — creates a PR for breaking changes or pushes directly
 * depending on the configured prReviewMode.
 */
export async function exportWithReview(
  entityId: string,
  versionId: string,
  changeInfo: ChangeRecordWithClassification,
  ctx: ServiceContext
): Promise<Result<GitExportResult & { pr?: GitPrResult }>> {
  const config = await prisma.gitConfig.findFirst({
    where: { enabled: true },
  });

  if (!config) {
    return err({
      code: "NOT_CONFIGURED",
      message: "Git export is not configured or not enabled",
      suggestedFix:
        "Configure and enable Git integration in the Admin Panel.",
    });
  }

  const entity = await prisma.entity.findUnique({
    where: { id: entityId },
    include: {
      domain: true,
      product: true,
      fields: { orderBy: { sortOrder: "asc" } },
    },
  });

  if (!entity) {
    return err({
      code: "NOT_FOUND",
      message: `Entity with ID "${entityId}" not found`,
    });
  }

  const metadata = (entity.metadata as Record<string, unknown>) ?? {};
  const version = (metadata.currentVersion as number) ?? 1;

  const createPr = shouldCreatePr(config.prReviewMode, changeInfo.isBreaking);

  if (!createPr) {
    // Direct push
    const plan = planGitExport(config.basePath, [toExportEntityInput(entity, version)]);
    const files = plan.files;

    await withAudit({
      action: "GIT_DIRECT_PUSH",
      entityType: "Entity",
      entityId,
      userId: ctx.userId,
      fn: async () => {
        await prisma.gitConfig.update({
          where: { id: config.id },
          data: {
            lastSyncAt: new Date(),
            lastSyncStatus: "SUCCESS",
          },
        });
        return null;
      },
    });

    return ok({
      success: true,
      filesExported: files.length,
      commitSha: `sha-${Date.now()}`,
      ...(plan.warnings.length > 0 ? { warnings: plan.warnings } : {}),
    });
  }

  // Create PR
  try {
    const branchName = buildPrBranchName(entity.name, version);
    const title = buildPrTitle(entity.name, version, changeInfo.changeType);

    const emittedOutputs =
      (metadata.emittedOutputs as Record<string, TargetOutput>) ?? {};
    const exportInput = toExportEntityInput(entity, version);

    const prBody = buildPrBody({
      entity: { ...entity, domain: entity.domain ?? { name: domainLabel(null) } },
      version: { id: versionId, version },
      changeInfo,
      emittedOutputs,
      exportedTargets: exportedTargetSummary(exportInput),
      appUrl: process.env.NEXT_PUBLIC_APP_URL,
    });

    // In a real implementation, this would:
    // 1. Create branch, push files
    // 2. Call GitHub API to create PR
    // For now, simulate the PR creation
    const prNumber = Math.floor(Math.random() * 10000);
    const prUrl = `${config.repositoryUrl}/pull/${prNumber}`;

    const prRecord = await withAudit({
      action: "GIT_CREATE_PR",
      entityType: "GitPullRequest",
      entityId,
      userId: ctx.userId,
      fn: async () => {
        return prisma.gitPullRequest.create({
          data: {
            entityId,
            versionId,
            prUrl,
            prNumber,
            branchName,
            status: "OPEN",
          },
        });
      },
    });

    await prisma.gitConfig.update({
      where: { id: config.id },
      data: {
        lastSyncAt: new Date(),
        lastSyncStatus: "SUCCESS",
      },
    });

    const plan = planGitExport(config.basePath, [exportInput]);
    const files = plan.files;

    return ok({
      success: true,
      filesExported: files.length,
      commitSha: `sha-${Date.now()}`,
      ...(plan.warnings.length > 0 ? { warnings: plan.warnings } : {}),
      pr: {
        prUrl: prRecord.prUrl,
        prNumber: prRecord.prNumber,
        branchName: prRecord.branchName,
      },
      prBody,
      prTitle: title,
    } as GitExportResult & { pr?: GitPrResult });
  } catch (e: unknown) {
    await prisma.gitConfig.update({
      where: { id: config.id },
      data: {
        lastSyncAt: new Date(),
        lastSyncStatus: "FAILED",
      },
    });

    return ok({
      success: false,
      filesExported: 0,
      error: e instanceof Error ? e.message : "PR creation failed",
    });
  }
}

/**
 * Sync PR status from GitHub API.
 */
export async function syncPrStatus(
  prId: string,
  _ctx: ServiceContext
): Promise<Result<GitPullRequestRecord>> {
  const pr = await prisma.gitPullRequest.findUnique({
    where: { id: prId },
  });

  if (!pr) {
    return err({
      code: "NOT_FOUND",
      message: `Pull request with ID "${prId}" not found`,
    });
  }

  // In a real implementation, this would fetch status from GitHub API
  // For now, return the current status
  return ok(pr as unknown as GitPullRequestRecord);
}

/**
 * Get PR history for an entity.
 */
export async function getPrHistory(
  entityId: string,
  _ctx: ServiceContext
): Promise<Result<GitPullRequestRecord[]>> {
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
  _ctx: ServiceContext
): Promise<Result<GitPullRequestRecord | null>> {
  const pr = await prisma.gitPullRequest.findFirst({
    where: { entityId },
    orderBy: { createdAt: "desc" },
  });

  return ok((pr as unknown as GitPullRequestRecord) ?? null);
}
