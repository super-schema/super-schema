/**
 * Migration Orchestrator
 *
 * Pure function that takes a VersionDiff and generates migration artifacts
 * for all three target formats (BigQuery, Avro, OpenAPI).
 *
 * No side effects, no database access.
 */

import type { VersionDiff } from "@/services/version-history/version.types";
import type { ScopedMappingPolicy } from "@/lib/type-mapping/types";
import type { MigrationArtifacts } from "./migration.types";
import { generateBigQueryMigration } from "./bigquery-migration";
import { generateAvroMigration } from "./avro-compatibility";
import { generateOpenAPIMigration } from "./openapi-breaking";

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Generate migration artifacts for all three target formats from a VersionDiff.
 *
 * @param entityName - The entity name (used for table/schema naming)
 * @param domainName - The domain name (used for dataset/namespace)
 * @param diff - The version diff containing field changes
 * @param policies - Type mapping policies for resolving logical types
 * @returns MigrationArtifacts with per-target outputs
 */
export function generateMigrationArtifacts(
  entityName: string,
  domainName: string,
  diff: VersionDiff,
  policies: ScopedMappingPolicy[]
): MigrationArtifacts {
  const bigqueryArtifacts = generateBigQueryMigration(
    entityName,
    domainName,
    diff.changes,
    policies
  );

  const avroArtifact = generateAvroMigration(diff.changes);

  const openapiArtifact = generateOpenAPIMigration(diff.changes);

  return {
    targets: [
      {
        targetFormat: "bigquery",
        artifacts: bigqueryArtifacts,
      },
      {
        targetFormat: "avro",
        artifacts: [avroArtifact],
      },
      {
        targetFormat: "openapi",
        artifacts: [openapiArtifact],
      },
    ],
  };
}
