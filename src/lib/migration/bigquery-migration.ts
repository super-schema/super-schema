/**
 * BigQuery Migration Generator
 *
 * Pure function: takes a ChangeEntry[] diff and produces ALTER TABLE DDL statements.
 * Uses type mapping policies to resolve logical types to BigQuery types.
 *
 * No side effects, no database access.
 */

import type { ChangeEntry } from "@/services/version-history/version.types";
import type { ScopedMappingPolicy } from "@/lib/type-mapping/types";
import type { MigrationArtifact } from "./migration.types";
import { resolveMappingWithPrecision } from "@/lib/type-mapping/mapping-engine";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a name to snake_case (matches BigQuery emitter convention).
 */
function toSnakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[\s\-]+/g, "_")
    .replace(/[^a-zA-Z0-9_]/g, "")
    .toLowerCase();
}

/**
 * Resolve a logical type to a BigQuery type using mapping policies.
 */
function resolveBigQueryType(
  logicalType: string,
  policies: ScopedMappingPolicy[],
  precision?: number | null,
  scale?: number | null
): string {
  const result = resolveMappingWithPrecision(
    logicalType,
    "bigquery",
    policies,
    precision ?? undefined,
    scale ?? undefined
  );
  if (result.success) {
    return result.result.mappedType;
  }
  return "STRING"; // fallback
}

/**
 * Known safe type widening conversions in BigQuery.
 * If the conversion is not in this set, it is considered unsafe.
 */
const SAFE_TYPE_CONVERSIONS = new Set([
  "INT64->FLOAT64",
  "INT64->NUMERIC",
  "INT64->BIGNUMERIC",
  "FLOAT64->NUMERIC",
  "FLOAT64->BIGNUMERIC",
  "NUMERIC->BIGNUMERIC",
  "DATE->DATETIME",
  "DATE->TIMESTAMP",
  "DATETIME->TIMESTAMP",
  "STRING->BYTES",
]);

function isTypeCastSafe(fromType: string, toType: string): boolean {
  return SAFE_TYPE_CONVERSIONS.has(`${fromType}->${toType}`);
}

// ---------------------------------------------------------------------------
// BigQuery Migration Generator
// ---------------------------------------------------------------------------

/**
 * Generate BigQuery ALTER TABLE DDL statements from a set of field changes.
 *
 * @param entityName - The entity name (used as table name)
 * @param domainName - The domain name (used as dataset prefix)
 * @param changes - The list of field changes from computeFieldDiff()
 * @param policies - Type mapping policies for resolving logical types
 * @returns Array of MigrationArtifact containing DDL statements
 */
export function generateBigQueryMigration(
  entityName: string,
  domainName: string,
  changes: ChangeEntry[],
  policies: ScopedMappingPolicy[]
): MigrationArtifact[] {
  if (changes.length === 0) {
    return [];
  }

  const tableName = `${toSnakeCase(domainName)}.${toSnakeCase(entityName)}`;
  const statements: string[] = [];
  const warnings: string[] = [];

  for (const change of changes) {
    switch (change.type) {
      case "added": {
        const field = change.details.after!;
        const bqType = resolveBigQueryType(
          field.type,
          policies,
          field.precision,
          field.scale
        );
        const nullableClause = field.nullable ? "" : " NOT NULL";
        const descriptionOption = field.description
          ? ` OPTIONS(description='${field.description.replace(/'/g, "\\'")}')`
          : "";
        statements.push(
          `ALTER TABLE ${tableName} ADD COLUMN ${toSnakeCase(field.name)} ${bqType}${nullableClause}${descriptionOption};`
        );
        break;
      }

      case "removed": {
        const field = change.details.before!;
        const colName = toSnakeCase(field.name);
        statements.push(
          `-- ALTER TABLE ${tableName} DROP COLUMN ${colName};`
        );
        warnings.push(
          `DROP COLUMN ${colName}: Manual review required \u2014 dropping columns deletes data`
        );
        break;
      }

      case "modified": {
        const before = change.details.before!;
        const after = change.details.after!;
        const colName = toSnakeCase(after.name);
        const changedProps = change.details.changedProperties;

        // Type change
        if (changedProps.includes("type") || changedProps.includes("precision") || changedProps.includes("scale")) {
          const oldBqType = resolveBigQueryType(
            before.type,
            policies,
            before.precision,
            before.scale
          );
          const newBqType = resolveBigQueryType(
            after.type,
            policies,
            after.precision,
            after.scale
          );

          if (oldBqType !== newBqType) {
            statements.push(
              `ALTER TABLE ${tableName} ALTER COLUMN ${colName} SET DATA TYPE ${newBqType};`
            );

            if (!isTypeCastSafe(oldBqType, newBqType)) {
              warnings.push(
                `ALTER COLUMN ${colName} SET DATA TYPE ${newBqType}: Unsafe type conversion from ${oldBqType} to ${newBqType} \u2014 may cause data loss or errors`
              );
            }
          }
        }

        // Nullable change
        if (changedProps.includes("nullable")) {
          if (after.nullable && !before.nullable) {
            statements.push(
              `ALTER TABLE ${tableName} ALTER COLUMN ${colName} DROP NOT NULL;`
            );
          } else if (!after.nullable && before.nullable) {
            statements.push(
              `ALTER TABLE ${tableName} ALTER COLUMN ${colName} SET NOT NULL;`
            );
            warnings.push(
              `ALTER COLUMN ${colName} SET NOT NULL: Existing NULL values will cause this statement to fail`
            );
          }
        }

        // Description change
        if (changedProps.includes("description")) {
          const desc = after.description
            ? after.description.replace(/'/g, "\\'")
            : "";
          statements.push(
            `ALTER TABLE ${tableName} ALTER COLUMN ${colName} SET OPTIONS(description='${desc}');`
          );
        }

        break;
      }
    }
  }

  if (statements.length === 0) {
    return [];
  }

  return [
    {
      type: "ddl",
      content: statements.join("\n"),
      warnings,
    },
  ];
}
