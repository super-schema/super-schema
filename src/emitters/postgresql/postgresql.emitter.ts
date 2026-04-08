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
import { getFieldOverrideCommentFromMapping } from "@/lib/schema-targets/field-type-overrides";
import { validatePostgreSqlDDL } from "./postgresql.validator";

function toSnakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[\s\-]+/g, "_")
    .replace(/[^a-zA-Z0-9_]/g, "")
    .toLowerCase();
}

export class PostgreSqlEmitter implements Emitter {
  readonly name = "postgresql";
  readonly version = "1.0.0";
  readonly targetFormat = "postgresql-ddl";

  emit(model: SuperSchemaModel, policies: MappingPolicy[]): EmitterResult {
    const warnings: EmitterWarning[] = [];
    const scopedPolicies: ScopedMappingPolicy[] = policies.map((p) => ({
      ...p,
      isLossy: (p as ScopedMappingPolicy).isLossy ?? false,
      isOverride: (p as ScopedMappingPolicy).isOverride ?? false,
      fieldId: (p as ScopedMappingPolicy).fieldId,
      fieldName: (p as ScopedMappingPolicy).fieldName,
    }));

    const tableName = toSnakeCase(model.entity.name);
    const sortedFields = [...model.fields].sort((a, b) => {
      if (a.isKey && !b.isKey) return -1;
      if (!a.isKey && b.isKey) return 1;
      return a.sortOrder - b.sortOrder;
    });

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

    const primaryKeyClause =
      keyColumns.length > 0 ? `,\n  PRIMARY KEY (${keyColumns.join(", ")})` : "";

    const ddl = `CREATE TABLE ${tableName} (\n${columnDefs.join(",\n")}${primaryKeyClause}\n);\n`;

    return {
      output: ddl,
      warnings,
      targetFormat: this.targetFormat,
    };
  }

  validate(output: string): ValidationResult {
    return validatePostgreSqlDDL(output);
  }

  private buildColumnDef(
    field: SuperSchemaField,
    policies: ScopedMappingPolicy[],
    entityId: string
  ): { columnDef: string; fieldWarnings: EmitterWarning[] } {
    const fieldWarnings: EmitterWarning[] = [];
    const colName = toSnakeCase(field.name);
    const mappingResult = resolveMappingWithPrecision(
      field.type,
      "postgresql",
      policies,
      field.precision,
      field.scale,
      entityId,
      field.id
    );

    let postgresType = "text";
    let lossyComment = "";
    let overrideComment = "";
    const hasFieldOverride =
      mappingResult.success && mappingResult.result.overrideSource === "field";

    if (mappingResult.success) {
      postgresType = mappingResult.result.mappedType;
      const overrideNote = getFieldOverrideCommentFromMapping(
        field.type,
        mappingResult.result
      );
      if (overrideNote) {
        overrideComment = `  -- ${overrideNote}\n`;
      }

      if (mappingResult.result.isLossy && mappingResult.result.lossDescription) {
        lossyComment = `  -- WARNING: ${mappingResult.result.lossDescription}\n`;
        fieldWarnings.push({
          message: `${field.type} mapped to ${postgresType} (lossy — ${mappingResult.result.lossDescription})`,
          fieldName: field.name,
        });
      }
    } else {
      fieldWarnings.push({
        message: `No mapping found for type "${field.type}" — defaulting to text`,
        fieldName: field.name,
      });
    }

    if (!hasFieldOverride && field.type === "array" && field.complexType?.arrayElementType) {
      const elementMapping = resolveMappingWithPrecision(
        field.complexType.arrayElementType,
        "postgresql",
        policies,
        field.complexType.arrayElementPrecision,
        field.complexType.arrayElementScale,
        entityId
      );
      postgresType = elementMapping.success
        ? `${elementMapping.result.mappedType}[]`
        : "text[]";
    } else if (!hasFieldOverride && field.type === "array") {
      postgresType = "text[]";
    }

    const description = field.decorators.semantics?.description ?? field.description;
    const descComment = description ? `  -- ${description}\n` : "";
    const nullableClause = field.nullable ? "" : " NOT NULL";

    return {
      columnDef: `${descComment}${overrideComment}${lossyComment}  ${colName} ${postgresType}${nullableClause}`,
      fieldWarnings,
    };
  }
}
