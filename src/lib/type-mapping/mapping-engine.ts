/**
 * resolveMapping() — pure function that resolves a logical type to a
 * target-specific type using mapping policies.
 *
 * Override precedence chain:
 *   per-entity override > global override > default mapping
 *
 * Zero side effects, zero database access.
 */

import type {
  MappingResult,
  MappingError,
  ScopedMappingPolicy,
} from "./types";

// ---------------------------------------------------------------------------
// Result type for resolveMapping — success or error
// ---------------------------------------------------------------------------

export type ResolveMappingResult =
  | { success: true; result: MappingResult }
  | { success: false; error: MappingError };

// ---------------------------------------------------------------------------
// resolveMapping — the core pure function
// ---------------------------------------------------------------------------

/**
 * Resolve a logical type to a target-specific type.
 *
 * @param sourceType - The logical type (e.g., "string", "decimal", "map")
 * @param targetFormat - The target format (e.g., "bigquery", "avro", "openapi")
 * @param policies - All mapping policies (defaults + overrides)
 * @param entityId - Optional entity ID for per-entity override resolution
 * @returns MappingResult on success, MappingError on failure
 */
export function resolveMapping(
  sourceType: string,
  targetFormat: string,
  policies: ScopedMappingPolicy[],
  entityId?: string,
  fieldId?: string
): ResolveMappingResult {
  // Filter policies matching this source type and target format
  const candidates = policies.filter(
    (p) => p.sourceType === sourceType && p.targetFormat === targetFormat
  );

  if (candidates.length === 0) {
    return {
      success: false,
      error: {
        code: "MAPPING_NOT_FOUND",
        message: `No mapping found for "${sourceType}" → "${targetFormat}"`,
        suggestedFix: `Add a mapping policy for source type "${sourceType}" targeting "${targetFormat}". You can create an override policy in the type mapping settings.`,
        sourceType,
        targetFormat,
      },
    };
  }

  // Apply override precedence chain:
  // 1. Per-entity override (highest priority)
  // 2. Global override
  // 3. Default mapping (lowest priority)

  let selected: ScopedMappingPolicy | undefined;
  const defaultPolicy = candidates.find(
    (p) => !p.isOverride && !p.entityId && !p.fieldId
  );

  // 0. Field-level override
  if (fieldId) {
    selected = candidates.find((p) => p.isOverride && p.fieldId === fieldId);
  }

  // 1. Per-entity override
  if (!selected && entityId) {
    selected = candidates.find(
      (p) => p.isOverride && p.entityId === entityId && !p.fieldId
    );
  }

  // 2. Global override (isOverride = true, no entityId)
  if (!selected) {
    selected = candidates.find(
      (p) => p.isOverride && !p.entityId && !p.fieldId
    );
  }

  // 3. Default mapping (isOverride = false)
  if (!selected) {
    selected = candidates.find((p) => !p.isOverride);
  }

  if (!selected) {
    return {
      success: false,
      error: {
        code: "MAPPING_NOT_FOUND",
        message: `No applicable mapping found for "${sourceType}" → "${targetFormat}"`,
        suggestedFix: `Check that mapping policies exist for source type "${sourceType}" targeting "${targetFormat}".`,
        sourceType,
        targetFormat,
      },
    };
  }

  return {
    success: true,
    result: {
      mappedType: selected.mappedType,
      isLossy: selected.isLossy,
      lossDescription: selected.lossDescription,
      isOverride: selected.isOverride,
      defaultMappedType: defaultPolicy?.mappedType,
      overrideSource: selected.isOverride
        ? selected.fieldId
          ? "field"
          : selected.entityId
          ? "per-entity"
          : "global"
        : undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// resolveMappingWithPrecision — handles decimal(p,s) interpolation
// ---------------------------------------------------------------------------

/**
 * Resolve a mapping with optional precision/scale interpolation.
 *
 * For decimal types with precision/scale, the mapped type may include
 * placeholders: e.g., BigQuery NUMERIC → NUMERIC(p,s) when precision
 * and scale are provided.
 */
export function resolveMappingWithPrecision(
  sourceType: string,
  targetFormat: string,
  policies: ScopedMappingPolicy[],
  precision?: number,
  scale?: number,
  entityId?: string,
  fieldId?: string
): ResolveMappingResult {
  const result = resolveMapping(sourceType, targetFormat, policies, entityId, fieldId);

  if (!result.success) {
    return result;
  }

  // Interpolate precision/scale for numeric types
  if (precision !== undefined && scale !== undefined) {
    const mappedType = interpolatePrecisionScale(
      result.result.mappedType,
      precision,
      scale,
      targetFormat
    );
    return {
      success: true,
      result: {
        ...result.result,
        mappedType,
      },
    };
  }

  return result;
}

// ---------------------------------------------------------------------------
// Precision/scale interpolation
// ---------------------------------------------------------------------------

function interpolatePrecisionScale(
  mappedType: string,
  precision: number,
  scale: number,
  targetFormat: string
): string {
  switch (targetFormat) {
    case "bigquery":
      // NUMERIC → NUMERIC(p,s), BIGNUMERIC → BIGNUMERIC(p,s)
      if (mappedType === "NUMERIC" || mappedType === "BIGNUMERIC") {
        return `${mappedType}(${precision},${scale})`;
      }
      return mappedType;

    case "avro":
      // bytes/decimal → bytes/decimal with logicalType precision/scale
      // (The precision/scale is encoded in the Avro schema, not the type name)
      return mappedType;

    case "openapi":
      // number/double doesn't support precision in the type name
      return mappedType;

    case "postgresql":
      if (mappedType === "numeric" || mappedType === "decimal") {
        return `${mappedType}(${precision},${scale})`;
      }
      return mappedType;

    default:
      return mappedType;
  }
}

// ---------------------------------------------------------------------------
// Batch resolution — resolve all fields in a model
// ---------------------------------------------------------------------------

export interface BatchMappingResult {
  fieldName: string;
  sourceType: string;
  result: ResolveMappingResult;
}

/**
 * Resolve mappings for multiple fields at once.
 */
export function resolveMappingsForFields(
  fields: Array<{
    id?: string;
    name: string;
    type: string;
    precision?: number;
    scale?: number;
  }>,
  targetFormat: string,
  policies: ScopedMappingPolicy[],
  entityId?: string
): BatchMappingResult[] {
  return fields.map((field) => ({
    fieldName: field.name,
    sourceType: field.type,
    result: resolveMappingWithPrecision(
      field.type,
      targetFormat,
      policies,
      field.precision,
      field.scale,
      entityId,
      field.id
    ),
  }));
}

// ---------------------------------------------------------------------------
// Lossy detection helpers
// ---------------------------------------------------------------------------

/**
 * Check if any mappings in a batch result are lossy.
 */
export function hasLossyMappings(results: BatchMappingResult[]): boolean {
  return results.some(
    (r) => r.result.success && r.result.result.isLossy
  );
}

/**
 * Get all lossy mappings from a batch result.
 */
export function getLossyMappings(
  results: BatchMappingResult[]
): BatchMappingResult[] {
  return results.filter(
    (r) => r.result.success && r.result.result.isLossy
  );
}

/**
 * Get all failed mappings from a batch result.
 */
export function getFailedMappings(
  results: BatchMappingResult[]
): BatchMappingResult[] {
  return results.filter((r) => !r.result.success);
}
