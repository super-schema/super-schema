import { decoratorsAfterFieldEdit } from "@/lib/field-dangling";
import { prisma } from "@/lib/db";
import { withAudit } from "@/lib/audit";
import { generateSlug } from "@/lib/slug";
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
import { MARK_DRAFT_CHANGED_SQL } from "@/lib/entity-versioning/draft-state";
import { reservedFieldNameMessage } from "@/lib/reserved-field-names";

/**
 * A field name the AsyncAPI parser cannot read (`PARSER_UNSAFE_KEYS`) is refused: the field would make every event that pins its entity
 * unpublishable. The message already says what to do ("Choose another field name."), so there is no separate `suggestedFix` that a client
 * joining the two would repeat.
 */
function reservedNameError(name: string) {
  const message = reservedFieldNameMessage(name);
  return message === null ? null : err({ code: "VALIDATION_ERROR", message });
}

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
  const reserved = reservedNameError(parsed.data.name);
  if (reserved) return reserved;

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
        // The field write and the draft + stale-source mark are ONE atomic batch: a failure between them can never
        // leave a created field with `hasUnpublishedChanges` still false (publish would answer NO_CHANGES).
        const [created] = await prisma.$transaction([
          prisma.field.create({
            data: {
              entityId,
              name: parsed.data.name,
              slug: generateSlug(parsed.data.name),
              type: parsed.data.type,
              precision: parsed.data.precision,
              scale: parsed.data.scale,
              nullable: parsed.data.nullable,
              isKey: parsed.data.isKey,
              fieldNumber: parsed.data.fieldNumber,
              description: parsed.data.description,
              aliases: parsed.data.aliases,
              classification: parsed.data.classification ?? "SENSITIVE",
              sortOrder: nextSortOrder,
              decorators:
                (parsed.data.decorators as unknown as Prisma.InputJsonValue) ??
                {},
            },
          }),
          prisma.$executeRawUnsafe(MARK_DRAFT_CHANGED_SQL, entityId),
        ]);
        return created;
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

  // Only a RENAME is refused: a field that already has such a name (created before the rule) stays editable.
  if (parsed.data.name !== undefined && parsed.data.name !== existing.name) {
    const reserved = reservedNameError(parsed.data.name);
    if (reserved) return reserved;
  }

  const field = await withAudit({
    action: "UPDATE",
    entityType: "Field",
    entityId: id,
    userId: ctx.userId,
    beforeState: existing as unknown as object,
    fn: async () => {
      const updateData: Record<string, unknown> = {
          ...parsed.data,
          // An edit that resolves an unresolved external reference clears its marker (see field-dangling.ts).
          decorators: (() => {
            const next = decoratorsAfterFieldEdit(existing, {
              type: typeof parsed.data.type === "string" ? parsed.data.type : undefined,
              decorators: parsed.data.decorators as Record<string, unknown> | undefined,
            });
            return next !== undefined ? (next as unknown as Prisma.InputJsonValue) : undefined;
          })(),
        };
      // Regenerate slug when name changes
      if (parsed.data.name && parsed.data.name !== existing.name) {
        updateData.slug = generateSlug(parsed.data.name);
      }
      // The field write and the draft + stale-source mark are ONE atomic batch (see createField).
      const [updated] = await prisma.$transaction([
        prisma.field.update({
          where: { id },
          data: updateData,
        }),
        prisma.$executeRawUnsafe(MARK_DRAFT_CHANGED_SQL, existing.entityId),
      ]);
      return updated;
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
      // Delete + draft / stale-source mark in ONE atomic batch (see createField).
      await prisma.$transaction([
        prisma.field.delete({ where: { id } }),
        prisma.$executeRawUnsafe(MARK_DRAFT_CHANGED_SQL, existing.entityId),
      ]);
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

  if (fieldIds.length !== fields.length) {
    return err({
      code: "VALIDATION_ERROR",
      message: `Expected ${fields.length} field IDs but received ${fieldIds.length}. All fields must be included in the reorder request.`,
      suggestedFix: "Include every field ID for this entity in the reorder array.",
    });
  }

  // A repeated id keeps the count and the membership checks true while another field gets no position.
  if (new Set(fieldIds).size !== fieldIds.length) {
    return err({
      code: "VALIDATION_ERROR",
      message: "The reorder request names a field more than once",
      suggestedFix: "Include every field ID for this entity exactly once in the reorder array.",
    });
  }

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

  // The row is about the entity (its id is the entity's, not a field's), so its tenant is the entity's: a field lookup cannot find it.
  const owner = await prisma.entity.findUnique({ where: { id: entityId }, select: { tenantId: true } });

  await withAudit({
    action: "REORDER",
    entityType: "Field",
    entityId,
    userId: ctx.userId,
    tenantId: owner?.tenantId ?? null,
    beforeState: beforeState as unknown as object,
    fn: async () => {
      // All sortOrder writes + the draft / stale-source mark in ONE atomic batch (see createField).
      await prisma.$transaction([
        ...fieldIds.map((fieldId, index) =>
          prisma.field.update({
            where: { id: fieldId },
            data: { sortOrder: index },
          })
        ),
        prisma.$executeRawUnsafe(MARK_DRAFT_CHANGED_SQL, entityId),
      ]);
      return null;
    },
  });

  return ok(undefined as unknown as void);
}
