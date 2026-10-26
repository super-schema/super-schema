/**
 * Type mapping service — orchestrates mapping resolution with access control,
 * audit trail, and override management.
 *
 * Who may do what, decided HERE with the policy over the caller's assignments (`ctx.assignments`), never from a role name:
 * - a PER-ENTITY override (create, acknowledge a lossy mapping, delete) is `typemapping.entity` over THE ENTITY it is for (an author or above where
 *   the entity lives; an entity the caller cannot see reads as missing);
 * - a GLOBAL override (no entity) is `typemapping.global`: the override table has no tenant column, so it changes the mapping of every tenant and is a
 *   platform administrator's act.
 *
 * Overrides and acknowledgments are persisted via Prisma.
 * Default mappings come from static TypeScript config.
 */

import { ctxCan, effectiveRole, readableScopes, type ResourceRef } from "@/lib/access";
import { prisma } from "@/lib/db";
import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import type { ServiceContext } from "@/types/service-context";
import type {
  ScopedMappingPolicy,
  CreateOverrideInput,
} from "@/lib/type-mapping/types";
import { VALID_TARGET_TYPES } from "@/lib/type-mapping/types";
import { getDefaultPolicies } from "@/lib/type-mapping/default-mappings";

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

const denied = (what: string): Result<never> =>
  err({
    code: "PERMISSION_DENIED",
    message: "You do not have permission to do this",
    suggestedFix: `Ask an administrator for the access to ${what}.`,
  });

const OWNER = { tenantId: true, domainId: true, productId: true, product: { select: { domainId: true } } } as const;

/** Where the entity lives (its tenant, domain and product), or null when there is no such entity or the id is not one. */
async function entityPlace(entityId: unknown): Promise<ResourceRef | null> {
  if (typeof entityId !== "string" || entityId.trim() === "") return null;
  const row = await prisma.entity.findUnique({ where: { id: entityId }, select: OWNER });
  return row ? { tenantId: row.tenantId, domainId: row.domainId ?? row.product?.domainId ?? null, productId: row.productId ?? null } : null;
}

/**
 * May the caller change the per-entity overrides of `entityId`? Judged over the entity's own place: an entity that does not exist and one nothing of the
 * caller's covers are the same `NOT_FOUND`, one they see but hold too low a role over is a refusal.
 */
async function mayOverrideEntity(ctx: ServiceContext, entityId: unknown, what: string): Promise<Result<void>> {
  const place = await entityPlace(entityId);
  const assignments = [...(ctx.assignments ?? [])];
  if (!place || effectiveRole(assignments, place) === null) {
    return err({ code: "NOT_FOUND", message: `Entity "${typeof entityId === "string" ? entityId : ""}" not found`, suggestedFix: "Verify the entity ID." });
  }
  return ctxCan(ctx, "typemapping.entity", place) ? ok(undefined) : denied(what);
}

/** May the caller change the GLOBAL overrides (those of no entity)? Only a platform administrator: they reach every tenant. */
const mayOverrideGlobally = (ctx: ServiceContext, what: string): Result<void> =>
  ctxCan(ctx, "typemapping.global") ? ok(undefined) : denied(what);

/**
 * The override rows the caller may be told about: every global one, and a per-entity one only when its entity lies in the tenant in view
 * (`ctx.tenantId`) and the caller's roles let them read it (`entity.read`). With no tenant in the context (a caller that is not a page) nothing is
 * filtered. A per-entity row names its entity and what was mapped for it, so it is not for another tenant, nor for a domain the caller does not cover.
 */
async function visibleRows<T extends { entityId: string | null }>(rows: T[], ctx: ServiceContext): Promise<T[]> {
  if (ctx.tenantId === undefined) return rows;
  const entityIds = [...new Set(rows.flatMap((row) => (row.entityId ? [row.entityId] : [])))];
  if (entityIds.length === 0) return rows;
  const scopes = readableScopes([...(ctx.assignments ?? [])], "entity.read", ctx.tenantId);
  const entities = await prisma.entity.findMany({
    where: {
      id: { in: entityIds },
      tenantId: ctx.tenantId,
      ...(!scopes.all && { OR: [{ domainId: { in: scopes.domainIds } }, { productId: { in: scopes.productIds } }] }),
    },
    select: { id: true },
  });
  const readable = new Set(entities.map((entity) => entity.id));
  return rows.filter((row) => row.entityId === null || readable.has(row.entityId));
}

// ---------------------------------------------------------------------------
// resetStore — no-op, kept for test compatibility
// ---------------------------------------------------------------------------

export function _resetOverrideStore(): void {
  // No-op — Prisma persistence is managed via test mocks
}

// ---------------------------------------------------------------------------
// Helper: map Prisma row to ScopedMappingPolicy
// ---------------------------------------------------------------------------

function toScopedPolicy(row: {
  id: string;
  sourceType: string;
  targetFormat: string;
  mappedType: string;
  isLossy: boolean;
  lossDescription: string | null;
  justification: string | null;
  approvedBy: string | null;
  entityId: string | null;
  createdAt: Date;
  updatedAt: Date;
}): ScopedMappingPolicy {
  return {
    sourceType: row.sourceType,
    targetType: row.mappedType,
    targetFormat: row.targetFormat,
    mappedType: row.mappedType,
    isOverride: true,
    isLossy: row.isLossy,
    lossDescription: row.lossDescription ?? undefined,
    justification: row.justification ?? undefined,
    approvedBy: row.approvedBy ?? undefined,
    entityId: row.entityId ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// getMappingsForTarget — returns all policies (defaults + overrides) for a target
// ---------------------------------------------------------------------------

export async function getMappingsForTarget(
  targetFormat: string,
  ctx: ServiceContext
): Promise<Result<ScopedMappingPolicy[]>> {
  const defaults = getDefaultPolicies().filter(
    (p) => p.targetFormat === targetFormat
  );
  const rows = await prisma.typeMappingOverride.findMany({
    where: { targetFormat },
  });
  const overrides = (await visibleRows(rows, ctx)).map(toScopedPolicy);

  return ok([...defaults, ...overrides]);
}

// ---------------------------------------------------------------------------
// getAllMappings — returns all policies across all targets
// ---------------------------------------------------------------------------

export async function getAllMappings(
  ctx: ServiceContext
): Promise<Result<ScopedMappingPolicy[]>> {
  const defaults = getDefaultPolicies();
  const rows = await prisma.typeMappingOverride.findMany();
  const overrides = (await visibleRows(rows, ctx)).map(toScopedPolicy);
  return ok([...defaults, ...overrides]);
}

// ---------------------------------------------------------------------------
// createOverride — create an override policy (per-entity: typemapping.entity over the entity; global: typemapping.global)
// ---------------------------------------------------------------------------

export async function createOverride(
  input: CreateOverrideInput,
  ctx: ServiceContext
): Promise<Result<ScopedMappingPolicy>> {
  const allowed = input.entityId
    ? await mayOverrideEntity(ctx, input.entityId, "create per-entity type mapping overrides here")
    : mayOverrideGlobally(ctx, "create global type mapping overrides");
  if (!allowed.success) return allowed;

  // Validate input
  if (!input.sourceType || !input.targetFormat || !input.mappedType) {
    return err({
      code: "VALIDATION_ERROR",
      message: "sourceType, targetFormat, and mappedType are required",
      suggestedFix: "Provide all required fields for the override.",
    });
  }

  // Validate target type is valid for the format
  const validTypes = VALID_TARGET_TYPES[input.targetFormat];
  if (validTypes && !validTypes.includes(input.mappedType)) {
    return err({
      code: "VALIDATION_ERROR",
      message: `"${input.mappedType}" is not a valid type for target format "${input.targetFormat}"`,
      suggestedFix: `Valid types for ${input.targetFormat}: ${validTypes.join(", ")}`,
    });
  }

  // Upsert: unique on [sourceType, targetFormat, entityId]
  const row = await prisma.typeMappingOverride.upsert({
    where: {
      sourceType_targetFormat_entityId: {
        sourceType: input.sourceType,
        targetFormat: input.targetFormat,
        entityId: (input.entityId ?? null) as string,
      },
    },
    create: {
      sourceType: input.sourceType,
      targetFormat: input.targetFormat,
      mappedType: input.mappedType,
      isLossy: input.isLossy,
      lossDescription: input.lossDescription ?? null,
      justification: input.justification ?? null,
      approvedBy: ctx.userId,
      entityId: input.entityId ?? null,
    },
    update: {
      mappedType: input.mappedType,
      isLossy: input.isLossy,
      lossDescription: input.lossDescription ?? null,
      justification: input.justification ?? null,
      approvedBy: ctx.userId,
    },
  });

  return ok(toScopedPolicy(row));
}

// ---------------------------------------------------------------------------
// createGlobalOverride — create a global override (typemapping.global: a platform administrator)
// ---------------------------------------------------------------------------

export async function createGlobalOverride(
  input: Omit<CreateOverrideInput, "entityId"> & { justification: string },
  ctx: ServiceContext
): Promise<Result<ScopedMappingPolicy>> {
  const allowed = mayOverrideGlobally(ctx, "create global type mapping overrides");
  if (!allowed.success) return allowed;

  if (!input.justification?.trim()) {
    return err({
      code: "VALIDATION_ERROR",
      message: "Justification is required for overrides",
      suggestedFix: "Provide a justification explaining why this override is needed.",
    });
  }

  return createOverride(
    { ...input, entityId: undefined, justification: input.justification },
    ctx
  );
}

// ---------------------------------------------------------------------------
// createEntityOverride — create a per-entity override (typemapping.entity over the entity: an author or above where it lives)
// ---------------------------------------------------------------------------

export async function createEntityOverride(
  input: CreateOverrideInput & { entityId: string; justification: string },
  ctx: ServiceContext
): Promise<Result<ScopedMappingPolicy>> {
  if (!input.entityId) {
    return err({
      code: "VALIDATION_ERROR",
      message: "entityId is required for per-entity overrides",
      suggestedFix: "Provide the entity ID for this per-entity override.",
    });
  }

  const allowed = await mayOverrideEntity(ctx, input.entityId, "create per-entity type mapping overrides here");
  if (!allowed.success) return allowed;

  if (!input.justification?.trim()) {
    return err({
      code: "VALIDATION_ERROR",
      message: "Justification is required for overrides",
      suggestedFix: "Provide a justification explaining why this override is needed.",
    });
  }

  return createOverride(input, ctx);
}

// ---------------------------------------------------------------------------
// acknowledgeLossyMapping — acknowledge a lossy mapping for an entity
// ---------------------------------------------------------------------------

export async function acknowledgeLossyMapping(
  input: {
    entityId: string;
    sourceType: string;
    targetFormat: string;
  },
  ctx: ServiceContext
): Promise<Result<{ acknowledged: boolean }>> {
  const allowed = await mayOverrideEntity(ctx, input.entityId, "acknowledge lossy mappings here");
  if (!allowed.success) return allowed;

  await prisma.lossyMappingAck.upsert({
    where: {
      entityId_sourceType_targetFormat_userId: {
        entityId: input.entityId,
        sourceType: input.sourceType,
        targetFormat: input.targetFormat,
        userId: ctx.userId,
      },
    },
    create: {
      entityId: input.entityId,
      sourceType: input.sourceType,
      targetFormat: input.targetFormat,
      userId: ctx.userId,
    },
    update: {
      acknowledgedAt: new Date(),
    },
  });

  return ok({ acknowledged: true });
}

// ---------------------------------------------------------------------------
// isLossyMappingAcknowledged — check if a lossy mapping has been acknowledged
// ---------------------------------------------------------------------------

export async function isLossyMappingAcknowledged(
  entityId: string,
  sourceType: string,
  targetFormat: string
): Promise<boolean> {
  const count = await prisma.lossyMappingAck.count({
    where: { entityId, sourceType, targetFormat },
  });
  return count > 0;
}

// ---------------------------------------------------------------------------
// getOverridesForEntity — get all overrides applicable to an entity
// ---------------------------------------------------------------------------

export async function getOverridesForEntity(
  entityId: string,
  _ctx: ServiceContext
): Promise<Result<ScopedMappingPolicy[]>> {
  const rows = await prisma.typeMappingOverride.findMany({
    where: {
      OR: [{ entityId }, { entityId: null }],
    },
  });
  return ok(rows.map(toScopedPolicy));
}

// ---------------------------------------------------------------------------
// deleteOverride — remove an override policy (per-entity: typemapping.entity over the entity; global: typemapping.global)
// ---------------------------------------------------------------------------

export async function deleteOverride(
  sourceType: string,
  targetFormat: string,
  ctx: ServiceContext,
  entityId?: string
): Promise<Result<{ deleted: boolean }>> {
  const allowed = entityId
    ? await mayOverrideEntity(ctx, entityId, "delete per-entity type mapping overrides here")
    : mayOverrideGlobally(ctx, "delete global type mapping overrides");
  if (!allowed.success) return allowed;

  try {
    await prisma.typeMappingOverride.delete({
      where: {
        sourceType_targetFormat_entityId: {
          sourceType,
          targetFormat,
          entityId: (entityId ?? null) as string,
        },
      },
    });
    return ok({ deleted: true });
  } catch {
    // Record not found — nothing to delete
    return ok({ deleted: false });
  }
}
