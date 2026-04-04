/**
 * Migration module barrel export
 */

// Types
export type {
  MigrationArtifact,
  MigrationArtifacts,
  TargetMigrationOutput,
  CompatibilityResult,
  AvroCompatibility,
  OpenAPIChange,
  OpenAPIBreakingChangeResult,
  BreakingChangeSeverity,
} from "./migration.types";

// BigQuery migration generator
export { generateBigQueryMigration } from "./bigquery-migration";

// Avro compatibility classifier
export {
  classifyAvroCompatibility,
  generateAvroMigration,
} from "./avro-compatibility";

// OpenAPI breaking change detector
export {
  detectOpenAPIBreakingChanges,
  generateOpenAPIMigration,
} from "./openapi-breaking";

// Orchestrator
export { generateMigrationArtifacts } from "./generate-migration";
