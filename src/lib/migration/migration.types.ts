/**
 * Migration Artifact Types
 *
 * Types for migration artifact generation across all target formats.
 * Pure type definitions — no runtime dependencies.
 */

// ---------------------------------------------------------------------------
// Migration Artifact — a single generated artifact for a target
// ---------------------------------------------------------------------------

export interface MigrationArtifact {
  /** Artifact type, e.g. "ddl", "compatibility-report", "changelog" */
  type: string;
  /** The generated content (SQL, JSON, text) */
  content: string;
  /** Warnings to display (destructive ops, breaking changes, lossy conversions) */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Per-target migration output
// ---------------------------------------------------------------------------

export interface TargetMigrationOutput {
  targetFormat: string;
  artifacts: MigrationArtifact[];
}

// ---------------------------------------------------------------------------
// Complete migration artifacts for all targets
// ---------------------------------------------------------------------------

export interface MigrationArtifacts {
  targets: TargetMigrationOutput[];
}

// ---------------------------------------------------------------------------
// Avro Compatibility Classification
// ---------------------------------------------------------------------------

export type AvroCompatibility = "BACKWARD" | "FORWARD" | "FULL" | "BREAKING";

export interface CompatibilityResult {
  compatible: boolean;
  compatibility: AvroCompatibility;
  details: string[];
}

// ---------------------------------------------------------------------------
// OpenAPI Breaking Change
// ---------------------------------------------------------------------------

export type BreakingChangeSeverity = "breaking" | "non-breaking";

export interface OpenAPIChange {
  field: string;
  change: string;
  severity: BreakingChangeSeverity;
  description: string;
}

export interface OpenAPIBreakingChangeResult {
  breakingChanges: OpenAPIChange[];
  nonBreakingChanges: OpenAPIChange[];
  hasBreakingChanges: boolean;
}
