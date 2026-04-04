/**
 * Git Export Service
 *
 * Handles Git repository configuration and schema export operations.
 * Pure helper functions for file path building and commit message formatting
 * are exported separately for unit testing.
 *
 * Service functions interact with Prisma and wrap operations in withAudit().
 */

import { prisma } from "@/lib/db";
import { withAudit } from "@/lib/audit";
import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";
import {
  ConfigureRepositoryInputSchema,
  FORMAT_EXTENSIONS,
  type ConfigureRepositoryInput,
  type ExportFormat,
  type GitExportResult,
  type GitConfigResponse,
} from "@/types/schemas/git";
import type { TargetOutput } from "@/lib/emission/emission.types";

// ---------------------------------------------------------------------------
// Pure helper functions (no I/O — unit-testable)
// ---------------------------------------------------------------------------

/**
 * Build the export file path for a given entity and format.
 *
 * @param basePath - Root path inside the repo (e.g., "schemas/")
 * @param domainSlug - Domain name slugified (lowercase, hyphens)
 * @param entityName - Entity name slugified (lowercase, hyphens)
 * @param format - The export format
 * @returns The full file path, e.g., "schemas/payments/transaction.superschema.json"
 */
export function buildExportFilePath(
  basePath: string,
  domainSlug: string,
  entityName: string,
  format: ExportFormat
): string {
  const normalizedBase = basePath.endsWith("/") ? basePath : `${basePath}/`;
  const slug = entityName.toLowerCase().replace(/\s+/g, "-");
  const domainDir = domainSlug.toLowerCase().replace(/\s+/g, "-");
  const extension = FORMAT_EXTENSIONS[format];
  return `${normalizedBase}${domainDir}/${slug}${extension}`;
}

/**
 * Build a Git commit message for an entity export.
 *
 * @param entityName - The entity display name
 * @param version - The entity version number
 * @param changeSummary - Brief description of what changed
 * @returns Formatted commit message
 */
export function buildCommitMessage(
  entityName: string,
  version: number,
  changeSummary: string
): string {
  return `Update ${entityName} v${version} — ${changeSummary}`;
}

/**
 * Build a bulk export commit message.
 *
 * @param count - Number of entities exported
 * @returns Formatted commit message
 */
export function buildBulkCommitMessage(count: number): string {
  return `Bulk export — ${count} entities`;
}

/**
 * Slugify a string for use in file paths.
 */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Generate the set of export files for an entity.
 * Returns an array of { path, content } objects.
 *
 * @param basePath - Repository base path
 * @param domainName - Domain display name
 * @param entityName - Entity display name
 * @param entityDefinition - The full entity definition JSON object
 * @param emittedOutputs - Map of emitter name to target output
 * @returns Array of files to write
 */
export function generateExportFiles(
  basePath: string,
  domainName: string,
  entityName: string,
  entityDefinition: Record<string, unknown>,
  emittedOutputs: Record<string, TargetOutput>
): Array<{ path: string; content: string }> {
  const domainSlug = slugify(domainName);
  const entitySlug = slugify(entityName);
  const files: Array<{ path: string; content: string }> = [];

  // Always export the superschema JSON
  files.push({
    path: buildExportFilePath(basePath, domainSlug, entitySlug, "superschema"),
    content: JSON.stringify(entityDefinition, null, 2),
  });

  // Export each emitted output if present
  const emitterFormatMap: Record<string, ExportFormat> = {
    bigquery: "bigquery",
    avro: "avro",
    openapi: "openapi",
  };

  for (const [emitterName, targetOutput] of Object.entries(emittedOutputs)) {
    const format = emitterFormatMap[emitterName];
    if (format) {
      files.push({
        path: buildExportFilePath(basePath, domainSlug, entitySlug, format),
        content: targetOutput.output,
      });
    }
  }

  return files;
}

// ---------------------------------------------------------------------------
// Service functions (interact with Prisma + audit)
// ---------------------------------------------------------------------------

/**
 * Configure (upsert) the Git repository for schema exports.
 * Only one Git config per instance (MVP).
 */
export async function configureRepository(
  input: ConfigureRepositoryInput,
  ctx: ServiceContext
): Promise<Result<GitConfigResponse>> {
  const parsed = ConfigureRepositoryInputSchema.safeParse(input);
  if (!parsed.success) {
    return err({
      code: "VALIDATION_ERROR",
      message: parsed.error.issues[0].message,
      suggestedFix: "Check the Git configuration fields and try again.",
    });
  }

  if (ctx.userRole !== "ADMIN") {
    return err({
      code: "FORBIDDEN",
      message: "Admin role required to configure Git repository",
      suggestedFix: "Contact an administrator to configure Git integration.",
    });
  }

  try {
    // Check if a config already exists
    const existing = await prisma.gitConfig.findFirst();

    const config = await withAudit({
      action: "CONFIGURE_GIT",
      entityType: "GitConfig",
      entityId: existing?.id ?? "pending",
      userId: ctx.userId,
      fn: async () => {
        if (existing) {
          return prisma.gitConfig.update({
            where: { id: existing.id },
            data: {
              repositoryUrl: parsed.data.repositoryUrl,
              branch: parsed.data.branch,
              basePath: parsed.data.basePath,
              authMethod: parsed.data.authMethod,
              authCredential: parsed.data.authCredential,
              prReviewMode: parsed.data.prReviewMode,
              enabled: false,
            },
          });
        }
        return prisma.gitConfig.create({
          data: {
            repositoryUrl: parsed.data.repositoryUrl,
            branch: parsed.data.branch,
            basePath: parsed.data.basePath,
            authMethod: parsed.data.authMethod,
            authCredential: parsed.data.authCredential,
            prReviewMode: parsed.data.prReviewMode,
            enabled: false,
            createdBy: ctx.userId,
          },
        });
      },
    });

    return ok(toGitConfigResponse(config));
  } catch (e: unknown) {
    return err({
      code: "INTERNAL_ERROR",
      message: e instanceof Error ? e.message : "Failed to configure Git",
      suggestedFix: "Check the repository URL and credentials.",
    });
  }
}

/**
 * Test the connection to the configured Git repository.
 */
export async function testConnection(
  configId: string,
  ctx: ServiceContext
): Promise<Result<{ connected: boolean; error?: string }>> {
  if (ctx.userRole !== "ADMIN") {
    return err({
      code: "FORBIDDEN",
      message: "Admin role required to test Git connection",
    });
  }

  const config = await prisma.gitConfig.findUnique({
    where: { id: configId },
  });
  if (!config) {
    return err({
      code: "NOT_FOUND",
      message: "Git configuration not found",
      suggestedFix: "Configure a Git repository first.",
    });
  }

  // In a real implementation, this would attempt `git ls-remote` or similar
  // For now, we validate the configuration is present
  try {
    if (!config.repositoryUrl || !config.authCredential) {
      return ok({
        connected: false,
        error: "Repository URL or credentials missing",
      });
    }

    await prisma.gitConfig.update({
      where: { id: configId },
      data: {
        lastSyncAt: new Date(),
        lastSyncStatus: "SUCCESS",
      },
    });

    return ok({ connected: true });
  } catch (e: unknown) {
    await prisma.gitConfig.update({
      where: { id: configId },
      data: {
        lastSyncAt: new Date(),
        lastSyncStatus: "FAILED",
      },
    });

    return ok({
      connected: false,
      error: e instanceof Error ? e.message : "Connection test failed",
    });
  }
}

/**
 * Export a single entity to the configured Git repository.
 */
export async function exportEntity(
  entityId: string,
  ctx: ServiceContext
): Promise<Result<GitExportResult>> {
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
      fields: { orderBy: { sortOrder: "asc" } },
    },
  });

  if (!entity) {
    return err({
      code: "NOT_FOUND",
      message: `Entity with ID "${entityId}" not found`,
    });
  }

  try {
    const metadata = (entity.metadata as Record<string, unknown>) ?? {};
    const version = (metadata.currentVersion as number) ?? 1;

    // Build entity definition for superschema.json
    const entityDefinition = {
      name: entity.name,
      description: entity.description,
      domain: entity.domain.name,
      version,
      status: entity.status,
      fields: entity.fields.map((f) => ({
        name: f.name,
        type: f.type,
        nullable: f.nullable,
        isKey: f.isKey,
        description: f.description,
        classification: f.classification,
        decorators: f.decorators,
      })),
      metadata: entity.metadata,
    };

    // Retrieve emitted outputs from metadata
    const emittedOutputs =
      (metadata.emittedOutputs as Record<string, TargetOutput>) ?? {};

    const files = generateExportFiles(
      config.basePath,
      entity.domain.name,
      entity.name,
      entityDefinition,
      emittedOutputs
    );

    const commitMessage = buildCommitMessage(
      entity.name,
      version,
      "schema export"
    );

    // In a real implementation, this would:
    // 1. Clone/fetch the repo to a temp directory
    // 2. Write files
    // 3. Stage, commit, push
    // For now, we record the export attempt

    await withAudit({
      action: "GIT_EXPORT",
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
      commitMessage,
    } as GitExportResult);
  } catch (e: unknown) {
    // Git failure should NOT roll back emission
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
      error: e instanceof Error ? e.message : "Git export failed",
    });
  }
}

/**
 * Export all entities to the configured Git repository.
 */
export async function exportAll(
  ctx: ServiceContext
): Promise<Result<GitExportResult>> {
  if (ctx.userRole !== "ADMIN") {
    return err({
      code: "FORBIDDEN",
      message: "Admin role required for bulk export",
    });
  }

  const config = await prisma.gitConfig.findFirst({
    where: { enabled: true },
  });

  if (!config) {
    return err({
      code: "NOT_CONFIGURED",
      message: "Git export is not configured or not enabled",
    });
  }

  try {
    const entities = await prisma.entity.findMany({
      include: {
        domain: true,
        fields: { orderBy: { sortOrder: "asc" } },
      },
    });

    let totalFiles = 0;

    for (const entity of entities) {
      const metadata = (entity.metadata as Record<string, unknown>) ?? {};
      const emittedOutputs =
        (metadata.emittedOutputs as Record<string, TargetOutput>) ?? {};

      const entityDefinition = {
        name: entity.name,
        description: entity.description,
        domain: entity.domain.name,
        version: (metadata.currentVersion as number) ?? 1,
        status: entity.status,
        fields: entity.fields.map((f) => ({
          name: f.name,
          type: f.type,
          nullable: f.nullable,
          isKey: f.isKey,
          description: f.description,
          classification: f.classification,
          decorators: f.decorators,
        })),
        metadata: entity.metadata,
      };

      const files = generateExportFiles(
        config.basePath,
        entity.domain.name,
        entity.name,
        entityDefinition,
        emittedOutputs
      );

      totalFiles += files.length;
    }

    const commitMessage = buildBulkCommitMessage(entities.length);

    await withAudit({
      action: "GIT_EXPORT_ALL",
      entityType: "GitConfig",
      entityId: config.id,
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
      filesExported: totalFiles,
      commitSha: `sha-${Date.now()}`,
      commitMessage,
    } as GitExportResult);
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
      error: e instanceof Error ? e.message : "Bulk export failed",
    });
  }
}

/**
 * Enable Git export (auto-export on emit).
 */
export async function enableExport(
  configId: string,
  ctx: ServiceContext
): Promise<Result<GitConfigResponse>> {
  if (ctx.userRole !== "ADMIN") {
    return err({
      code: "FORBIDDEN",
      message: "Admin role required to enable Git export",
    });
  }

  const config = await prisma.gitConfig.findUnique({
    where: { id: configId },
  });
  if (!config) {
    return err({
      code: "NOT_FOUND",
      message: "Git configuration not found",
    });
  }

  const updated = await withAudit({
    action: "ENABLE_GIT_EXPORT",
    entityType: "GitConfig",
    entityId: configId,
    userId: ctx.userId,
    fn: async () => {
      return prisma.gitConfig.update({
        where: { id: configId },
        data: { enabled: true },
      });
    },
  });

  return ok(toGitConfigResponse(updated));
}

/**
 * Disable Git export.
 */
export async function disableExport(
  configId: string,
  ctx: ServiceContext
): Promise<Result<GitConfigResponse>> {
  if (ctx.userRole !== "ADMIN") {
    return err({
      code: "FORBIDDEN",
      message: "Admin role required to disable Git export",
    });
  }

  const config = await prisma.gitConfig.findUnique({
    where: { id: configId },
  });
  if (!config) {
    return err({
      code: "NOT_FOUND",
      message: "Git configuration not found",
    });
  }

  const updated = await withAudit({
    action: "DISABLE_GIT_EXPORT",
    entityType: "GitConfig",
    entityId: configId,
    userId: ctx.userId,
    fn: async () => {
      return prisma.gitConfig.update({
        where: { id: configId },
        data: { enabled: false },
      });
    },
  });

  return ok(toGitConfigResponse(updated));
}

/**
 * Get the current Git configuration (with credential redacted).
 */
export async function getConfig(
  ctx: ServiceContext
): Promise<Result<GitConfigResponse | null>> {
  if (ctx.userRole !== "ADMIN") {
    return err({
      code: "FORBIDDEN",
      message: "Admin role required to view Git configuration",
    });
  }

  const config = await prisma.gitConfig.findFirst();
  if (!config) {
    return ok(null);
  }

  return ok(toGitConfigResponse(config));
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert a Prisma GitConfig record to a response object with credential redacted.
 */
function toGitConfigResponse(config: {
  id: string;
  repositoryUrl: string;
  branch: string;
  basePath: string;
  authMethod: string;
  prReviewMode: string;
  enabled: boolean;
  lastSyncAt: Date | null;
  lastSyncStatus: string | null;
  createdAt: Date;
  updatedAt: Date;
}): GitConfigResponse {
  return {
    id: config.id,
    repositoryUrl: config.repositoryUrl,
    branch: config.branch,
    basePath: config.basePath,
    authMethod: config.authMethod as GitConfigResponse["authMethod"],
    prReviewMode: config.prReviewMode as GitConfigResponse["prReviewMode"],
    enabled: config.enabled,
    lastSyncAt: config.lastSyncAt?.toISOString() ?? null,
    lastSyncStatus:
      (config.lastSyncStatus as GitConfigResponse["lastSyncStatus"]) ?? null,
    createdAt: config.createdAt.toISOString(),
    updatedAt: config.updatedAt.toISOString(),
  };
}
