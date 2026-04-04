"use server";

import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { auth } from "@/lib/auth";
import { withAudit } from "@/lib/audit";
import { revalidatePath } from "next/cache";
import { TypeSpecDecoratorSchema } from "@/types/schemas/typespec-decorator.schema";
import { updateEntity } from "@/services/entity.service";
import type { Relationship } from "@/types/schemas/entity-metadata.schema";

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

  // Validate field number uniqueness
  if (opts?.fieldNumber != null) {
    const conflict = await prisma.field.findFirst({
      where: { entityId, fieldNumber: opts.fieldNumber },
      select: { name: true },
    });
    if (conflict) {
      return { error: `Field number ${opts.fieldNumber} is already assigned to field '${conflict.name}'` };
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
            ...(opts?.fieldNumber !== undefined && { fieldNumber: opts.fieldNumber }),
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
    throw e;
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

  const result = await updateEntity(entityId, input as { status?: string; metadata?: Record<string, unknown> }, {
    userId: session.user.id,
    userRole: "AUTHOR",
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

  await prisma.entity.update({
    where: { id: entityId },
    data: { metadata: updatedMeta as Prisma.InputJsonValue },
  });

  revalidatePath("/schemas");
  return { success: true };
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

  const ctx = {
    userId: session.user.id,
    userRole: "STEWARD" as string, // MVP: default role
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

  const result = await acknowledgeLossyMapping(input, {
    userId: session.user.id,
    userRole: "AUTHOR",
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
    const result = await createSnapshot(entityId, {
      userId: session.user.id,
      userRole: "AUTHOR",
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
    const result = await getVersionHistory(entityId, {
      userId: session.user.id,
      userRole: "AUTHOR",
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
    const result = await compareVersionsStructured(entityId, v1, v2, {
      userId: session.user.id,
      userRole: "AUTHOR",
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

    const result = await getChangeHistory(
      entityId,
      {
        userId: session.user.id,
        userRole: "AUTHOR",
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

export async function deleteFieldAction(fieldId: string) {
  const session = await auth();
  if (!session?.user?.id) return { error: "Not authenticated" };

  const existing = await prisma.field.findUnique({ where: { id: fieldId } });
  if (!existing) return { error: "Field not found" };

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
}
