/**
 * BigQuery DDL Emitter — generates CREATE TABLE DDL from SuperSchemaModel.
 *
 * Implements the Emitter interface. Uses resolveMapping() from the
 * type mapping engine to resolve logical types to BigQuery types.
 *
 * Deterministic: same input always produces identical output.
 */

import type {
  SuperSchemaModel,
  SuperSchemaField,
  MappingPolicy,
} from "@/types/super-schema-model";
import type { ScopedMappingPolicy } from "@/lib/type-mapping/types";
import type {
  Emitter,
  EmitterResult,
  EmitterWarning,
  ValidationResult,
} from "@/lib/compiler/types";
import { resolveMappingWithPrecision } from "@/lib/type-mapping/mapping-engine";
import { validateBigQueryDDL } from "./bigquery.validator";

// ---------------------------------------------------------------------------
// BigQuery reserved keywords that must be backtick-quoted
// ---------------------------------------------------------------------------

const BIGQUERY_RESERVED_KEYWORDS = new Set([
  "all", "and", "any", "array", "as", "asc", "assert_rows_modified", "at",
  "between", "by", "case", "cast", "collate", "contains", "create", "cross",
  "cube", "current", "default", "define", "desc", "distinct", "else", "end",
  "enum", "escape", "except", "exclude", "exists", "extract", "false",
  "fetch", "following", "for", "from", "full", "group", "grouping", "groups",
  "hash", "having", "if", "ignore", "in", "inner", "intersect", "interval",
  "into", "is", "join", "lateral", "left", "like", "limit", "lookup",
  "merge", "natural", "new", "no", "not", "null", "nulls", "of", "on", "or",
  "order", "outer", "over", "partition", "preceding", "proto", "range",
  "recursive", "respect", "right", "rollup", "rows", "select", "set", "some",
  "struct", "tablesample", "then", "to", "treat", "true", "unbounded",
  "union", "unnest", "using", "when", "where", "window", "with", "within",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a name to snake_case.
 */
export function toSnakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[\s\-]+/g, "_")
    .replace(/[^a-zA-Z0-9_]/g, "")
    .toLowerCase();
}

/**
 * Quote a column name if it is a BigQuery reserved keyword.
 */
function quoteIfReserved(name: string): string {
  const snaked = toSnakeCase(name);
  if (BIGQUERY_RESERVED_KEYWORDS.has(snaked.toLowerCase())) {
    return `\`${snaked}\``;
  }
  return snaked;
}

/**
 * Escape a single-quoted SQL string value.
 */
function escapeSqlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// ---------------------------------------------------------------------------
// Partition type validation
// ---------------------------------------------------------------------------

const PARTITIONABLE_BQ_TYPES = new Set([
  "DATE", "TIMESTAMP", "DATETIME",
]);

function isPartitionableType(bqType: string): boolean {
  // Strip precision, e.g. NUMERIC(19,4) -> NUMERIC
  const baseType = bqType.split("(")[0];
  return PARTITIONABLE_BQ_TYPES.has(baseType);
}

// ---------------------------------------------------------------------------
// BigQuery Emitter
// ---------------------------------------------------------------------------

export class BigQueryEmitter implements Emitter {
  readonly name = "bigquery";
  readonly version = "1.0.0";
  readonly targetFormat = "bigquery-ddl";

  emit(model: SuperSchemaModel, policies: MappingPolicy[]): EmitterResult {
    const warnings: EmitterWarning[] = [];

    // Convert MappingPolicy[] to ScopedMappingPolicy[] with proper defaults
    const scopedPolicies: ScopedMappingPolicy[] = policies.map(p => ({
      ...p,
      isLossy: (p as ScopedMappingPolicy).isLossy ?? false,
      isOverride: (p as ScopedMappingPolicy).isOverride ?? false,
    }));

    const tableName = toSnakeCase(model.entity.name);
    const datasetPrefix = model.entity.domain
      ? `${toSnakeCase(model.entity.domain)}.`
      : "";

    // Sort fields by sortOrder for deterministic output
    const sortedFields = [...model.fields].sort(
      (a, b) => a.sortOrder - b.sortOrder
    );

    // Build column definitions
    const columnDefs: string[] = [];

    for (const field of sortedFields) {
      const { columnDef, fieldWarnings } = this.buildColumnDef(
        field,
        scopedPolicies,
        model.entity.id
      );
      columnDefs.push(columnDef);
      warnings.push(...fieldWarnings);
    }

    // Build PARTITION BY clause
    const partitionField = sortedFields.find(
      (f) => f.decorators.operationalHints?.partition
    );
    let partitionClause = "";
    if (partitionField) {
      const partitionColName = quoteIfReserved(partitionField.name);
      const bqType = this.resolveBqType(partitionField, scopedPolicies, model.entity.id);
      if (bqType && isPartitionableType(bqType)) {
        partitionClause = `\nPARTITION BY ${partitionColName}`;
      } else {
        warnings.push({
          message: `Field "${partitionField.name}" has partition hint but its BigQuery type "${bqType}" is not partitionable (must be DATE, TIMESTAMP, or DATETIME)`,
          fieldName: partitionField.name,
        });
      }
    }

    // Build CLUSTER BY clause
    const clusterFields = sortedFields.filter(
      (f) => f.decorators.operationalHints?.cluster
    );
    let clusterClause = "";
    if (clusterFields.length > 0) {
      const clusterCols = clusterFields
        .map((f) => quoteIfReserved(f.name))
        .join(", ");
      clusterClause = `\nCLUSTER BY ${clusterCols}`;
    }

    // Assemble DDL
    const columnsBlock =
      columnDefs.length > 0
        ? `\n${columnDefs.join(",\n")}\n`
        : "\n";

    const ddl = `CREATE TABLE ${datasetPrefix}${tableName} (${columnsBlock})${partitionClause}${clusterClause};\n`;

    return {
      output: ddl,
      warnings,
      targetFormat: this.targetFormat,
    };
  }

  validate(output: string): ValidationResult {
    return validateBigQueryDDL(output);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private resolveBqType(
    field: SuperSchemaField,
    policies: ScopedMappingPolicy[],
    entityId: string
  ): string | null {
    const result = resolveMappingWithPrecision(
      field.type,
      "bigquery",
      policies,
      field.precision,
      field.scale,
      entityId
    );
    if (!result.success) return null;
    return result.result.mappedType;
  }

  private buildColumnDef(
    field: SuperSchemaField,
    policies: ScopedMappingPolicy[],
    entityId: string
  ): { columnDef: string; fieldWarnings: EmitterWarning[] } {
    const fieldWarnings: EmitterWarning[] = [];
    const colName = quoteIfReserved(field.name);

    // Resolve BigQuery type
    const mappingResult = resolveMappingWithPrecision(
      field.type,
      "bigquery",
      policies,
      field.precision,
      field.scale,
      entityId
    );

    let bqType: string;
    let isLossy = false;
    let lossDescription: string | undefined;

    if (mappingResult.success) {
      bqType = mappingResult.result.mappedType;
      isLossy = mappingResult.result.isLossy;
      lossDescription = mappingResult.result.lossDescription;
    } else {
      bqType = "STRING"; // fallback
      fieldWarnings.push({
        message: `No mapping found for type "${field.type}" — defaulting to STRING`,
        fieldName: field.name,
      });
    }

    // Handle complex types
    if (field.type === "array" && field.complexType?.arrayElementType) {
      const elementMapping = resolveMappingWithPrecision(
        field.complexType.arrayElementType,
        "bigquery",
        policies,
        field.complexType.arrayElementPrecision,
        field.complexType.arrayElementScale,
        entityId
      );
      const elementType = elementMapping.success
        ? elementMapping.result.mappedType
        : "STRING";
      bqType = `ARRAY<${elementType}>`;
    } else if (field.type === "array") {
      bqType = "ARRAY<STRING>";
    }

    // Map type → STRUCT with lossy warning
    if (field.type === "map") {
      bqType = "STRUCT";
    }

    // NOT NULL constraint
    const nullableClause = field.nullable ? "" : " NOT NULL";

    // Build OPTIONS
    const options = this.buildOptions(field);
    const optionsClause = options ? ` ${options}` : "";

    // Lossy warning comment
    let lossyComment = "";
    if (isLossy && lossDescription) {
      lossyComment = `  -- WARNING: ${field.type} mapped to ${bqType} (lossy — ${lossDescription})\n`;
      fieldWarnings.push({
        message: `${field.type} mapped to ${bqType} (lossy — ${lossDescription})`,
        fieldName: field.name,
      });
    }

    const columnDef = `${lossyComment}  ${colName} ${bqType}${nullableClause}${optionsClause}`;

    return { columnDef, fieldWarnings };
  }

  private buildOptions(field: SuperSchemaField): string | null {
    const parts: string[] = [];

    // Description from field.description or semantics decorator
    const description =
      field.decorators.semantics?.description ?? field.description;
    if (description) {
      parts.push(`description='${escapeSqlString(description)}'`);
    }

    // Classification labels
    const classification =
      field.decorators.classification?.level ?? field.classification;
    if (classification) {
      parts.push(`labels=['classification:${classification}']`);
    }

    if (parts.length === 0) return null;
    return `OPTIONS(${parts.join(", ")})`;
  }
}
