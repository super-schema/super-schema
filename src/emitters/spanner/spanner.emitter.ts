/**
 * Cloud Spanner DDL Emitter — generates CREATE TABLE DDL from SuperSchemaModel.
 *
 * Implements the Emitter interface. Uses resolveMapping() from the
 * type mapping engine to resolve logical types to Spanner types.
 *
 * Key differences from BigQuery:
 * - PRIMARY KEY declared at table level (not per-column)
 * - STRING(MAX)/BYTES(MAX) instead of bare STRING/BYTES
 * - INTERLEAVE IN PARENT for entity inheritance
 * - No PARTITION BY / CLUSTER BY / OPTIONS()
 * - NUMERIC has fixed precision (38,9)
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
import { validateSpannerDDL } from "./spanner.validator";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toSnakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[\s\-]+/g, "_")
    .replace(/[^a-zA-Z0-9_]/g, "")
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Spanner Emitter
// ---------------------------------------------------------------------------

export class SpannerEmitter implements Emitter {
  readonly name = "spanner";
  readonly version = "1.0.0";
  readonly targetFormat = "spanner-ddl";

  emit(model: SuperSchemaModel, policies: MappingPolicy[]): EmitterResult {
    const warnings: EmitterWarning[] = [];

    const scopedPolicies: ScopedMappingPolicy[] = policies.map((p) => ({
      ...p,
      isLossy: (p as ScopedMappingPolicy).isLossy ?? false,
      isOverride: (p as ScopedMappingPolicy).isOverride ?? false,
    }));

    const tableName = toSnakeCase(model.entity.name);

    // Sort fields by sortOrder, key fields first for Spanner convention
    const sortedFields = [...model.fields].sort((a, b) => {
      if (a.isKey && !b.isKey) return -1;
      if (!a.isKey && b.isKey) return 1;
      return a.sortOrder - b.sortOrder;
    });

    // Build column definitions
    const columnDefs: string[] = [];
    const keyColumns: string[] = [];

    for (const field of sortedFields) {
      const { columnDef, fieldWarnings } = this.buildColumnDef(
        field,
        scopedPolicies,
        model.entity.id
      );
      columnDefs.push(columnDef);
      warnings.push(...fieldWarnings);

      if (field.isKey) {
        keyColumns.push(toSnakeCase(field.name));
      }
    }

    // PRIMARY KEY clause (mandatory in Spanner)
    const primaryKeyClause =
      keyColumns.length > 0
        ? `) PRIMARY KEY (${keyColumns.join(", ")})`
        : `)`;

    // INTERLEAVE IN PARENT for inheritance
    let interleaveClause = "";
    if (model.entity.parentEntityName) {
      const parentTable = toSnakeCase(model.entity.parentEntityName);
      interleaveClause = `,\n  INTERLEAVE IN PARENT ${parentTable} ON DELETE CASCADE`;
    }

    // Retention policy comment
    let retentionComment = "";
    const rp = model.entity.metadata?.retentionPolicy;
    if (rp) {
      if (rp.strategy === "age-based" && rp.period && rp.periodUnit) {
        const ref = rp.referenceField ?? "created_at";
        retentionComment = `-- RETENTION: ${rp.action} rows where ${ref} > ${rp.period} ${rp.periodUnit}\n`;
      } else if (rp.strategy === "condition-based" && rp.condition) {
        retentionComment = `-- RETENTION: ${rp.action} rows where ${rp.condition}\n`;
      } else if (rp.strategy === "rolling-window" && rp.period && rp.periodUnit) {
        const ref = rp.referenceField ?? "created_at";
        retentionComment = `-- RETENTION: keep ${rp.period} ${rp.periodUnit} rolling window on ${ref}\n`;
      } else if (rp.strategy === "indefinite") {
        retentionComment = `-- RETENTION: indefinite (${rp.description ?? "no automatic purge"})\n`;
      }
    }

    // Assemble DDL
    const columnsBlock =
      columnDefs.length > 0 ? `\n${columnDefs.join(",\n")}\n` : "\n";

    const ddl = `${retentionComment}CREATE TABLE ${tableName} (${columnsBlock}${primaryKeyClause}${interleaveClause};\n`;

    return {
      output: ddl,
      warnings,
      targetFormat: this.targetFormat,
    };
  }

  validate(output: string): ValidationResult {
    return validateSpannerDDL(output);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private buildColumnDef(
    field: SuperSchemaField,
    policies: ScopedMappingPolicy[],
    entityId: string
  ): { columnDef: string; fieldWarnings: EmitterWarning[] } {
    const fieldWarnings: EmitterWarning[] = [];
    const colName = toSnakeCase(field.name);

    // Resolve Spanner type
    const mappingResult = resolveMappingWithPrecision(
      field.type,
      "spanner",
      policies,
      field.precision,
      field.scale,
      entityId
    );

    let spannerType: string;
    let isLossy = false;
    let lossDescription: string | undefined;

    if (mappingResult.success) {
      spannerType = mappingResult.result.mappedType;
      isLossy = mappingResult.result.isLossy;
      lossDescription = mappingResult.result.lossDescription;
    } else {
      spannerType = "STRING(MAX)";
      fieldWarnings.push({
        message: `No mapping found for type "${field.type}" — defaulting to STRING(MAX)`,
        fieldName: field.name,
      });
    }

    // Handle STRING with maxLength decorator
    if (spannerType === "STRING(MAX)" && field.decorators.typespec?.validation?.maxLength) {
      spannerType = `STRING(${field.decorators.typespec.validation.maxLength})`;
    }

    // Handle complex types
    if (field.type === "array" && field.complexType?.arrayElementType) {
      const elementMapping = resolveMappingWithPrecision(
        field.complexType.arrayElementType,
        "spanner",
        policies,
        field.complexType.arrayElementPrecision,
        field.complexType.arrayElementScale,
        entityId
      );
      const elementType = elementMapping.success
        ? elementMapping.result.mappedType
        : "STRING(MAX)";
      spannerType = `ARRAY<${elementType}>`;
    } else if (field.type === "array") {
      spannerType = "ARRAY<STRING(MAX)>";
    }

    // NOT NULL constraint
    const nullableClause = field.nullable ? "" : " NOT NULL";

    // Lossy warning comment
    let lossyComment = "";
    if (isLossy && lossDescription) {
      lossyComment = `  -- WARNING: ${field.type} mapped to ${spannerType} (lossy — ${lossDescription})\n`;
      fieldWarnings.push({
        message: `${field.type} mapped to ${spannerType} (lossy — ${lossDescription})`,
        fieldName: field.name,
      });
    }

    // Description as comment
    let descComment = "";
    const description = field.decorators.semantics?.description ?? field.description;
    if (description) {
      descComment = `  -- ${description}\n`;
    }

    const columnDef = `${descComment}${lossyComment}  ${colName} ${spannerType}${nullableClause}`;

    return { columnDef, fieldWarnings };
  }
}
