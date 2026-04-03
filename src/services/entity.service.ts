import { prisma } from "@/lib/db";
import { withAudit } from "@/lib/audit";
import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import type { Entity } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import { EntityMetadataSchema } from "@/types/schemas/entity-metadata.schema";
import {
  CreateEntityInputSchema,
  UpdateEntityInputSchema,
  type CreateEntityInput,
  type UpdateEntityInput,
  type EntityFilters,
} from "@/types/schemas/entity.schema";
import type { Prisma } from "@/generated/prisma/client";

export async function createEntity(
  input: CreateEntityInput,
  ctx: ServiceContext
): Promise<Result<Entity>> {
  const parsed = CreateEntityInputSchema.safeParse(input);
  if (!parsed.success) {
    return err({
      code: "VALIDATION_ERROR",
      message: parsed.error.issues[0].message,
      suggestedFix: "Check the entity input fields and try again.",
    });
  }

  if (parsed.data.metadata) {
    const metaResult = EntityMetadataSchema.safeParse(parsed.data.metadata);
    if (!metaResult.success) {
      return err({
        code: "VALIDATION_ERROR",
        message: "Invalid metadata structure",
        details: { issues: metaResult.error.issues },
        suggestedFix:
          "Ensure metadata matches the expected schema: { tags?, relationships?, deprecation?, custom? }",
      });
    }
  }

  try {
    const entity = await withAudit({
      action: "CREATE",
      entityType: "Entity",
      entityId: "pending",
      userId: ctx.userId,
      fn: async () => {
        return prisma.entity.create({
          data: {
            name: parsed.data.name,
            domainId: parsed.data.domainId,
            description: parsed.data.description,
            ownerId: ctx.userId,
            metadata:
              (parsed.data.metadata as unknown as Prisma.InputJsonValue) ??
              undefined,
          },
          include: { domain: true },
        });
      },
    });
    return ok(entity);
  } catch (e: unknown) {
    if (
      e instanceof Error &&
      e.message.includes("Unique constraint failed")
    ) {
      return err({
        code: "DUPLICATE",
        message: `An entity named "${parsed.data.name}" already exists in this domain`,
        suggestedFix:
          "An entity with this name already exists in this domain. Choose a different name.",
      });
    }
    throw e;
  }
}

export async function getEntities(
  filters: EntityFilters,
  _ctx: ServiceContext
): Promise<Result<Entity[]>> {
  const where: Prisma.EntityWhereInput = {};

  if (filters.domainId) {
    where.domainId = filters.domainId;
  }
  if (filters.status) {
    where.status = filters.status;
  }
  if (filters.search) {
    where.name = { contains: filters.search, mode: "insensitive" };
  }

  const entities = await prisma.entity.findMany({
    where,
    include: {
      domain: true,
      _count: { select: { fields: true } },
    },
    orderBy: { updatedAt: "desc" },
  });
  return ok(entities);
}

export async function getEntityById(
  id: string,
  _ctx: ServiceContext
): Promise<Result<Entity>> {
  const entity = await prisma.entity.findUnique({
    where: { id },
    include: {
      domain: true,
      fields: { orderBy: { sortOrder: "asc" } },
    },
  });
  if (!entity) {
    return err({
      code: "NOT_FOUND",
      message: `Entity with ID "${id}" not found`,
      suggestedFix: "Verify the entity ID and try again.",
    });
  }
  return ok(entity);
}

export async function updateEntity(
  id: string,
  input: UpdateEntityInput,
  ctx: ServiceContext
): Promise<Result<Entity>> {
  const parsed = UpdateEntityInputSchema.safeParse(input);
  if (!parsed.success) {
    return err({
      code: "VALIDATION_ERROR",
      message: parsed.error.issues[0].message,
      suggestedFix: "Check the update input fields and try again.",
    });
  }

  if (parsed.data.metadata) {
    const metaResult = EntityMetadataSchema.safeParse(parsed.data.metadata);
    if (!metaResult.success) {
      return err({
        code: "VALIDATION_ERROR",
        message: "Invalid metadata structure",
        details: { issues: metaResult.error.issues },
        suggestedFix:
          "Ensure metadata matches the expected schema: { tags?, relationships?, deprecation?, custom? }",
      });
    }
  }

  const existing = await prisma.entity.findUnique({ where: { id } });
  if (!existing) {
    return err({
      code: "NOT_FOUND",
      message: `Entity with ID "${id}" not found`,
      suggestedFix: "Verify the entity ID and try again.",
    });
  }

  const entity = await withAudit({
    action: "UPDATE",
    entityType: "Entity",
    entityId: id,
    userId: ctx.userId,
    beforeState: existing as unknown as object,
    fn: async () => {
      return prisma.entity.update({
        where: { id },
        data: {
          ...parsed.data,
          metadata:
            parsed.data.metadata !== undefined
              ? (parsed.data.metadata as unknown as Prisma.InputJsonValue)
              : undefined,
        },
        include: { domain: true },
      });
    },
  });
  return ok(entity);
}

export async function deleteEntity(
  id: string,
  ctx: ServiceContext
): Promise<Result<void>> {
  const existing = await prisma.entity.findUnique({ where: { id } });
  if (!existing) {
    return err({
      code: "NOT_FOUND",
      message: `Entity with ID "${id}" not found`,
      suggestedFix: "Verify the entity ID and try again.",
    });
  }

  await withAudit({
    action: "DELETE",
    entityType: "Entity",
    entityId: id,
    userId: ctx.userId,
    beforeState: existing as unknown as object,
    fn: async () => {
      await prisma.entity.delete({ where: { id } });
      return null;
    },
  });

  return ok(undefined as unknown as void);
}
