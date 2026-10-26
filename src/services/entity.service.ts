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
import { ctxCan, readableScopes } from "@/lib/access";
import { canTransition } from "@/lib/entity-lifecycle";
import { entityUpdateTouchesDraft, withSourceStale } from "@/lib/entity-versioning/draft-state";
import { generateSlug } from "@/lib/slug";
import { entityNameMessage } from "@/lib/entity-name";
import { ensureDefaultProductId } from "@/lib/org-defaults";
import { createInScope, writeWithUniqueName, ServiceErrorRejection } from "@/services/scoped-create.service";
import { deleteEntityGuarded, entityDeleteFailure } from "@/services/events/entity-pin-usage";
import { eventsInUseError, findEntityLatestVersionEventReferrers } from "@/services/events/event-guards";
import { guardRead } from "@/services/events/service-guards";

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
  const reservedMsg = entityNameMessage(parsed.data.name);
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

/**
 * The entities matching `filters`. With a tenant in the context (`ctx.tenantId`: the pages, the actions and every API route), only the entities of THAT
 * tenant that the caller's assignments let them read (`entity.read`): a tenant-wide role lists them all, a domain- or product-scoped role only the entities
 * under its domains and products, in the query. A context with NO tenant never means "every tenant": only a platform administrator reads across tenants
 * then, anyone else is refused (and nothing is read).
 */
export async function getEntities(
  filters: EntityFilters,
  ctx: ServiceContext
): Promise<Result<Entity[]>> {
  const where: Prisma.EntityWhereInput = {};

  if (ctx.tenantId !== undefined) {
    where.tenantId = ctx.tenantId;
    const scopes = readableScopes([...(ctx.assignments ?? [])], "entity.read", ctx.tenantId);
    if (!scopes.all) where.OR = [{ domainId: { in: scopes.domainIds } }, { productId: { in: scopes.productIds } }];
  } else if (!ctxCan(ctx, "platform.admin")) {
    return err({ code: "FORBIDDEN", message: "You do not have permission to do this" });
  }

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

/**
 * One entity with its fields. The caller must be able to READ it (`entity.read` over the entity's own tenant, domain and product): an entity of
 * another tenant than the one in view (`ctx.tenantId`, when the context carries one), one no role of the caller covers, and one that does not exist
 * all answer the very same NOT_FOUND, so an id says nothing about what exists. With no tenant in the context the caller's roles decide alone (a
 * platform administrator reads any entity, a role in a tenant that tenant's).
 */
export async function getEntityById(
  id: string,
  ctx: ServiceContext
): Promise<Result<Entity>> {
  const found = await prisma.entity.findUnique({
    where: { id },
    include: {
      domain: true,
      fields: { orderBy: { sortOrder: "asc" } },
      // Only to place the entity (a product-level row may carry no domain column): not part of the answer.
      product: { select: { domainId: true } },
    },
  });
  const place = found && {
    tenantId: found.tenantId,
    domainId: found.domainId ?? found.product?.domainId ?? null,
    productId: found.productId ?? null,
  };
  const readable = found !== null && place !== null && (ctx.tenantId === undefined || found.tenantId === ctx.tenantId) && ctxCan(ctx, "entity.read", place);
  if (!found || !readable) {
    return err({
      code: "NOT_FOUND",
      message: `Entity with ID "${id}" not found`,
      suggestedFix: "Verify the entity ID and try again.",
    });
  }
  const { product: _product, ...entity } = found;
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

  // Retiring freezes the entity: blocked while an event (draft or published version) is pinned to its LATEST version.
  // Older-version and unpinned pins do not block it (they protect the delete instead); a failing read is a DB_ERROR Result.
  if (parsed.data.status === "RETIRED" && existing.status !== "RETIRED") {
    const pinned = await guardRead(async () => ok(await findEntityLatestVersionEventReferrers(prisma, existing)));
    if (!pinned.success) return pinned;
    const blocked = eventsInUseError("Entity", existing.name, pinned.data, "retired");
    if (blocked) return err(blocked);
  }

  // Check if renaming to a reserved slug
  if (parsed.data.name && parsed.data.name !== existing.name) {
    const reservedMsg = entityNameMessage(parsed.data.name);
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
 * Deletes an entity, but only when nothing keeps it alive: no library-trait headers pin (NO ACTION FKs), no published
 * version of another entity that references one of its versions (`schema_references`, no FK: spec §6.1 says a version
 * referenced by a published version cannot be deleted, and the check has to be ours), and no event that names it (a draft
 * or published version, pinned or unpinned: event documents pin without foreign keys, so that guard is ours too and its
 * outcome is merged into the same IN_USE). Both guards and the delete run in ONE transaction under the entity row's lock
 * (`deleteEntityGuarded`), so an event publish cannot slip a published pin onto the entity between the guard and the delete;
 * the pin guard also runs again after a P2003, so a trait pin that lands meanwhile is still reported by name (an event pin
 * has no FK to raise a P2003: the lock is what orders it). Nothing is audited when the delete is blocked.
 * Never throws: a lock timeout / deadlock is a retryable CONFLICT, any other database failure a DB_ERROR with the generic message.
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
    const target = existing;

    await withAudit({
      action: "DELETE",
      entityType: "Entity",
      entityId: id,
      userId: ctx.userId,
      beforeState: existing as unknown as object,
      fn: async () => {
        // A blocked delete aborts here, so it is never audited (withAudit only logs after fn resolves).
        const blocked = await deleteEntityGuarded(prisma, target);
        if (blocked) throw new ServiceErrorRejection(blocked);
        return null;
      },
    });
  } catch (e: unknown) {
    if (e instanceof ServiceErrorRejection) return err(e.serviceError);
    if (e instanceof AuditUserMissingError) return err({ code: "UNAUTHORIZED", message: e.message });
    return err(await entityDeleteFailure(prisma, existing ?? { id }, e));
  }

  return ok(undefined as unknown as void);
}
