import { prisma } from "@/lib/db";
import { AuditUserMissingError, withAudit } from "@/lib/audit";
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
import { canTransition } from "@/lib/entity-lifecycle";
import { entityUpdateTouchesDraft, withSourceStale } from "@/lib/entity-versioning/draft-state";
import { generateSlug, reservedEntitySlugMessage } from "@/lib/slug";
import { ensureDefaultProductId } from "@/lib/org-defaults";
import { createInScope, writeWithUniqueName, ServiceErrorRejection } from "@/services/scoped-create.service";
import { entityDeleteFailure, explainEntityDeleteFailure } from "@/services/events/entity-pin-usage";

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

  const entitySlug = generateSlug(parsed.data.name);
  const reservedMsg = reservedEntitySlugMessage(parsed.data.name);
  if (reservedMsg) {
    return err({
      code: "VALIDATION_ERROR",
      message: reservedMsg,
      suggestedFix: "Choose a different entity name.",
    });
  }

  try {
    const entity = await withAudit({
      action: "CREATE",
      entityType: "Entity",
      entityId: "pending",
      userId: ctx.userId,
      fn: async () => {
        const productId = await ensureDefaultProductId(parsed.data.domainId);
        const created = await createInScope(prisma, {
          kind: "entity",
          target: { level: "PRODUCT", productId },
          name: parsed.data.name,
          write: (tx, scope) =>
            tx.entity.create({
              data: {
                name: parsed.data.name,
                slug: entitySlug,
                ...scope,
                description: parsed.data.description,
                ownerId: ctx.userId,
                metadata:
                  (parsed.data.metadata as unknown as Prisma.InputJsonValue) ??
                  undefined,
              },
              include: { domain: true },
            }),
        });
        if (!created.success) throw new ServiceErrorRejection(created.error);
        return created.data;
      },
    });
    return ok(entity);
  } catch (e: unknown) {
    if (e instanceof ServiceErrorRejection) return err(e.serviceError);
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

  // Validate status transition if status is being changed
  if (parsed.data.status && parsed.data.status !== existing.status) {
    type EntityStatus = "DRAFT" | "ACTIVE" | "DEPRECATED" | "RETIRED";
    const transition = canTransition(
      existing.status as EntityStatus,
      parsed.data.status as EntityStatus
    );
    if (!transition.allowed) {
      return err({
        code: "INVALID_TRANSITION",
        message: transition.reason!,
        suggestedFix: transition.reason!,
      });
    }
  }

  // Check if renaming to a reserved slug
  if (parsed.data.name && parsed.data.name !== existing.name) {
    const reservedMsg = reservedEntitySlugMessage(parsed.data.name);
    if (reservedMsg) {
      return err({
        code: "VALIDATION_ERROR",
        message: reservedMsg,
        suggestedFix: "Choose a different entity name.",
      });
    }
  }

  // Block all edits (except status) on retired entities
  if (existing.status === "RETIRED" && !parsed.data.status) {
    return err({
      code: "ENTITY_READ_ONLY",
      message: "This entity is retired and cannot be edited",
      suggestedFix: "Retired entities are read-only. No changes are allowed.",
    });
  }

  try {
    const entity = await withAudit({
      action: "UPDATE",
      entityType: "Entity",
      entityId: id,
      userId: ctx.userId,
      beforeState: existing as unknown as object,
      fn: async () => {
        const touchesDraft = entityUpdateTouchesDraft(existing, parsed.data);
        // R42/R45: name, description and draft metadata are all rendered into the TypeSpec source, so a
        // draft edit marks the stored source stale. Callers also send a whole metadata copy (and the
        // schema strips unknown keys), so the server-owned marker is carried over from the stored
        // metadata or a replace would silently clear it.
        const storedMetadata =
          existing.metadata !== null && typeof existing.metadata === "object" && !Array.isArray(existing.metadata)
            ? (existing.metadata as Record<string, unknown>)
            : {};
        const nextMetadata =
          parsed.data.metadata !== undefined
            ? withSourceStale(existing.metadata, parsed.data.metadata, touchesDraft)
            : touchesDraft
              ? withSourceStale(existing.metadata, storedMetadata, true)
              : undefined;
        const update = {
          where: { id },
          data: {
            ...parsed.data,
            metadata: nextMetadata as unknown as Prisma.InputJsonValue | undefined,
            ...(touchesDraft && { hasUnpublishedChanges: true }),
          },
          include: { domain: true },
        } satisfies Prisma.EntityUpdateArgs;

        const newName = parsed.data.name;
        if (newName === undefined || newName === existing.name) return prisma.entity.update(update);

        // A real rename must stay line-unique: check and write under the tenant lock.
        const outcome = await writeWithUniqueName(prisma, {
          scope: existing,
          name: newName,
          exclude: { kind: "entity", id },
          write: (tx) => tx.entity.update(update),
        });
        if (!outcome.success) throw new ServiceErrorRejection(outcome.error);
        return outcome.data;
      },
    });
    return ok(entity);
  } catch (e: unknown) {
    if (e instanceof ServiceErrorRejection) return err(e.serviceError);
    throw e;
  }
}

/**
 * Deletes an entity, but only when nothing keeps it alive: no message / trait pin (NO ACTION FKs) and no published
 * version of another entity that references one of its versions (`schema_references`, no FK: spec §6.1 says a version
 * referenced by a published version cannot be deleted, and the check has to be ours). The guard runs before the delete
 * and again after a P2003, so a pin that lands in between is still reported by name. Never throws: a lock timeout /
 * deadlock is a retryable CONFLICT, any other database failure a DB_ERROR with the generic message.
 */
export async function deleteEntity(
  id: string,
  ctx: ServiceContext
): Promise<Result<void>> {
  let existing: Entity | null = null;
  try {
    existing = await prisma.entity.findUnique({ where: { id } });
    if (!existing) {
      return err({
        code: "NOT_FOUND",
        message: `Entity with ID "${id}" not found`,
        suggestedFix: "Verify the entity ID and try again.",
      });
    }

    const inUse = await explainEntityDeleteFailure(prisma, existing);
    if (inUse) return err(inUse);

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
  } catch (e: unknown) {
    if (e instanceof AuditUserMissingError) return err({ code: "UNAUTHORIZED", message: e.message });
    return err(await entityDeleteFailure(prisma, existing ?? { id }, e));
  }

  return ok(undefined as unknown as void);
}
