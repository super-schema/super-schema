/**
 * Emission pipeline types.
 *
 * Defines the shape of emission results returned by the emission service.
 * Pure types — no runtime dependencies.
 */

import type { EmitterWarning, ValidationError } from "@/lib/compiler/types";
import type { EmittedFile } from "@/lib/typespec-official/closure-emit";

// ---------------------------------------------------------------------------
// Validation status for an emitted target
// ---------------------------------------------------------------------------

export type ValidationStatus = "VALID" | "INVALID" | "WARNING";

// ---------------------------------------------------------------------------
// Per-target output from emission
// ---------------------------------------------------------------------------

export interface TargetOutput {
  /** The emitter name (e.g., "bigquery", "avro", "openapi") */
  name: string;
  /** The target format identifier (e.g., "bigquery-ddl", "avro-schema", "openapi-3.1") */
  targetFormat: string;
  /** The emitted output string (DDL, JSON, YAML, etc.); for a closure target, the bundled `===== path =====` string of `files`. */
  output: string;
  /** The structured form of `output`: one file per entity, for the closure targets only (the DB targets emit one string). */
  files?: EmittedFile[];
  /** Whether the output passed validation */
  isValid: boolean;
  /** Computed validation status */
  validationStatus: ValidationStatus;
  /** Warnings from the emitter (lossy mappings, etc.) */
  warnings: EmitterWarning[];
  /** Validation errors if output is invalid */
  errors: ValidationError[];
}

// ---------------------------------------------------------------------------
// Full emission result — all targets + TypeSpec source
// ---------------------------------------------------------------------------

export interface EmissionResult {
  /** The generated TypeSpec source code */
  typespec: string;
  /**
   * Set when the reference closure could not be built (an ambiguous bare-name reference, a pin that is gone, an entity never published ...):
   * every closure target is then INVALID with its message. Structured, so the caller can ask for the pick an ambiguous reference needs
   * (`pickRequestOfRefusal`) instead of showing "N targets invalid".
   */
  refusal?: { code: string; message: string; details?: object; suggestedFix?: string };
  /** Per-target emission outputs keyed by emitter name */
  targets: Record<string, TargetOutput>;
  /** Overall success — true if all targets are valid or have only warnings */
  success: boolean;
  /** Summary counts */
  summary: {
    totalTargets: number;
    validCount: number;
    warningCount: number;
    invalidCount: number;
  };
}
