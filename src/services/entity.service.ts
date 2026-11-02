import { prisma } from "@/lib/db";
import { AuditUserMissingError, withAudit } from "@/lib/audit";
import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import type { Entity } from "@/generated/prisma/client";
import type { ServiceContext } from "@/types/service-context";
import {
  EntityMetadataSchema,
  PATCHABLE_ENTITY_METADATA_KEYS,
  type EntityMetadata,
  type EntityMetadataPatch,
} from "@/types/schemas/entity-metadata.schema";
import {
  CreateEntityInputSchema,
  UpdateEntityInputSchema,
  type CreateEntityInput,
  type UpdateEntityInput,
  type EntityFilters,
} from "@/types/schemas/entity.schema";
import type { Prisma } from "@/generated/prisma/client";
import { ctxCan, readableScopes } from "@/lib/access";
import { isPlainObject } from "@/lib/editable-fields";
import { omitSchemaVersions, redactEntityMetadata } from "@/lib/access/schema-version-redaction";
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
  // The URL name is the name's slug: a name with no letter or digit in any script has none, and the entity could not be opened.
  if (entitySlug === "") {
    return err({
      code: "VALIDATION_ERROR",
      message: "Entity name must contain at least one letter or digit",
      suggestedFix: "Use a name with letters or digits.",
    });
  }
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
  // A list never shows the stored generated schemas (they hold the files of whole closures, which the caller's roles may not all cover: KD-046).
  return ok(entities.map((entity) => ({ ...entity, metadata: omitSchemaVersions(entity.metadata) })));
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
  // The stored generated schemas in the metadata carry the files of every entity of the closure they were made from, a wider role's included: the
  // caller gets the copy their own roles cover (KD-046). The caller may read this entity (checked above), which is what the redaction needs of the root.
  const metadata = await redactEntityMetadata(prisma, entity.metadata, { root: { entityId: entity.id, place }, assignments: ctx.assignments });
  return ok({ ...entity, metadata });
}

/** `updateEntity`'s input: the update fields, and a metadata patch (EntityMetadataPatch) in which a patchable key sent as `null` is removed. */
export type UpdateEntityPatch = Omit<UpdateEntityInput, "metadata"> & { metadata?: EntityMetadataPatch };

/**
 * The keys a patch may set or remove (PATCHABLE_ENTITY_METADATA_KEYS). Any other key of a patch is ignored: the server records it or another writer
 * owns it (the import's importedFrom and sourceFormat, the relationships, the TypeSpec sync's extensions inside custom). An allowlist, so an own
 * `__proto__` key of a parsed patch is not one of them and never reaches `set`.
 */
const PATCHABLE_KEYS: ReadonlySet<string> = new Set(PATCHABLE_ENTITY_METADATA_KEYS);

/** A metadata patch split for the schema: the patchable keys it removes (sent as `null`) and the rest of them, which is what the schema reads. */
function splitMetadataPatch(patch: object): { removed: string[]; set: Record<string, unknown> } {
  const removed: string[] = [];
  const set: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    if (!PATCHABLE_KEYS.has(key)) continue;
    if (value !== null) set[key] = value;
    else removed.push(key);
  }
  return { removed, set };
}

/**
 * The stored metadata with a patch applied. A patchable key the patch sets replaces its stored value, a patchable key it removes is dropped, and
 * every other key keeps its stored value, the keys the schema does not declare included. A key whose value is `undefined` is one the patch does
 * not carry, so it keeps the stored value too.
 */
function mergeMetadataPatch(
  stored: Record<string, unknown>,
  patch: EntityMetadata | undefined,
  removed: readonly string[]
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...stored };
  for (const key of removed) delete merged[key];
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

export async function updateEntity(
  id: string,
  input: UpdateEntityPatch,
  ctx: ServiceContext
): Promise<Result<Entity>> {
  // The schema takes no null, so the removals (declared keys sent as `null`) come out of the metadata before it reads the input. Only a plain
  // object is split: anything else is left for the schema to refuse, as it always has.
  const split = input.metadata !== undefined && isPlainObject(input.metadata) ? splitMetadataPatch(input.metadata) : undefined;
  const parsed = UpdateEntityInputSchema.safeParse(split ? { ...input, metadata: split.set } : input);
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

  // A patch sets a key only when it carries a value for one: a patch of keys the server records (or of undefined values) writes no metadata.
  const patchSetsKey = parsed.data.metadata !== undefined && Object.values(parsed.data.metadata).some((value) => value !== undefined);

  try {
    const entity = await withAudit({
      action: "UPDATE",
      entityType: "Entity",
      entityId: id,
      userId: ctx.userId,
      beforeState: existing as unknown as object,
      fn: async () => {
        // The write runs under the row lock and merges the patch over the metadata AS IT STANDS under that lock, not the copy read above. A write
        // from another path that landed in between (a publish's schemaVersions, a generate, a sourceStale mark) is kept; the whole-column write
        // used to put back the older copy and revert it. The lock is the one publish and delete take (`FOR UPDATE` on the entity row).
        const write = async (tx: Prisma.TransactionClient) => {
          await tx.$queryRaw`SELECT "id" FROM "entities" WHERE "id" = ${id} FOR UPDATE`;
          const current = await tx.entity.findUnique({ where: { id } });
          if (!current) {
            throw new ServiceErrorRejection({
              code: "NOT_FOUND",
              message: `Entity with ID "${id}" not found`,
              suggestedFix: "Verify the entity ID and try again.",
            });
          }
          // The metadata is a PATCH merged over the stored object (see mergeMetadataPatch): a key the caller does not send keeps its stored value,
          // and the server-owned keys (schemaVersions, versionHistory, the extends link, sourceStale, ...) are never the caller's to write, so none
          // of them is lost to a write that carries only the change.
          const storedMetadata =
            current.metadata !== null && typeof current.metadata === "object" && !Array.isArray(current.metadata)
              ? (current.metadata as Record<string, unknown>)
              : {};
          const removed = split?.removed ?? [];
          const nextMetadata = mergeMetadataPatch(storedMetadata, parsed.data.metadata, removed);
          // R42/R45: name, description and draft metadata are all rendered into the TypeSpec source, so a draft edit marks the stored source
          // stale. The draft check reads the merged metadata: a key the patch leaves alone is no change.
          const touchesDraft = entityUpdateTouchesDraft(current, { ...parsed.data, metadata: nextMetadata });
          const metadataWritten = patchSetsKey || removed.length > 0 || touchesDraft;
          const update = {
            where: { id },
            data: {
              ...parsed.data,
              metadata: (metadataWritten
                ? withSourceStale(current.metadata, nextMetadata, touchesDraft)
                : undefined) as unknown as Prisma.InputJsonValue | undefined,
              ...(touchesDraft && { hasUnpublishedChanges: true }),
            },
            include: { domain: true },
          } satisfies Prisma.EntityUpdateArgs;
          return tx.entity.update(update);
        };

        const newName = parsed.data.name;
        if (newName === undefined || newName === existing.name) return prisma.$transaction(write);

        // A real rename must stay line-unique: check and write under the tenant lock (taken before the row lock).
        const outcome = await writeWithUniqueName(prisma, {
          scope: existing,
          name: newName,
          exclude: { kind: "entity", id },
          write,
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
