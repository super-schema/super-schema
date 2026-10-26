import { ctxCan, type ResourceRef } from "@/lib/access";
import { prisma } from "@/lib/db";
import { withAudit } from "@/lib/audit";
import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";
import type { Annotation, CreateAnnotationInput } from "@/types/schemas/compliance";

// ============================================================
// @-mention parsing
// ============================================================

/**
 * Extract user IDs from @-mention syntax in content.
 * Supports @[userId] format.
 */
export function extractMentionedUserIds(content: string): string[] {
  const regex = /@\[([^\]]+)\]/g;
  const ids: string[] = [];
  let match;
  while ((match = regex.exec(content)) !== null) {
    ids.push(match[1]);
  }
  return [...new Set(ids)];
}

/** Where the entity (or the field's entity) an annotation is on lives, or null when it names none or the row is gone. */
async function annotatedPlace(afterState: unknown): Promise<ResourceRef | null> {
  const { entityId, fieldId } = (afterState ?? {}) as { entityId?: unknown; fieldId?: unknown };
  const owner = { tenantId: true, domainId: true, productId: true, product: { select: { domainId: true } } } as const;
  const row =
    typeof entityId === "string" && entityId !== ""
      ? await prisma.entity.findUnique({ where: { id: entityId }, select: owner })
      : typeof fieldId === "string" && fieldId !== ""
        ? (await prisma.field.findUnique({ where: { id: fieldId }, select: { entity: { select: owner } } }))?.entity
        : null;
  return row ? { tenantId: row.tenantId, domainId: row.domainId ?? row.product?.domainId ?? null, productId: row.productId ?? null } : null;
}

// ============================================================
// createAnnotation
// ============================================================

export async function createAnnotation(
  input: CreateAnnotationInput,
  ctx: ServiceContext
): Promise<Result<Annotation>> {
  if (!input.content || input.content.trim().length === 0) {
    return err({
      code: "VALIDATION_ERROR",
      message: "Annotation content is required",
    });
  }

  if (!input.entityId && !input.fieldId) {
    return err({
      code: "VALIDATION_ERROR",
      message: "Either entityId or fieldId must be provided",
    });
  }

  // Extract tagged user IDs from content
  const mentionedIds = extractMentionedUserIds(input.content);
  const allTaggedIds = [
    ...new Set([...mentionedIds, ...(input.taggedUserIds || [])]),
  ];

  try {
    const annotation = await withAudit({
      action: "annotation.create",
      entityType: "Annotation",
      entityId: input.entityId || input.fieldId || "unknown",
      userId: ctx.userId,
      fn: async () => {
        return prisma.auditLog.create({
          data: {
            action: "annotation.create",
            entityType: "Annotation",
            entityId: input.entityId || input.fieldId || "unknown",
            userId: ctx.userId,
            afterState: {
              entityId: input.entityId || null,
              fieldId: input.fieldId || null,
              content: input.content,
              taggedUserIds: allTaggedIds,
              resolved: false,
            },
          },
        });
      },
    });

    // Since we don't have an annotations table (skipping migrations),
    // we store annotations in entity/field metadata JSONB or audit log.
    // Return the annotation-like result from the audit entry.
    const result: Annotation = {
      id: annotation.id,
      entityId: input.entityId || null,
      fieldId: input.fieldId || null,
      authorId: ctx.userId,
      authorName: null,
      authorAvatar: null,
      content: input.content,
      taggedUserIds: allTaggedIds,
      resolved: false,
      createdAt: annotation.timestamp,
      updatedAt: annotation.timestamp,
    };

    return ok(result);
  } catch (e: unknown) {
    return err({
      code: "INTERNAL_ERROR",
      message:
        e instanceof Error ? e.message : "Failed to create annotation",
    });
  }
}

// ============================================================
// getAnnotations
// ============================================================

export async function getAnnotations(
  entityId?: string,
  fieldId?: string,
  ctx?: ServiceContext
): Promise<Result<Annotation[]>> {
  if (!ctx) {
    return err({ code: "UNAUTHORIZED", message: "Context required" });
  }

  try {
    // Query audit_log for annotation entries
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = {
      action: "annotation.create",
    };

    if (entityId) {
      where.entityId = entityId;
    }
    if (fieldId) {
      where.entityId = fieldId;
    }

    const entries = await prisma.auditLog.findMany({
      where,
      include: {
        user: { select: { id: true, name: true, image: true } },
      },
      orderBy: { timestamp: "desc" },
    });

    const annotations: Annotation[] = entries.map((entry) => {
      const afterState = (entry.afterState || {}) as Record<string, unknown>;
      return {
        id: entry.id,
        entityId: (afterState.entityId as string) || null,
        fieldId: (afterState.fieldId as string) || null,
        authorId: entry.userId,
        authorName: entry.user?.name || null,
        authorAvatar: entry.user?.image || null,
        content: (afterState.content as string) || "",
        taggedUserIds: (afterState.taggedUserIds as string[]) || [],
        resolved: (afterState.resolved as boolean) || false,
        createdAt: entry.timestamp,
        updatedAt: entry.timestamp,
      };
    });

    return ok(annotations);
  } catch (e: unknown) {
    return err({
      code: "INTERNAL_ERROR",
      message:
        e instanceof Error ? e.message : "Failed to get annotations",
    });
  }
}

// ============================================================
// resolveAnnotation
// ============================================================

export async function resolveAnnotation(
  annotationId: string,
  ctx: ServiceContext
): Promise<Result<Annotation>> {
  try {
    // Find the original annotation entry
    const original = await prisma.auditLog.findUnique({
      where: { id: annotationId },
      include: {
        user: { select: { id: true, name: true, image: true } },
      },
    });

    if (!original) {
      return err({
        code: "NOT_FOUND",
        message: `Annotation "${annotationId}" not found`,
      });
    }

    // Access: the author resolves their own; anybody else needs `annotation.moderate` over the entity (or the field's entity) the annotation is on.
    if (original.userId !== ctx.userId) {
      const place = await annotatedPlace(original.afterState);
      if (!place || !ctxCan(ctx, "annotation.moderate", place)) {
        return err({
          code: "FORBIDDEN",
          message: "Only the author or an Admin can resolve annotations",
        });
      }
    }

    const afterState = (original.afterState || {}) as Record<string, unknown>;

    // Create a resolve audit entry
    await withAudit({
      action: "annotation.resolve",
      entityType: "Annotation",
      entityId: annotationId,
      userId: ctx.userId,
      beforeState: { resolved: false },
      fn: async () => {
        return { resolved: true };
      },
    });

    const result: Annotation = {
      id: annotationId,
      entityId: (afterState.entityId as string) || null,
      fieldId: (afterState.fieldId as string) || null,
      authorId: original.userId,
      authorName: original.user?.name || null,
      authorAvatar: original.user?.image || null,
      content: (afterState.content as string) || "",
      taggedUserIds: (afterState.taggedUserIds as string[]) || [],
      resolved: true,
      createdAt: original.timestamp,
      updatedAt: new Date(),
    };

    return ok(result);
  } catch (e: unknown) {
    return err({
      code: "INTERNAL_ERROR",
      message:
        e instanceof Error ? e.message : "Failed to resolve annotation",
    });
  }
}

// ============================================================
// getAnnotationCounts
// ============================================================

export async function getAnnotationCounts(
  entityId: string,
  ctx: ServiceContext
): Promise<Result<Record<string, number>>> {
  try {
    const entries = await prisma.auditLog.findMany({
      where: {
        action: "annotation.create",
      },
      select: { afterState: true },
    });

    const counts: Record<string, number> = {};
    for (const entry of entries) {
      const afterState = (entry.afterState || {}) as Record<string, unknown>;
      if (afterState.entityId === entityId || afterState.fieldId) {
        const fid = afterState.fieldId as string;
        if (fid) {
          counts[fid] = (counts[fid] || 0) + 1;
        }
      }
    }

    return ok(counts);
  } catch (e: unknown) {
    return err({
      code: "INTERNAL_ERROR",
      message: e instanceof Error ? e.message : "Failed to get annotation counts",
    });
  }
}

// ============================================================
// searchUsers (for @-mention)
// ============================================================

export async function searchUsers(
  query: string,
  _ctx: ServiceContext
): Promise<Result<{ id: string; name: string | null; email: string; image: string | null }[]>> {
  try {
    const users = await prisma.user.findMany({
      where: {
        OR: [
          { name: { contains: query, mode: "insensitive" } },
          { email: { contains: query, mode: "insensitive" } },
        ],
      },
      select: { id: true, name: true, email: true, image: true },
      take: 10,
    });
    return ok(users);
  } catch (e: unknown) {
    return err({
      code: "INTERNAL_ERROR",
      message: e instanceof Error ? e.message : "Failed to search users",
    });
  }
}
