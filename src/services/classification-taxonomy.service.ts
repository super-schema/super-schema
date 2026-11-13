/**
 * Classification Taxonomy Service — custom classification level management.
 *
 * Manages system default and custom classification levels for
 * the data classification taxonomy. Persistence: Prisma `classificationLevel` table.
 * All functions return Result<T>.
 */

import { ctxCan } from "@/lib/access";
import { prisma } from "@/lib/db";
import { rederiveForLevel } from "@/services/metadata-rederive.service";
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

/** Bounds of the class-change transaction (level update + re-derivation of every field on the level, across tenants). */
export const CLASS_CHANGE_TX_OPTIONS = { timeout: 120_000, maxWait: 10_000 } as const;

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
  classNumber: number;
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
    classNumber: row.classNumber,
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
        classNumber: level.classNumber,
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
  if (!ctxCan(ctx, "classification.manage")) {
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
      classNumber: parsed.data.classNumber,
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
  if (!ctxCan(ctx, "classification.manage")) {
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

  if (
    existing.isSystem &&
    parsed.data.classNumber !== undefined &&
    parsed.data.classNumber !== existing.classNumber
  ) {
    return err({
      code: "SYSTEM_CLASS_FIXED",
      message: `The class of system level "${existing.name}" is fixed`,
      suggestedFix: "Only custom classification levels can change class.",
    });
  }

  const data: Record<string, unknown> = {};
  if (parsed.data.displayColor !== undefined) data.displayColor = parsed.data.displayColor;
  if (parsed.data.bgColor !== undefined) data.bgColor = parsed.data.bgColor;
  if (parsed.data.textColor !== undefined) data.textColor = parsed.data.textColor;
  if (parsed.data.description !== undefined) data.description = parsed.data.description ?? "";
  if (parsed.data.sortOrder !== undefined) data.sortOrder = parsed.data.sortOrder;
  if (parsed.data.classNumber !== undefined) data.classNumber = parsed.data.classNumber;

  const previousClassNumber = existing.classNumber;
  const classMoves = !existing.isSystem && data.classNumber !== undefined && data.classNumber !== previousClassNumber;
  if (!classMoves) {
    const updated = await prisma.classificationLevel.update({ where: { id: parsed.data.id }, data });
    return ok(toClassificationLevel(updated));
  }

  // A custom level's class moved: the derived attribute values of every field classified with it follow, in the SAME transaction (C4). A
  // failed re-derivation rolls the class change back, so saving the level again repairs it (the class still differs then). A level spans
  // every tenant, so the transaction is bounded explicitly (Prisma's default 5 s would abort a large one) and the re-derivation walks the
  // fields in locked, id-ordered chunks rather than one list of every field (N1).
  try {
    const updated = await prisma.$transaction(
      async (tx) => {
        const row = await tx.classificationLevel.update({ where: { id: parsed.data.id }, data });
        await rederiveForLevel(existing.name, tx);
        return row;
      },
      CLASS_CHANGE_TX_OPTIONS,
    );
    return ok(toClassificationLevel(updated));
  } catch (e: unknown) {
    console.error(`[updateClassification] re-deriving the fields of level "${existing.name}" failed`, e);
    return err({
      code: "REDERIVE_FAILED",
      message: `The class of "${existing.name}" was not changed: the attribute values derived from it could not be updated`,
      suggestedFix: "Try again. Nothing was saved.",
    });
  }
}

// ---------------------------------------------------------------------------
// deleteClassification — Admin only, blocked for system defaults & in-use
// ---------------------------------------------------------------------------

export async function deleteClassification(
  id: string,
  ctx: ServiceContext
): Promise<Result<void>> {
  if (!ctxCan(ctx, "classification.manage")) {
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
