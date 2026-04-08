"use server";

import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { auth } from "@/lib/auth";
import { withAudit } from "@/lib/audit";
import { revalidatePath } from "next/cache";
import { generateSlug } from "@/lib/slug";
import { TypeSpecDecoratorSchema } from "@/types/schemas/typespec-decorator.schema";
import { updateEntity } from "@/services/entity.service";
import type { UpdateEntityInput } from "@/types/schemas/entity.schema";
import type { Relationship } from "@/types/schemas/entity-metadata.schema";
import { getEffectiveRole } from "@/services/rbac.service";
import {
  buildSchemaTargetFieldMappings,
  parseSchemaTargetTypeOverrides,
  removeFieldTargetTypeOverride,
  toFieldOverridePolicies,
  upsertFieldTargetTypeOverride,
  type FieldTargetTypeOverride,
  type SchemaTargetTypeOverrides,
} from "@/lib/schema-targets/field-type-overrides";
import { getSchemaTargetDefinition } from "@/lib/schema-targets/catalog";
import { getTargetTypeCatalogEntry } from "@/lib/type-mapping/target-type-catalog";
import { getOverridesForEntity } from "@/services/type-mapping.service";

/**
 * Look up the effective role for the current user.
 * TODO: Once RBAC roles are persisted to the database, this will return
 * the actual role. For now (MVP in-memory store), it falls back to "AUTHOR".
 */
async function resolveUserRole(userId: string): Promise<string> {
  const result = await getEffectiveRole(userId, null, {
    userId,
    userRole: "VIEWER",
    prisma,
  });
  if (result.success && result.data) {
    return result.data;
  }
  // Default fallback for MVP — no roles assigned yet in in-memory store
  return "AUTHOR";
}

export async function addFieldAction(
  entityId: string,
  name: string,
  type: string,
  opts?: {
    description?: string;
    classification?: string | null;
    nullable?: boolean;
    isKey?: boolean;
    precision?: number | null;
    scale?: number | null;
    fieldNumber?: number | null;
    aliases?: string[];
    decorators?: Record<string, unknown>;
  }
) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };

  const maxField = await prisma.field.findFirst({
    where: { entityId },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });

  // Validate typespec sub-key if present on create
  if (opts?.decorators?.typespec) {
    const validation = TypeSpecDecoratorSchema.safeParse(opts.decorators.typespec);
    if (!validation.success) {
      return { error: `Invalid TypeSpec decorators: ${validation.error.message}` };
    }
  }

  // Auto-assign field number if not provided
  let assignedFieldNumber = opts?.fieldNumber ?? null;
  if (assignedFieldNumber == null) {
    const maxFieldNumber = await prisma.field.findFirst({
      where: { entityId, fieldNumber: { not: null } },
      orderBy: { fieldNumber: "desc" },
      select: { fieldNumber: true },
    });
    if (maxFieldNumber?.fieldNumber != null) {
      assignedFieldNumber = maxFieldNumber.fieldNumber + 1;
    } else {
      // Fall back to sortOrder + 1 if no field numbers exist
      assignedFieldNumber = (maxField ? maxField.sortOrder + 1 : 0) + 1;
    }
  }

  // Validate field number uniqueness
  if (assignedFieldNumber != null) {
    const conflict = await prisma.field.findFirst({
      where: { entityId, fieldNumber: assignedFieldNumber },
      select: { name: true },
    });
    if (conflict) {
      return { error: `Field number ${assignedFieldNumber} is already assigned to field '${conflict.name}'` };
    }
  }

  try {
    const field = await withAudit({
      action: "CREATE",
      entityType: "Field",
      entityId: "pending",
      userId: session.user.id,
      fn: () =>
        prisma.field.create({
          data: {
            entityId,
            name,
            slug: generateSlug(name),
            type,
            sortOrder: maxField ? maxField.sortOrder + 1 : 0,
            ...(opts?.description != null && { description: opts.description }),
            classification: opts?.classification !== undefined ? opts.classification : "SENSITIVE",
            ...(opts?.nullable != null && { nullable: opts.nullable }),
            ...(opts?.isKey != null && { isKey: opts.isKey }),
            ...(opts?.precision !== undefined && { precision: opts.precision }),
            ...(opts?.scale !== undefined && { scale: opts.scale }),
            fieldNumber: assignedFieldNumber,
            ...(opts?.aliases && { aliases: opts.aliases }),
            ...(opts?.decorators && { decorators: opts.decorators as Prisma.InputJsonValue }),
          },
        }),
    });
    revalidatePath("/schemas");
    return { success: true, field };
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes("Unique constraint")) {
      return { error: `Field "${name}" already exists` };
    }
    const message = e instanceof Error ? e.message : "Failed to create field";
    return { error: message };
  }
}

export async function updateFieldAction(
  fieldId: string,
  data: {
    name?: string;
    type?: string;
    nullable?: boolean;
    isKey?: boolean;
    description?: string;
    classification?: string | null;
    precision?: number | null;
    scale?: number | null;
    fieldNumber?: number | null;
    aliases?: string[];
    decorators?: Record<string, unknown>;
  }
) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };

  const existing = await prisma.field.findUnique({ where: { id: fieldId } });
  if (!existing) return { error: "Field not found" };

  const { decorators, ...rest } = data;

  // Regenerate slug when name changes
  if (rest.name && rest.name !== existing.name) {
    (rest as Record<string, unknown>).slug = generateSlug(rest.name);
  }

  // Validate typespec sub-key if present
  if (decorators?.typespec) {
    const validation = TypeSpecDecoratorSchema.safeParse(decorators.typespec);
    if (!validation.success) {
      return { error: `Invalid TypeSpec decorators: ${validation.error.message}` };
    }
  }

  // Validate field number uniqueness
  if (data.fieldNumber != null) {
    const conflict = await prisma.field.findFirst({
      where: {
        entityId: existing.entityId,
        fieldNumber: data.fieldNumber,
        id: { not: fieldId },
      },
      select: { name: true },
    });
    if (conflict) {
      return { error: `Field number ${data.fieldNumber} is already assigned to field '${conflict.name}'` };
    }
  }

  try {
    await withAudit({
      action: "UPDATE",
      entityType: "Field",
      entityId: fieldId,
      userId: session.user.id,
      beforeState: existing as unknown as object,
      fn: () =>
        prisma.field.update({
          where: { id: fieldId },
          data: {
            ...rest,
            ...(decorators !== undefined && { decorators: decorators as Prisma.InputJsonValue }),
          },
        }),
    });

    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes("Unique constraint")) {
      return { error: `A field with that name already exists` };
    }
    const message = e instanceof Error ? e.message : "Failed to update field";
    return { error: message };
  }
}

export async function updateEntityStatusAction(
  entityId: string,
  status: string,
  metadata?: Record<string, unknown>
) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };

  const input: Record<string, unknown> = { status };
  if (metadata) {
    input.metadata = metadata;
  }

  const userRole = await resolveUserRole(session.user.id);
  const result = await updateEntity(entityId, input as UpdateEntityInput, {
    userId: session.user.id,
    userRole,
    prisma,
  });

  if (!result.success) {
    return { error: result.error.message };
  }

  revalidatePath("/schemas");
  return { success: true };
}

/**
 * Update the relationships array in entity metadata JSONB.
 * Used when reference fields are created/updated/deleted.
 */
export async function updateEntityRelationshipsAction(
  entityId: string,
  relationships: Relationship[]
) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };

  const entity = await prisma.entity.findUnique({
    where: { id: entityId },
    select: { metadata: true },
  });
  if (!entity) return { error: "Entity not found" };

  const existingMeta = (entity.metadata as Record<string, unknown>) ?? {};
  const updatedMeta = { ...existingMeta, relationships };

  try {
    await withAudit({
      action: "UPDATE",
      entityType: "Entity",
      entityId,
      userId: session.user.id,
      beforeState: { metadata: existingMeta } as unknown as object,
      fn: () =>
        prisma.entity.update({
          where: { id: entityId },
          data: { metadata: updatedMeta as unknown as Prisma.InputJsonValue },
        }),
    });

    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Failed to update relationships";
    return { error: message };
  }
}

/**
 * Run the full emission pipeline for an entity.
 * Returns TypeSpec source + per-target emitted outputs with validation.
 */
export async function emitEntityAction(entityId: string) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };

  try {
    const { emitEntity } = await import("@/lib/emission/emission.service");
    const result = await emitEntity(entityId);
    return { success: true, result };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Emission failed";
    return { error: message };
  }
}

/**
 * Create a type mapping override (global or per-entity).
 */
export async function createTypeMappingOverrideAction(input: {
  sourceType: string;
  targetFormat: string;
  mappedType: string;
  justification: string;
  scope: "global" | "per-entity";
  entityId: string;
  isLossy: boolean;
}) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };

  const { createGlobalOverride, createEntityOverride } = await import(
    "@/services/type-mapping.service"
  );

  const userRole = await resolveUserRole(session.user.id);
  const ctx = {
    userId: session.user.id,
    userRole,
    prisma,
  };

  if (input.scope === "global") {
    const result = await createGlobalOverride(
      {
        sourceType: input.sourceType,
        targetFormat: input.targetFormat,
        mappedType: input.mappedType,
        justification: input.justification,
        isLossy: input.isLossy,
      },
      ctx
    );
    if (!result.success) return { error: result.error.message };
    return { success: true, override: result.data };
  } else {
    const result = await createEntityOverride(
      {
        sourceType: input.sourceType,
        targetFormat: input.targetFormat,
        mappedType: input.mappedType,
        justification: input.justification,
        isLossy: input.isLossy,
        entityId: input.entityId,
      },
      ctx
    );
    if (!result.success) return { error: result.error.message };
    return { success: true, override: result.data };
  }
}

/**
 * Acknowledge a lossy type mapping for a specific entity.
 */
export async function acknowledgeLossyMappingAction(input: {
  entityId: string;
  sourceType: string;
  targetFormat: string;
}) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };

  const { acknowledgeLossyMapping } = await import(
    "@/services/type-mapping.service"
  );

  const userRole = await resolveUserRole(session.user.id);
  const result = await acknowledgeLossyMapping(input, {
    userId: session.user.id,
    userRole,
    prisma,
  });

  if (!result.success) return { error: result.error.message };
  return { success: true };
}

/**
 * Create a new version snapshot for an entity.
 */
export async function createVersionAction(entityId: string) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };

  try {
    const { createSnapshot } = await import(
      "@/services/version-history/version.service"
    );
    const userRole = await resolveUserRole(session.user.id);
    const result = await createSnapshot(entityId, {
      userId: session.user.id,
      userRole,
      prisma,
    });

    if (!result.success) {
      return { error: result.error.message };
    }

    revalidatePath("/schemas");
    return { success: true, version: result.data };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Failed to create version";
    return { error: message };
  }
}

/**
 * Get version history for an entity.
 */
export async function getVersionHistoryAction(entityId: string) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated", versions: [] };

  try {
    const { getVersionHistory } = await import(
      "@/services/version-history/version.service"
    );
    const userRole = await resolveUserRole(session.user.id);
    const result = await getVersionHistory(entityId, {
      userId: session.user.id,
      userRole,
      prisma,
    });

    if (!result.success) {
      return { error: result.error.message, versions: [] };
    }

    return { success: true, versions: result.data };
  } catch (e: unknown) {
    const message =
      e instanceof Error ? e.message : "Failed to get version history";
    return { error: message, versions: [] };
  }
}

/**
 * Compare two versions and return structured diff result.
 */
export async function compareVersionsAction(
  entityId: string,
  v1: number,
  v2: number
) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };

  try {
    const { compareVersionsStructured } = await import(
      "@/services/version-history/version.service"
    );
    const userRole = await resolveUserRole(session.user.id);
    const result = await compareVersionsStructured(entityId, v1, v2, {
      userId: session.user.id,
      userRole,
      prisma,
    });

    if (!result.success) {
      return { error: result.error.message };
    }

    return { success: true, diff: result.data };
  } catch (e: unknown) {
    const message =
      e instanceof Error ? e.message : "Failed to compare versions";
    return { error: message };
  }
}

/**
 * Get change history for an entity (unified timeline of versions + audit entries).
 */
export async function getChangeHistoryAction(
  entityId: string,
  filters?: {
    changeTypes?: string[];
    userId?: string;
    dateFrom?: string;
    dateTo?: string;
  },
  cursor?: string
) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };

  try {
    const { getChangeHistory } = await import(
      "@/services/change-history.service"
    );
    const parsedFilters = filters
      ? {
          changeTypes: filters.changeTypes as import("@/types/schemas/change-history").ChangeType[] | undefined,
          userId: filters.userId,
          dateFrom: filters.dateFrom ? new Date(filters.dateFrom) : undefined,
          dateTo: filters.dateTo ? new Date(filters.dateTo) : undefined,
        }
      : undefined;

    const userRole = await resolveUserRole(session.user.id);
    const result = await getChangeHistory(
      entityId,
      {
        userId: session.user.id,
        userRole,
        prisma,
      },
      parsedFilters,
      cursor
    );

    if (!result.success) {
      return { error: result.error.message };
    }

    return {
      success: true,
      entries: result.data.entries,
      hasMore: result.data.hasMore,
      nextCursor: result.data.nextCursor,
    };
  } catch (e: unknown) {
    const message =
      e instanceof Error ? e.message : "Failed to get change history";
    return { error: message };
  }
}

/**
 * Generate a TypeSpec preview for an entity.
 * Compiles the entity + fields into a SuperSchemaModel IR, then generates TypeSpec source.
 */
export async function generateTypeSpecPreviewAction(entityId: string) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated", source: "" };

  try {
    const entity = await prisma.entity.findUnique({
      where: { id: entityId },
      include: { domain: true },
    });
    if (!entity) return { error: "Entity not found", source: "" };

    const fields = await prisma.field.findMany({
      where: { entityId },
      orderBy: { sortOrder: "asc" },
    });

    const { compileEntity } = await import("@/lib/compiler/compiler.service");
    const { generateTypeSpec } = await import("@/lib/compiler/typespec-generator");

    // Adapt Prisma entity to PrismaEntityInput shape (add slug derived from name)
    const entityInput = {
      ...entity,
      domain: entity.domain
        ? { ...entity.domain, slug: entity.domain.name.toLowerCase().replace(/\s+/g, "-") }
        : null,
    };
    const model = compileEntity(entityInput, fields);
    const source = generateTypeSpec(model);

    return { success: true, source };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Failed to generate TypeSpec preview";
    return { error: message, source: "" };
  }
}

export async function deleteFieldAction(fieldId: string) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };

  const existing = await prisma.field.findUnique({ where: { id: fieldId } });
  if (!existing) return { error: "Field not found" };

  try {
    // If this is a reference field, clean up relationship from entity metadata
    if (existing.type === "reference") {
      const entity = await prisma.entity.findUnique({
        where: { id: existing.entityId },
        select: { metadata: true },
      });
      if (entity?.metadata) {
        const meta = entity.metadata as Record<string, unknown>;
        const relationships = (meta.relationships as Relationship[]) ?? [];
        const filtered = relationships.filter((r) => r.fieldId !== fieldId);
        if (filtered.length !== relationships.length) {
          await prisma.entity.update({
            where: { id: existing.entityId },
            data: {
              metadata: { ...meta, relationships: filtered } as Prisma.InputJsonValue,
            },
          });
        }
      }
    }

    await withAudit({
      action: "DELETE",
      entityType: "Field",
      entityId: fieldId,
      userId: session.user.id,
      beforeState: existing as unknown as object,
      fn: async () => {
        await prisma.field.delete({ where: { id: fieldId } });
        return null;
      },
    });

    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Failed to delete field";
    return { error: message };
  }
}

// ---------------------------------------------------------------------------
// Bidirectional TypeSpec editing — apply parsed TypeSpec to entity fields
// ---------------------------------------------------------------------------

export interface ApplyTypeSpecResult {
  added: number;
  updated: number;
  removed: string[];
  error?: string;
}

export async function applyTypeSpecAction(
  entityId: string,
  parsedFields: Array<{
    name: string;
    type: string;
    isOptional: boolean;
    isKey: boolean;
    decorators: Record<string, unknown>;
    arrayElementType?: string;
  }>,
  fieldsToRemove?: string[]
): Promise<ApplyTypeSpecResult> {
  const session = await auth();
  if (!session?.user?.id) return { added: 0, updated: 0, removed: [], error: "Not authenticated" };

  try {
    // Get existing fields for this entity
    const existingFields = await prisma.field.findMany({
      where: { entityId },
      orderBy: { sortOrder: "asc" },
    });

    const existingByName = new Map(existingFields.map((f) => [f.name, f]));

    let addedCount = 0;
    let updatedCount = 0;
    const removedNames: string[] = [];

    // Get max sort order for new fields
    const maxSort = existingFields.reduce((max, f) => Math.max(max, f.sortOrder), -1);
    let nextSort = maxSort + 1;

    // Get max field number for new fields
    const maxFieldNum = existingFields.reduce(
      (max, f) => Math.max(max, f.fieldNumber ?? 0),
      0
    );
    let nextFieldNum = maxFieldNum + 1;

    for (const pf of parsedFields) {
      const existing = existingByName.get(pf.name);

      // Build decorators JSONB from parsed decorators
      const decoratorsJson = buildDecoratorsJson(pf.decorators, pf.arrayElementType);

      if (!existing) {
        // Create new field
        await withAudit({
          action: "CREATE",
          entityType: "Field",
          entityId: "pending",
          userId: session.user.id,
          fn: () =>
            prisma.field.create({
              data: {
                entityId,
                name: pf.name,
                slug: generateSlug(pf.name),
                type: pf.type,
                sortOrder: nextSort++,
                nullable: pf.isOptional,
                isKey: pf.isKey,
                fieldNumber: nextFieldNum++,
                description: (pf.decorators.doc as string) ?? "",
                classification: extractClassification(pf.decorators.tag as string | undefined),
                decorators: decoratorsJson as Prisma.InputJsonValue,
                ...(pf.type === "array" && pf.arrayElementType
                  ? {} // arrayElementType is stored in decorators
                  : {}),
              },
            }),
        });
        addedCount++;
      } else {
        // Check if anything changed
        const needsUpdate =
          existing.type !== pf.type ||
          existing.nullable !== pf.isOptional ||
          existing.isKey !== pf.isKey ||
          (pf.decorators.doc && existing.description !== pf.decorators.doc);

        if (needsUpdate) {
          await withAudit({
            action: "UPDATE",
            entityType: "Field",
            entityId: existing.id,
            userId: session.user.id,
            beforeState: existing as unknown as object,
            fn: () =>
              prisma.field.update({
                where: { id: existing.id },
                data: {
                  type: pf.type,
                  nullable: pf.isOptional,
                  isKey: pf.isKey,
                  description: (pf.decorators.doc as string) ?? existing.description,
                  classification: extractClassification(pf.decorators.tag as string | undefined) ?? existing.classification,
                  decorators: decoratorsJson as Prisma.InputJsonValue,
                },
              }),
          });
          updatedCount++;
        }
      }
    }

    // Handle field removal (only if explicitly requested)
    if (fieldsToRemove && fieldsToRemove.length > 0) {
      for (const fieldName of fieldsToRemove) {
        const existing = existingByName.get(fieldName);
        if (existing) {
          await withAudit({
            action: "DELETE",
            entityType: "Field",
            entityId: existing.id,
            userId: session.user.id,
            beforeState: existing as unknown as object,
            fn: async () => {
              await prisma.field.delete({ where: { id: existing.id } });
              return null;
            },
          });
          removedNames.push(fieldName);
        }
      }
    }

    revalidatePath("/schemas");
    return { added: addedCount, updated: updatedCount, removed: removedNames };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Failed to apply TypeSpec";
    return { added: 0, updated: 0, removed: [], error: message };
  }
}

/**
 * Build the decorators JSONB from parsed TypeSpec decorators.
 */
function buildDecoratorsJson(
  decorators: Record<string, unknown>,
  arrayElementType?: string
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  // TypeSpec sub-key for identity & semantics
  const identity: Record<string, unknown> = {};
  if (decorators.secret) identity.secret = true;
  if (decorators.format) identity.format = decorators.format;
  if (Object.keys(identity).length > 0) {
    if (!result.typespec) result.typespec = {};
    (result.typespec as Record<string, unknown>).identity = identity;
  }

  // TypeSpec sub-key for validation
  const validation: Record<string, unknown> = {};
  if (decorators.minLength != null) validation.minLength = decorators.minLength;
  if (decorators.maxLength != null) validation.maxLength = decorators.maxLength;
  if (decorators.minValue != null) validation.minValue = decorators.minValue;
  if (decorators.maxValue != null) validation.maxValue = decorators.maxValue;
  if (decorators.minValueExclusive != null) validation.minValueExclusive = decorators.minValueExclusive;
  if (decorators.maxValueExclusive != null) validation.maxValueExclusive = decorators.maxValueExclusive;
  if (decorators.pattern) validation.pattern = decorators.pattern;
  if (decorators.minItems != null) validation.minItems = decorators.minItems;
  if (decorators.maxItems != null) validation.maxItems = decorators.maxItems;
  if (Object.keys(validation).length > 0) {
    if (!result.typespec) result.typespec = {};
    (result.typespec as Record<string, unknown>).validation = validation;
  }

  // TypeSpec sub-key for wire format
  const wireFormat: Record<string, unknown> = {};
  if (decorators.encode) wireFormat.encode = decorators.encode;
  if (decorators.encodeSubType) wireFormat.encodeSubType = decorators.encodeSubType;
  if (Object.keys(wireFormat).length > 0) {
    if (!result.typespec) result.typespec = {};
    (result.typespec as Record<string, unknown>).wireFormat = wireFormat;
  }

  // TypeSpec sub-key for documentation
  const documentation: Record<string, unknown> = {};
  if (decorators.summary) documentation.summary = decorators.summary;
  if (decorators.deprecated) documentation.deprecated = decorators.deprecated;
  if (Object.keys(documentation).length > 0) {
    if (!result.typespec) result.typespec = {};
    (result.typespec as Record<string, unknown>).documentation = documentation;
  }

  // TypeSpec sub-key for visibility
  if (decorators.visibility && Array.isArray(decorators.visibility)) {
    if (!result.typespec) result.typespec = {};
    (result.typespec as Record<string, unknown>).visibility = {
      phases: decorators.visibility,
    };
  }

  // Array element type stored at top level of decorators (used by compiler)
  if (arrayElementType) {
    result.arrayElementType = arrayElementType;
  }

  return result;
}

/**
 * Extract classification from @tag("classification:...") value.
 */
function extractClassification(tag: string | undefined): string | null {
  if (!tag) return null;
  const match = tag.match(/^classification:(.+)$/);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Schema version management (stored in entity metadata JSONB)
// ---------------------------------------------------------------------------

export interface FieldTypeMapping {
  fieldName: string;
  sourceType: string;
  targetType: string;
}

export interface SchemaVersion {
  version: number;
  status: "draft" | "published" | "deployed";
  output: string;
  generatedAt: string;
  entityVersion: number;
  fieldTypeMappings?: FieldTypeMapping[];
  typeOverrideSnapshot?: FieldTargetTypeOverride[];
  overrideDriftSummary?: {
    activeCount: number;
    staleCount: number;
  };
  publishedAt?: string;
  deployedAt?: string;
}

export type SchemaVersionsMap = Record<string, SchemaVersion[]>;

async function getSchemaTargetFieldMappingsInternal(
  entityId: string,
  target: string,
  userId: string
) {
  const entity = await prisma.entity.findUnique({
    where: { id: entityId },
    select: { id: true, metadata: true },
  });
  if (!entity) {
    return { error: "Entity not found" as const };
  }

  const fieldRows = await prisma.field.findMany({
    where: { entityId },
    orderBy: { sortOrder: "asc" },
  });

  const userRole = await resolveUserRole(userId);
  const ctx = { userId, userRole, prisma };
  const policyOverrideResult = await getOverridesForEntity(entityId, ctx);
  const policyOverrides = policyOverrideResult.success
    ? policyOverrideResult.data
    : [];

  const parsedOverrides = parseSchemaTargetTypeOverrides(
    (entity.metadata as Record<string, unknown> | null)?.schemaTargetTypeOverrides
  );
  const fieldPolicies = toFieldOverridePolicies(parsedOverrides, target);
  const mappings = buildSchemaTargetFieldMappings(
    fieldRows.map((field) => ({
      id: field.id,
      name: field.name,
      type: field.type,
      precision: field.precision,
      scale: field.scale,
      nullable: field.nullable,
      isKey: field.isKey,
      fieldNumber: field.fieldNumber,
      description: field.description,
      classification: field.classification,
      aliases: field.aliases,
      decorators: field.decorators,
      sortOrder: field.sortOrder,
    })),
    target,
    [...policyOverrides, ...fieldPolicies],
    parsedOverrides,
    entityId
  );

  return {
    entity,
    fieldRows,
    parsedOverrides,
    mappings,
  };
}

/**
 * Get all schema versions per target from entity metadata.
 */
export async function getSchemaVersionsAction(entityId: string) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };

  try {
    const entity = await prisma.entity.findUnique({
      where: { id: entityId },
      select: { metadata: true },
    });
    if (!entity) return { error: "Entity not found" };

    const meta = (entity.metadata as Record<string, unknown>) ?? {};
    const schemaVersions = (meta.schemaVersions as SchemaVersionsMap) ?? {};
    return { success: true, schemaVersions };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Failed to get schema versions";
    return { error: message };
  }
}

export async function getSchemaTargetFieldMappingsAction(
  entityId: string,
  target: string
) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };

  const targetDefinition = getSchemaTargetDefinition(target);
  const targetCatalog = getTargetTypeCatalogEntry(target);
  if (!targetDefinition) {
    return { error: `Unknown schema target "${target}"` };
  }

  if (!targetDefinition.supportsFieldOverrides) {
    return {
      success: true,
      supported: false,
      reason:
        "This target is generated by the external TypeSpec CLI path and does not yet support per-field physical type overrides.",
      mappings: [],
      typeCatalog: targetCatalog ?? null,
    };
  }

  const result = await getSchemaTargetFieldMappingsInternal(
    entityId,
    target,
    session.user.id
  );
  if ("error" in result) {
    return { error: result.error };
  }

  return {
    success: true,
    supported: true,
    mappings: result.mappings,
    typeCatalog: targetCatalog ?? null,
  };
}

export async function saveSchemaFieldTypeOverrideAction(input: {
  entityId: string;
  target: string;
  fieldId: string;
  mappedType: string;
}) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };

  const targetDefinition = getSchemaTargetDefinition(input.target);
  if (!targetDefinition) {
    return { error: `Unknown schema target "${input.target}"` };
  }
  if (!targetDefinition.supportsFieldOverrides) {
    return {
      error:
        "This schema target does not currently support generated field-level type overrides.",
    };
  }

  const result = await getSchemaTargetFieldMappingsInternal(
    input.entityId,
    input.target,
    session.user.id
  );
  if ("error" in result) {
    return { error: result.error };
  }

  const field = result.fieldRows.find((row) => row.id === input.fieldId);
  if (!field) {
    return { error: "Field not found" };
  }

  const mapping = result.mappings.find((row) => row.fieldId === input.fieldId);
  if (!mapping) {
    return { error: "Target mapping row not found" };
  }

  const nextOverrides: SchemaTargetTypeOverrides =
    !input.mappedType || input.mappedType === mapping.defaultMappedType
      ? removeFieldTargetTypeOverride(
          result.parsedOverrides,
          input.target,
          input.fieldId
        )
      : upsertFieldTargetTypeOverride(result.parsedOverrides, {
          target: input.target,
          fieldId: input.fieldId,
          fieldName: field.name,
          sourceType: field.type,
          mappedType: input.mappedType,
          defaultMappedType: mapping.defaultMappedType,
          userId: session.user.id,
        });

  const existingMeta = (result.entity.metadata as Record<string, unknown>) ?? {};
  const updatedMeta = {
    ...existingMeta,
    schemaTargetTypeOverrides: nextOverrides,
  };

  await withAudit({
    action: "UPDATE",
    entityType: "Entity",
    entityId: input.entityId,
    userId: session.user.id,
    beforeState: { metadata: existingMeta } as unknown as object,
    fn: () =>
      prisma.entity.update({
        where: { id: input.entityId },
        data: { metadata: updatedMeta as unknown as Prisma.InputJsonValue },
      }),
  });

  const generation = await generateSchemaAction(input.entityId, input.target);
  if (generation.error) {
    return { error: generation.error };
  }

  revalidatePath("/schemas");
  return {
    success: true,
    schemaVersion: generation.schemaVersion,
  };
}

/**
 * Generate a schema for ONE target, store as draft version in entity metadata.
 */
export async function generateSchemaAction(entityId: string, target: string) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };

  try {
    const targetDefinition = getSchemaTargetDefinition(target);
    if (!targetDefinition) {
      return { error: `Unknown schema target "${target}"` };
    }

    let targetOutput: {
      output: string;
      validationStatus: string;
      warnings: unknown[];
      errors: unknown[];
    };

    if (targetDefinition.runtime === "native") {
      const { emitEntity } = await import("@/lib/emission/emission.service");
      const result = await emitEntity(entityId);
      const nativeTargetOutput = result.targets[target];
      if (!nativeTargetOutput) {
        return { error: `No output found for target "${target}"` };
      }
      targetOutput = nativeTargetOutput;
    } else {
      const { emitOfficialTypeSpecTargetForEntity } = await import(
        "@/lib/typespec-official/emitter.service"
      );
      const officialResult = await emitOfficialTypeSpecTargetForEntity(entityId, target);
      if (officialResult.validationStatus === "INVALID") {
        const firstError = officialResult.errors[0]?.message;
        return { error: firstError ?? `Failed to generate ${targetDefinition.displayName}` };
      }
      targetOutput = officialResult;
    }

    // Load entity to get current metadata, version, and fields for type mapping
    const entity = await prisma.entity.findUnique({
      where: { id: entityId },
      select: { metadata: true, version: true, fields: { select: { name: true, type: true }, orderBy: { sortOrder: "asc" } } },
    });
    if (!entity) return { error: "Entity not found" };

    // Build field type mappings from the default mapping engine
    let fieldTypeMappings: FieldTypeMapping[] = [];
    try {
      const { getDefaultMapping } = await import("@/lib/type-mapping/default-mappings");
      fieldTypeMappings = (entity.fields ?? []).map((f: { name: string; type: string }) => {
        const mapping = getDefaultMapping(f.type, target);
        return { fieldName: f.name, sourceType: f.type, targetType: mapping?.mappedType ?? f.type };
      });
    } catch {
      // Mapping engine unavailable — store empty mappings
    }

    const meta = (entity.metadata as Record<string, unknown>) ?? {};
    const schemaVersions = (meta.schemaVersions as SchemaVersionsMap) ?? {};
    const targetVersions = schemaVersions[target] ?? [];
    const parsedOverrides = parseSchemaTargetTypeOverrides(
      meta.schemaTargetTypeOverrides
    );

    let typeOverrideSnapshot: FieldTargetTypeOverride[] | undefined;
    let staleOverrideCount = 0;
    if (targetDefinition.supportsFieldOverrides) {
      const mappingContext = await getSchemaTargetFieldMappingsInternal(
        entityId,
        target,
        session.user.id
      );
      if (!("error" in mappingContext)) {
        typeOverrideSnapshot = Object.values(parsedOverrides[target] ?? {});
        staleOverrideCount = mappingContext.mappings.filter((row) => row.isStale).length;
      }
    }

    // If latest version is draft, update it in-place; otherwise create new version
    const latestVersion = targetVersions[0];
    const isLatestDraft = latestVersion?.status === "draft";

    const maxVersion = targetVersions.reduce(
      (max, v) => Math.max(max, v.version),
      0
    );

    const versionNumber = isLatestDraft ? latestVersion.version : maxVersion + 1;

    const newVersion: SchemaVersion = {
      version: versionNumber,
      status: "draft",
      output: targetOutput.output,
      generatedAt: new Date().toISOString(),
      entityVersion: entity.version,
      fieldTypeMappings,
      typeOverrideSnapshot,
      overrideDriftSummary: typeOverrideSnapshot
        ? {
            activeCount: typeOverrideSnapshot.length,
            staleCount: staleOverrideCount,
          }
        : undefined,
    };

    // If updating draft in-place, replace it; otherwise prepend new version
    const updatedVersions = isLatestDraft
      ? [newVersion, ...targetVersions.slice(1)]
      : [newVersion, ...targetVersions];
    const updatedMeta = {
      ...meta,
      schemaVersions: { ...schemaVersions, [target]: updatedVersions },
    };

    await withAudit({
      action: "UPDATE",
      entityType: "Entity",
      entityId,
      userId: session.user.id,
      beforeState: { metadata: meta } as unknown as object,
      fn: () =>
        prisma.entity.update({
          where: { id: entityId },
          data: { metadata: updatedMeta as unknown as Prisma.InputJsonValue },
        }),
    });

    revalidatePath("/schemas");
    return {
      success: true,
      schemaVersion: newVersion,
      validationStatus: targetOutput.validationStatus,
      warnings: targetOutput.warnings,
      errors: targetOutput.errors,
    };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Failed to generate schema";
    return { error: message };
  }
}

/**
 * Publish a schema version (draft -> published).
 */
export async function publishSchemaAction(
  entityId: string,
  target: string,
  version: number
) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };

  try {
    const entity = await prisma.entity.findUnique({
      where: { id: entityId },
      select: { metadata: true },
    });
    if (!entity) return { error: "Entity not found" };

    const meta = (entity.metadata as Record<string, unknown>) ?? {};
    const schemaVersions = (meta.schemaVersions as SchemaVersionsMap) ?? {};
    const targetVersions = schemaVersions[target];
    if (!targetVersions) return { error: `No versions found for target "${target}"` };

    const idx = targetVersions.findIndex((v) => v.version === version);
    if (idx === -1) return { error: `Version ${version} not found` };
    if (targetVersions[idx].status !== "draft") {
      return { error: `Version ${version} is not a draft (current: ${targetVersions[idx].status})` };
    }

    const updated = [...targetVersions];
    updated[idx] = {
      ...updated[idx],
      status: "published",
      publishedAt: new Date().toISOString(),
    };

    const updatedMeta = {
      ...meta,
      schemaVersions: { ...schemaVersions, [target]: updated },
    };

    await withAudit({
      action: "UPDATE",
      entityType: "Entity",
      entityId,
      userId: session.user.id,
      beforeState: { metadata: meta } as unknown as object,
      fn: () =>
        prisma.entity.update({
          where: { id: entityId },
          data: { metadata: updatedMeta as unknown as Prisma.InputJsonValue },
        }),
    });

    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Failed to publish schema";
    return { error: message };
  }
}

/**
 * Deploy a schema version (published -> deployed).
 */
export async function deploySchemaAction(
  entityId: string,
  target: string,
  version: number
) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };

  try {
    const entity = await prisma.entity.findUnique({
      where: { id: entityId },
      select: { metadata: true },
    });
    if (!entity) return { error: "Entity not found" };

    const meta = (entity.metadata as Record<string, unknown>) ?? {};
    const schemaVersions = (meta.schemaVersions as SchemaVersionsMap) ?? {};
    const targetVersions = schemaVersions[target];
    if (!targetVersions) return { error: `No versions found for target "${target}"` };

    const idx = targetVersions.findIndex((v) => v.version === version);
    if (idx === -1) return { error: `Version ${version} not found` };
    if (targetVersions[idx].status !== "published") {
      return { error: `Version ${version} is not published (current: ${targetVersions[idx].status})` };
    }

    const updated = [...targetVersions];
    updated[idx] = {
      ...updated[idx],
      status: "deployed",
      deployedAt: new Date().toISOString(),
    };

    const updatedMeta = {
      ...meta,
      schemaVersions: { ...schemaVersions, [target]: updated },
    };

    await withAudit({
      action: "UPDATE",
      entityType: "Entity",
      entityId,
      userId: session.user.id,
      beforeState: { metadata: meta } as unknown as object,
      fn: () =>
        prisma.entity.update({
          where: { id: entityId },
          data: { metadata: updatedMeta as unknown as Prisma.InputJsonValue },
        }),
    });

    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Failed to deploy schema";
    return { error: message };
  }
}

/**
 * Update entity metadata (generic helper for schema version updates).
 */
export async function updateEntityMetadataAction(
  entityId: string,
  metadata: Record<string, unknown>
) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };

  try {
    const entity = await prisma.entity.findUnique({
      where: { id: entityId },
      select: { metadata: true },
    });
    if (!entity) return { error: "Entity not found" };

    const existingMeta = (entity.metadata as Record<string, unknown>) ?? {};
    const updatedMeta = { ...existingMeta, ...metadata };

    await withAudit({
      action: "UPDATE",
      entityType: "Entity",
      entityId,
      userId: session.user.id,
      beforeState: { metadata: existingMeta } as unknown as object,
      fn: () =>
        prisma.entity.update({
          where: { id: entityId },
          data: { metadata: updatedMeta as unknown as Prisma.InputJsonValue },
        }),
    });

    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Failed to update metadata";
    return { error: message };
  }
}

export async function updateEntityDescriptionAction(
  entityId: string,
  description: string
) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };

  try {
    await prisma.entity.update({
      where: { id: entityId },
      data: { description },
    });

    revalidatePath("/schemas");
    return { success: true };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "Failed to update description";
    return { error: message };
  }
}
