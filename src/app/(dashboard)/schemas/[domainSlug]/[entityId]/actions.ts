"use server";

import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { auth } from "@/lib/auth";
import { withAudit } from "@/lib/audit";
import { revalidatePath } from "next/cache";
import { TypeSpecDecoratorSchema } from "@/types/schemas/typespec-decorator.schema";
import { updateEntity } from "@/services/entity.service";
import type { UpdateEntityInput } from "@/types/schemas/entity.schema";
import type { Relationship } from "@/types/schemas/entity-metadata.schema";
import { getEffectiveRole } from "@/services/rbac.service";

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
            type,
            sortOrder: maxField ? maxField.sortOrder + 1 : 0,
            ...(opts?.description != null && { description: opts.description }),
            ...(opts?.classification !== undefined && { classification: opts.classification }),
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
          data: { metadata: updatedMeta as Prisma.InputJsonValue },
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
