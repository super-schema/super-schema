/**
 * Classification Taxonomy Service — custom classification level management.
 *
 * Manages system default and custom classification levels for
 * the data classification taxonomy. Persistence: Prisma `classificationLevel` table.
 * All functions return Result<T>.
 */

import { prisma } from "@/lib/db";
import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";
import {
  CreateClassificationInputSchema,
  UpdateClassificationInputSchema,
  type ClassificationLevel,
  type CreateClassificationInput,
  type UpdateClassificationInput,
} from "@/types/schemas/classification-taxonomy";

// ---------------------------------------------------------------------------
// Prisma row → app ClassificationLevel mapper
// ---------------------------------------------------------------------------

function toClassificationLevel(row: {
  id: string;
  name: string;
  displayColor: string;
  bgColor: string;
  textColor: string;
  description: string;
  sortOrder: number;
  isSystem: boolean;
  createdAt: Date;
  updatedAt: Date;
}): ClassificationLevel {
  return {
    id: row.id,
    name: row.name,
    displayColor: row.displayColor,
    bgColor: row.bgColor,
    textColor: row.textColor,
    description: row.description || null,
    sortOrder: row.sortOrder,
    isSystem: row.isSystem,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Test helpers (delegate to Prisma)
// ---------------------------------------------------------------------------

export async function _resetClassificationStore(): Promise<void> {
  await prisma.classificationLevel.deleteMany();
}

export async function _seedClassifications(levels: ClassificationLevel[]): Promise<void> {
  await prisma.classificationLevel.deleteMany();
  for (const level of levels) {
    await prisma.classificationLevel.create({
      data: {
        id: level.id,
        name: level.name,
        displayColor: level.displayColor,
        bgColor: level.bgColor,
        textColor: level.textColor,
        description: level.description ?? "",
        sortOrder: level.sortOrder,
        isSystem: level.isSystem,
      },
    });
  }
}

export async function _setFieldUsage(_classificationName: string, _count: number): Promise<void> {
  // Field usage is now queried live from the field table.
  // This is a no-op in production; tests mock prisma.field.count directly.
}

export async function _getClassificationStore(): Promise<ClassificationLevel[]> {
  const rows = await prisma.classificationLevel.findMany({
    orderBy: { sortOrder: "asc" },
  });
  return rows.map(toClassificationLevel);
}

// ---------------------------------------------------------------------------
// getClassificationLevels — all levels, sorted by sortOrder (all users)
// ---------------------------------------------------------------------------

export async function getClassificationLevels(
  _ctx: ServiceContext
): Promise<Result<ClassificationLevel[]>> {
  const rows = await prisma.classificationLevel.findMany({
    orderBy: { sortOrder: "asc" },
  });
  return ok(rows.map(toClassificationLevel));
}

// ---------------------------------------------------------------------------
// createClassification — Admin only
// ---------------------------------------------------------------------------

export async function createClassification(
  input: CreateClassificationInput,
  ctx: ServiceContext
): Promise<Result<ClassificationLevel>> {
  if (ctx.userRole !== "ADMIN") {
    return err({
      code: "FORBIDDEN",
      message: "Requires ADMIN role",
      suggestedFix: "Contact your administrator",
    });
  }

  const parsed = CreateClassificationInputSchema.safeParse(input);
  if (!parsed.success) {
    return err({
      code: "VALIDATION_ERROR",
      message: parsed.error.issues[0].message,
      suggestedFix: "Check the classification input fields.",
    });
  }


  // Enforce unique name (case-insensitive — names stored uppercase)
  const uppercaseName = parsed.data.name.toUpperCase();
  const duplicate = await prisma.classificationLevel.findFirst({
    where: { name: uppercaseName },
  });
  if (duplicate) {
    return err({
      code: "DUPLICATE",
      message: `Classification "${parsed.data.name}" already exists`,
      suggestedFix: "Choose a different classification name.",
    });
  }

  const row = await prisma.classificationLevel.create({
    data: {
      name: uppercaseName,
      displayColor: parsed.data.displayColor,
      bgColor: parsed.data.bgColor,
      textColor: parsed.data.textColor,
      description: parsed.data.description ?? "",
      sortOrder: parsed.data.sortOrder,
      isSystem: false,
    },
  });

  return ok(toClassificationLevel(row));
}

// ---------------------------------------------------------------------------
// updateClassification — Admin only
// ---------------------------------------------------------------------------

export async function updateClassification(
  input: UpdateClassificationInput,
  ctx: ServiceContext
): Promise<Result<ClassificationLevel>> {
  if (ctx.userRole !== "ADMIN") {
    return err({
      code: "FORBIDDEN",
      message: "Requires ADMIN role",
      suggestedFix: "Contact your administrator",
    });
  }

  const parsed = UpdateClassificationInputSchema.safeParse(input);
  if (!parsed.success) {
    return err({
      code: "VALIDATION_ERROR",
      message: parsed.error.issues[0].message,
      suggestedFix: "Check the classification input fields.",
    });
  }


  const existing = await prisma.classificationLevel.findUnique({
    where: { id: parsed.data.id },
  });
  if (!existing) {
    return err({
      code: "NOT_FOUND",
      message: `Classification with ID "${parsed.data.id}" not found`,
      suggestedFix: "Verify the classification ID.",
    });
  }

  const data: Record<string, unknown> = {};
  if (parsed.data.displayColor !== undefined) data.displayColor = parsed.data.displayColor;
  if (parsed.data.bgColor !== undefined) data.bgColor = parsed.data.bgColor;
  if (parsed.data.textColor !== undefined) data.textColor = parsed.data.textColor;
  if (parsed.data.description !== undefined) data.description = parsed.data.description ?? "";
  if (parsed.data.sortOrder !== undefined) data.sortOrder = parsed.data.sortOrder;

  const updated = await prisma.classificationLevel.update({
    where: { id: parsed.data.id },
    data,
  });

  return ok(toClassificationLevel(updated));
}

// ---------------------------------------------------------------------------
// deleteClassification — Admin only, blocked for system defaults & in-use
// ---------------------------------------------------------------------------

export async function deleteClassification(
  id: string,
  ctx: ServiceContext
): Promise<Result<void>> {
  if (ctx.userRole !== "ADMIN") {
    return err({
      code: "FORBIDDEN",
      message: "Requires ADMIN role",
      suggestedFix: "Contact your administrator",
    });
  }


  const level = await prisma.classificationLevel.findUnique({
    where: { id },
  });
  if (!level) {
    return err({
      code: "NOT_FOUND",
      message: `Classification with ID "${id}" not found`,
      suggestedFix: "Verify the classification ID.",
    });
  }

  // Block deletion of system defaults
  if (level.isSystem) {
    return err({
      code: "FORBIDDEN",
      message: "Cannot delete system default classification",
      suggestedFix: "System default classifications cannot be removed.",
    });
  }

  // Block deletion if in use — query field table
  const usageCount = await prisma.field.count({
    where: { classification: level.name },
  });
  if (usageCount > 0) {
    return err({
      code: "CONFLICT",
      message: `Cannot delete — ${usageCount} fields use this classification. Reassign them first.`,
      suggestedFix: "Remove this classification from all fields before deleting.",
    });
  }

  await prisma.classificationLevel.delete({ where: { id } });
  return ok(undefined);
}
