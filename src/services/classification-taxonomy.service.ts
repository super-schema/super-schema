/**
 * Classification Taxonomy Service — custom classification level management.
 *
 * Manages system default and custom classification levels for
 * the data classification taxonomy. Uses in-memory store for MVP.
 * All functions return Result<T>.
 */

import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";
import {
  CreateClassificationInputSchema,
  UpdateClassificationInputSchema,
  SYSTEM_CLASSIFICATION_DEFAULTS,
  type ClassificationLevel,
  type CreateClassificationInput,
  type UpdateClassificationInput,
} from "@/types/schemas/classification-taxonomy";

// ---------------------------------------------------------------------------
// In-memory store (MVP)
// ---------------------------------------------------------------------------

let classificationStore: ClassificationLevel[] = [];
let fieldUsageMap: Map<string, number> = new Map();
let nextId = 1;

function ensureDefaults(): void {
  if (classificationStore.length > 0) return;
  for (const def of SYSTEM_CLASSIFICATION_DEFAULTS) {
    classificationStore.push({
      ...def,
      id: `cls-${nextId++}`,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
}

export function _resetClassificationStore(): void {
  classificationStore = [];
  fieldUsageMap = new Map();
  nextId = 1;
}

export function _seedClassifications(levels: ClassificationLevel[]): void {
  classificationStore = [...levels];
}

export function _setFieldUsage(classificationName: string, count: number): void {
  fieldUsageMap.set(classificationName, count);
}

export function _getClassificationStore(): ClassificationLevel[] {
  return classificationStore;
}

// ---------------------------------------------------------------------------
// getClassificationLevels — all levels, sorted by sortOrder (all users)
// ---------------------------------------------------------------------------

export async function getClassificationLevels(
  _ctx: ServiceContext
): Promise<Result<ClassificationLevel[]>> {
  ensureDefaults();
  const sorted = [...classificationStore].sort((a, b) => a.sortOrder - b.sortOrder);
  return ok(sorted);
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

  ensureDefaults();

  // Enforce unique name (case-insensitive — names stored uppercase)
  const duplicate = classificationStore.find(
    (c) => c.name.toUpperCase() === parsed.data.name.toUpperCase()
  );
  if (duplicate) {
    return err({
      code: "DUPLICATE",
      message: `Classification "${parsed.data.name}" already exists`,
      suggestedFix: "Choose a different classification name.",
    });
  }

  const level: ClassificationLevel = {
    id: `cls-${nextId++}`,
    name: parsed.data.name,
    displayColor: parsed.data.displayColor,
    bgColor: parsed.data.bgColor,
    textColor: parsed.data.textColor,
    description: parsed.data.description ?? null,
    sortOrder: parsed.data.sortOrder,
    isSystem: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  classificationStore.push(level);
  return ok(level);
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

  ensureDefaults();

  const index = classificationStore.findIndex((c) => c.id === parsed.data.id);
  if (index === -1) {
    return err({
      code: "NOT_FOUND",
      message: `Classification with ID "${parsed.data.id}" not found`,
      suggestedFix: "Verify the classification ID.",
    });
  }

  const existing = classificationStore[index];
  classificationStore[index] = {
    ...existing,
    displayColor: parsed.data.displayColor ?? existing.displayColor,
    bgColor: parsed.data.bgColor ?? existing.bgColor,
    textColor: parsed.data.textColor ?? existing.textColor,
    description: parsed.data.description !== undefined
      ? (parsed.data.description ?? null)
      : existing.description,
    sortOrder: parsed.data.sortOrder ?? existing.sortOrder,
    updatedAt: new Date(),
  };

  return ok(classificationStore[index]);
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

  ensureDefaults();

  const index = classificationStore.findIndex((c) => c.id === id);
  if (index === -1) {
    return err({
      code: "NOT_FOUND",
      message: `Classification with ID "${id}" not found`,
      suggestedFix: "Verify the classification ID.",
    });
  }

  const level = classificationStore[index];

  // Block deletion of system defaults
  if (level.isSystem) {
    return err({
      code: "FORBIDDEN",
      message: "Cannot delete system default classification",
      suggestedFix: "System default classifications cannot be removed.",
    });
  }

  // Block deletion if in use
  const usageCount = fieldUsageMap.get(level.name) ?? 0;
  if (usageCount > 0) {
    return err({
      code: "CONFLICT",
      message: `Cannot delete — ${usageCount} fields use this classification. Reassign them first.`,
      suggestedFix: "Remove this classification from all fields before deleting.",
    });
  }

  classificationStore.splice(index, 1);
  return ok(undefined);
}
