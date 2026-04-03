import { prisma } from "@/lib/db";
import { withAudit } from "@/lib/audit";
import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import type { Field } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import { DecoratorSchema } from "@/types/schemas/decorator.schema";
import {
  CreateFieldInputSchema,
  UpdateFieldInputSchema,
  type CreateFieldInput,
  type UpdateFieldInput,
} from "@/types/schemas/field.schema";
import type { Prisma } from "@/generated/prisma/client";

export async function createField(
  entityId: string,
  input: CreateFieldInput,
  ctx: ServiceContext
): Promise<Result<Field>> {
  const parsed = CreateFieldInputSchema.safeParse(input);
  if (!parsed.success) {
    return err({
      code: "VALIDATION_ERROR",
      message: parsed.error.issues[0].message,
      suggestedFix: "Check the field input and try again.",
    });
  }

  if (parsed.data.decorators) {
    const decResult = DecoratorSchema.safeParse(parsed.data.decorators);
    if (!decResult.success) {
      return err({
        code: "VALIDATION_ERROR",
        message: "Invalid decorator structure",
        details: { issues: decResult.error.issues },
        suggestedFix:
          "Ensure decorators match the schema: { structure?, semantics?, classification?, policy?, quality?, lineage?, operationalHints?, evolution? }",
      });
    }
  }

  // Verify entity exists
  const entity = await prisma.entity.findUnique({ where: { id: entityId } });
  if (!entity) {
    return err({
      code: "NOT_FOUND",
      message: `Entity with ID "${entityId}" not found`,
      suggestedFix: "Verify the entity ID and try again.",
    });
  }

  // Get max sortOrder
  const maxField = await prisma.field.findFirst({
    where: { entityId },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  const nextSortOrder = maxField ? maxField.sortOrder + 1 : 0;

  try {
    const field = await withAudit({
      action: "CREATE",
      entityType: "Field",
      entityId: "pending",
      userId: ctx.userId,
      fn: async () => {
        return prisma.field.create({
          data: {
            entityId,
            name: parsed.data.name,
            type: parsed.data.type,
            precision: parsed.data.precision,
            scale: parsed.data.scale,
            nullable: parsed.data.nullable,
            isKey: parsed.data.isKey,
            fieldNumber: parsed.data.fieldNumber,
            description: parsed.data.description,
            aliases: parsed.data.aliases,
            classification: parsed.data.classification,
            sortOrder: nextSortOrder,
            decorators:
              (parsed.data.decorators as unknown as Prisma.InputJsonValue) ??
              {},
          },
        });
      },
    });
    return ok(field);
  } catch (e: unknown) {
    if (
      e instanceof Error &&
      e.message.includes("Unique constraint failed")
    ) {
      return err({
        code: "DUPLICATE",
        message: `A field named "${parsed.data.name}" already exists in this entity`,
        suggestedFix:
          "A field with this name already exists in this entity. Choose a different name.",
      });
    }
    throw e;
  }
}

export async function updateField(
  id: string,
  input: UpdateFieldInput,
  ctx: ServiceContext
): Promise<Result<Field>> {
  const parsed = UpdateFieldInputSchema.safeParse(input);
  if (!parsed.success) {
    return err({
      code: "VALIDATION_ERROR",
      message: parsed.error.issues[0].message,
      suggestedFix: "Check the update input and try again.",
    });
  }

  if (parsed.data.decorators) {
    const decResult = DecoratorSchema.safeParse(parsed.data.decorators);
    if (!decResult.success) {
      return err({
        code: "VALIDATION_ERROR",
        message: "Invalid decorator structure",
        details: { issues: decResult.error.issues },
        suggestedFix:
          "Ensure decorators match the expected schema.",
      });
    }
  }

  const existing = await prisma.field.findUnique({ where: { id } });
  if (!existing) {
    return err({
      code: "NOT_FOUND",
      message: `Field with ID "${id}" not found`,
      suggestedFix: "Verify the field ID and try again.",
    });
  }

  const field = await withAudit({
    action: "UPDATE",
    entityType: "Field",
    entityId: id,
    userId: ctx.userId,
    beforeState: existing as unknown as object,
    fn: async () => {
      return prisma.field.update({
        where: { id },
        data: {
          ...parsed.data,
          decorators:
            parsed.data.decorators !== undefined
              ? (parsed.data.decorators as unknown as Prisma.InputJsonValue)
              : undefined,
        },
      });
    },
  });
  return ok(field);
}

export async function deleteField(
  id: string,
  ctx: ServiceContext
): Promise<Result<void>> {
  const existing = await prisma.field.findUnique({ where: { id } });
  if (!existing) {
    return err({
      code: "NOT_FOUND",
      message: `Field with ID "${id}" not found`,
      suggestedFix: "Verify the field ID and try again.",
    });
  }

  await withAudit({
    action: "DELETE",
    entityType: "Field",
    entityId: id,
    userId: ctx.userId,
    beforeState: existing as unknown as object,
    fn: async () => {
      await prisma.field.delete({ where: { id } });
      return null;
    },
  });

  return ok(undefined as unknown as void);
}

export async function reorderFields(
  entityId: string,
  fieldIds: string[],
  ctx: ServiceContext
): Promise<Result<void>> {
  // Validate all fieldIds belong to this entity
  const fields = await prisma.field.findMany({
    where: { entityId },
    select: { id: true, sortOrder: true },
  });

  const entityFieldIds = new Set(fields.map((f) => f.id));
  for (const fid of fieldIds) {
    if (!entityFieldIds.has(fid)) {
      return err({
        code: "VALIDATION_ERROR",
        message: `Field "${fid}" does not belong to entity "${entityId}"`,
        suggestedFix: "Ensure all field IDs belong to the specified entity.",
      });
    }
  }

  const beforeState = fields.map((f) => ({
    id: f.id,
    sortOrder: f.sortOrder,
  }));

  await withAudit({
    action: "REORDER",
    entityType: "Field",
    entityId,
    userId: ctx.userId,
    beforeState: beforeState as unknown as object,
    fn: async () => {
      await prisma.$transaction(
        fieldIds.map((fieldId, index) =>
          prisma.field.update({
            where: { id: fieldId },
            data: { sortOrder: index },
          })
        )
      );
      return null;
    },
  });

  return ok(undefined as unknown as void);
}
