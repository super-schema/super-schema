/**
 * Type mapping service — orchestrates mapping resolution with RBAC,
 * audit trail, and override management.
 *
 * For MVP, default mappings come from static TypeScript config (no database).
 * Overrides are stored in-memory for now; database persistence will be added
 * when Prisma migration for type_mapping_policies is created.
 */

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
// In-memory override store (MVP — will move to Prisma in future)
// ---------------------------------------------------------------------------

let overrideStore: ScopedMappingPolicy[] = [];

// In-memory acknowledgment store (MVP)
let acknowledgmentStore: Array<{
  entityId: string;
  sourceType: string;
  targetFormat: string;
  userId: string;
  acknowledgedAt: Date;
}> = [];

/**
 * Reset override store — for testing only.
 */
export function _resetOverrideStore(): void {
  overrideStore = [];
  acknowledgmentStore = [];
}

// ---------------------------------------------------------------------------
// Allowed roles for creating overrides
// ---------------------------------------------------------------------------

const GLOBAL_OVERRIDE_ROLES = ["STEWARD", "ADMIN"];
const ENTITY_OVERRIDE_ROLES = ["AUTHOR", "STEWARD", "ADMIN"];

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
  const overrides = overrideStore.filter(
    (p) => p.targetFormat === targetFormat
  );

  return ok([...defaults, ...overrides]);
}

// ---------------------------------------------------------------------------
// getAllMappings — returns all policies across all targets
// ---------------------------------------------------------------------------

export async function getAllMappings(
  _ctx: ServiceContext
): Promise<Result<ScopedMappingPolicy[]>> {
  const defaults = getDefaultPolicies();
  return ok([...defaults, ...overrideStore]);
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

  // Check for duplicate override
  const existingIndex = overrideStore.findIndex(
    (p) =>
      p.sourceType === input.sourceType &&
      p.targetFormat === input.targetFormat &&
      p.entityId === input.entityId
  );

  const policy: ScopedMappingPolicy = {
    sourceType: input.sourceType,
    targetType: input.mappedType,
    targetFormat: input.targetFormat,
    mappedType: input.mappedType,
    isOverride: true,
    isLossy: input.isLossy,
    lossDescription: input.lossDescription,
    justification: input.justification,
    approvedBy: ctx.userId,
    entityId: input.entityId,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  if (existingIndex >= 0) {
    // Replace existing override
    overrideStore[existingIndex] = policy;
  } else {
    overrideStore.push(policy);
  }

  return ok(policy);
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

  // Check for existing acknowledgment
  const existingIndex = acknowledgmentStore.findIndex(
    (a) =>
      a.entityId === input.entityId &&
      a.sourceType === input.sourceType &&
      a.targetFormat === input.targetFormat
  );

  const ack = {
    entityId: input.entityId,
    sourceType: input.sourceType,
    targetFormat: input.targetFormat,
    userId: ctx.userId,
    acknowledgedAt: new Date(),
  };

  if (existingIndex >= 0) {
    acknowledgmentStore[existingIndex] = ack;
  } else {
    acknowledgmentStore.push(ack);
  }

  return ok({ acknowledged: true });
}

// ---------------------------------------------------------------------------
// isLossyMappingAcknowledged — check if a lossy mapping has been acknowledged
// ---------------------------------------------------------------------------

export function isLossyMappingAcknowledged(
  entityId: string,
  sourceType: string,
  targetFormat: string
): boolean {
  return acknowledgmentStore.some(
    (a) =>
      a.entityId === entityId &&
      a.sourceType === sourceType &&
      a.targetFormat === targetFormat
  );
}

// ---------------------------------------------------------------------------
// getOverridesForEntity — get all overrides applicable to an entity
// ---------------------------------------------------------------------------

export async function getOverridesForEntity(
  entityId: string,
  _ctx: ServiceContext
): Promise<Result<ScopedMappingPolicy[]>> {
  const entityOverrides = overrideStore.filter(
    (p) => p.entityId === entityId
  );
  const globalOverrides = overrideStore.filter(
    (p) => !p.entityId
  );
  return ok([...entityOverrides, ...globalOverrides]);
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

  const initialLength = overrideStore.length;
  overrideStore = overrideStore.filter(
    (p) =>
      !(
        p.sourceType === sourceType &&
        p.targetFormat === targetFormat &&
        p.entityId === entityId
      )
  );

  return ok({ deleted: overrideStore.length < initialLength });
}
