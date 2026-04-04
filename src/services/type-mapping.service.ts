/**
 * Type mapping service — orchestrates mapping resolution with RBAC,
 * audit trail, and override management.
 *
 * Overrides and acknowledgments are persisted via Prisma.
 * Default mappings come from static TypeScript config.
 */

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
// Allowed roles for creating overrides
// ---------------------------------------------------------------------------

const GLOBAL_OVERRIDE_ROLES = ["STEWARD", "ADMIN"];
const ENTITY_OVERRIDE_ROLES = ["AUTHOR", "STEWARD", "ADMIN"];

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
  _ctx: ServiceContext
): Promise<Result<ScopedMappingPolicy[]>> {
  const defaults = getDefaultPolicies().filter(
    (p) => p.targetFormat === targetFormat
  );
  const rows = await prisma.typeMappingOverride.findMany({
    where: { targetFormat },
  });
  const overrides = rows.map(toScopedPolicy);

  return ok([...defaults, ...overrides]);
}

// ---------------------------------------------------------------------------
// getAllMappings — returns all policies across all targets
// ---------------------------------------------------------------------------

export async function getAllMappings(
  _ctx: ServiceContext
): Promise<Result<ScopedMappingPolicy[]>> {
  const defaults = getDefaultPolicies();
  const rows = await prisma.typeMappingOverride.findMany();
  const overrides = rows.map(toScopedPolicy);
  return ok([...defaults, ...overrides]);
}

// ---------------------------------------------------------------------------
// createOverride — create an override policy (requires Steward/Admin role)
// ---------------------------------------------------------------------------

export async function createOverride(
  input: CreateOverrideInput,
  ctx: ServiceContext
): Promise<Result<ScopedMappingPolicy>> {
  // RBAC check — backward compatible: if no entityId, require STEWARD/ADMIN
  const allowedRoles = input.entityId
    ? ENTITY_OVERRIDE_ROLES
    : GLOBAL_OVERRIDE_ROLES;

  if (!allowedRoles.includes(ctx.userRole)) {
    const scopeLabel = input.entityId ? "per-entity" : "global";
    return err({
      code: "PERMISSION_DENIED",
      message: `Only ${allowedRoles.join(" or ")} users can create ${scopeLabel} type mapping overrides`,
      suggestedFix: `Your current role is "${ctx.userRole}". Contact a Steward or Admin to create this override.`,
    });
  }

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
// createGlobalOverride — create a global override (Steward/Admin only)
// ---------------------------------------------------------------------------

export async function createGlobalOverride(
  input: Omit<CreateOverrideInput, "entityId"> & { justification: string },
  ctx: ServiceContext
): Promise<Result<ScopedMappingPolicy>> {
  if (!GLOBAL_OVERRIDE_ROLES.includes(ctx.userRole)) {
    return err({
      code: "PERMISSION_DENIED",
      message: "Only Steward or Admin users can create global type mapping overrides",
      suggestedFix: `Your current role is "${ctx.userRole}". Contact a Steward or Admin to create this override.`,
    });
  }

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
// createEntityOverride — create a per-entity override (Author/Steward/Admin)
// ---------------------------------------------------------------------------

export async function createEntityOverride(
  input: CreateOverrideInput & { entityId: string; justification: string },
  ctx: ServiceContext
): Promise<Result<ScopedMappingPolicy>> {
  if (!ENTITY_OVERRIDE_ROLES.includes(ctx.userRole)) {
    return err({
      code: "PERMISSION_DENIED",
      message: "Only Author, Steward, or Admin users can create per-entity type mapping overrides",
      suggestedFix: `Your current role is "${ctx.userRole}". You need at least Author role to create per-entity overrides.`,
    });
  }

  if (!input.justification?.trim()) {
    return err({
      code: "VALIDATION_ERROR",
      message: "Justification is required for overrides",
      suggestedFix: "Provide a justification explaining why this override is needed.",
    });
  }

  if (!input.entityId) {
    return err({
      code: "VALIDATION_ERROR",
      message: "entityId is required for per-entity overrides",
      suggestedFix: "Provide the entity ID for this per-entity override.",
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
  if (!ENTITY_OVERRIDE_ROLES.includes(ctx.userRole)) {
    return err({
      code: "PERMISSION_DENIED",
      message: "Only Author, Steward, or Admin users can acknowledge lossy mappings",
      suggestedFix: `Your current role is "${ctx.userRole}". You need at least Author role.`,
    });
  }

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
// deleteOverride — remove an override policy (requires Steward/Admin role)
// ---------------------------------------------------------------------------

export async function deleteOverride(
  sourceType: string,
  targetFormat: string,
  ctx: ServiceContext,
  entityId?: string
): Promise<Result<{ deleted: boolean }>> {
  // RBAC check
  if (!GLOBAL_OVERRIDE_ROLES.includes(ctx.userRole)) {
    return err({
      code: "PERMISSION_DENIED",
      message: "Only Steward or Admin users can delete type mapping overrides",
      suggestedFix: `Your current role is "${ctx.userRole}". Contact a Steward or Admin to delete this override.`,
    });
  }

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
