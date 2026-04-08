/**
 * Type mapping types — shared across the mapping engine and service layer.
 *
 * MappingPolicy is re-exported from the IR model for convenience.
 */

import type { LogicalType, MappingPolicy } from "@/types/super-schema-model";
import { getValidTargetTypesFor } from "./target-type-catalog";

// Re-export for consumer convenience
export type { LogicalType, MappingPolicy };

// ---------------------------------------------------------------------------
// Supported target formats
// ---------------------------------------------------------------------------

export type TargetFormat =
  | "bigquery"
  | "avro"
  | "openapi"
  | "spanner"
  | "postgresql"
  | "openapi3"
  | "json-schema"
  | "protobuf";

export const TARGET_FORMATS: TargetFormat[] = [
  "bigquery",
  "avro",
  "openapi",
  "spanner",
  "postgresql",
  "openapi3",
  "json-schema",
  "protobuf",
];

// ---------------------------------------------------------------------------
// Mapping result — returned by resolveMapping()
// ---------------------------------------------------------------------------

export interface MappingResult {
  mappedType: string;
  isLossy: boolean;
  lossDescription?: string;
  isOverride: boolean;
  overrideSource?: "field" | "global" | "per-entity";
  defaultMappedType?: string;
}

// ---------------------------------------------------------------------------
// Valid target types per format — for override autocomplete
// ---------------------------------------------------------------------------

export const VALID_TARGET_TYPES: Record<string, string[]> = Object.fromEntries(
  TARGET_FORMATS.map((target) => [target, getValidTargetTypesFor(target)])
);

// ---------------------------------------------------------------------------
// Mapping error — returned when no mapping exists
// ---------------------------------------------------------------------------

export interface MappingError {
  code: "MAPPING_NOT_FOUND";
  message: string;
  suggestedFix: string;
  sourceType: string;
  targetFormat: string;
}

// ---------------------------------------------------------------------------
// Default mapping entry — static config shape
// ---------------------------------------------------------------------------

export interface DefaultMappingEntry {
  sourceType: string;
  targetFormat: TargetFormat;
  mappedType: string;
  isLossy: boolean;
  lossDescription?: string;
}

// ---------------------------------------------------------------------------
// Create override input — for the service layer
// ---------------------------------------------------------------------------

export interface CreateOverrideInput {
  sourceType: string;
  targetFormat: string;
  mappedType: string;
  isLossy: boolean;
  lossDescription?: string;
  entityId?: string; // per-entity override scope
  justification?: string; // required for overrides
}

// ---------------------------------------------------------------------------
// Mapping policy with scope — extends MappingPolicy for override chain
// ---------------------------------------------------------------------------

export interface ScopedMappingPolicy extends MappingPolicy {
  id?: string;
  entityId?: string; // undefined = global, set = per-entity
  fieldId?: string;
  fieldName?: string;
  isLossy: boolean;
  lossDescription?: string;
  justification?: string;
  acknowledged?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}
