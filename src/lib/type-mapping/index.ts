/**
 * Type mapping module — barrel export.
 *
 * Provides the mapping engine (pure functions) and default mapping data
 * for translating logical types to platform-specific types.
 */

// Types
export type {
  MappingResult,
  MappingError,
  DefaultMappingEntry,
  ScopedMappingPolicy,
  CreateOverrideInput,
  TargetFormat,
  LogicalType,
  MappingPolicy,
} from "./types";
export { TARGET_FORMATS } from "./types";

// Mapping engine (pure functions)
export {
  resolveMapping,
  resolveMappingWithPrecision,
  resolveMappingsForFields,
  hasLossyMappings,
  getLossyMappings,
  getFailedMappings,
} from "./mapping-engine";
export type { ResolveMappingResult, BatchMappingResult } from "./mapping-engine";

// Default mappings (static data)
export {
  DEFAULT_MAPPINGS,
  getDefaultPolicies,
  getDefaultMappingsForTarget,
  getDefaultMapping,
} from "./default-mappings";
