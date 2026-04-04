/**
 * TypeSpec source code generator.
 *
 * Transforms a SuperSchemaModel IR into a valid TypeSpec (.tsp) source string.
 * Pure function — no side effects, no I/O.
 */

import type {
  SuperSchemaModel,
  SuperSchemaField,
  DecoratorSet,
  LogicalType,
} from "@/types/super-schema-model";
import { getTypeInfo } from "@/lib/data-types";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate TypeSpec source from a SuperSchemaModel.
 * Returns a valid TypeSpec .tsp string.
 */
export function generateTypeSpec(model: SuperSchemaModel): string {
  const lines: string[] = [];

  // Emit enum definitions first (for enum-type fields)
  const enumFields = model.fields.filter((f) => f.type === "enum");
  for (const field of enumFields) {
    lines.push(...generateEnumDefinition(field, model.entity.name));
    lines.push("");
  }

  // Emit model-level decorators
  lines.push(...generateModelDecorators(model));

  // Emit model definition
  lines.push(`model ${sanitizeIdentifier(model.entity.name)} {`);

  // Emit fields
  for (const field of model.fields) {
    const fieldLines = generateFieldDefinition(field, model.entity.name);
    for (const fl of fieldLines) {
      lines.push(`  ${fl}`);
    }
  }

  lines.push("}");

  return lines.join("\n") + "\n";
}

/**
 * Generate TypeSpec source directly from Prisma-shaped entity + fields.
 * Convenience wrapper that calls compileEntity() then generateTypeSpec().
 */
export { generateTypeSpec as generateTypeSpecFromModel };

// ---------------------------------------------------------------------------
// Source map for error mapping
// ---------------------------------------------------------------------------

export interface SourceMapEntry {
  fieldName: string;
  startLine: number;
  endLine: number;
}

/**
 * Generate TypeSpec source along with a source map.
 * Used for mapping compilation errors back to field names.
 */
export function generateTypeSpecWithSourceMap(
  model: SuperSchemaModel
): { source: string; sourceMap: SourceMapEntry[] } {
  const lines: string[] = [];
  const sourceMap: SourceMapEntry[] = [];

  // Emit enum definitions first
  const enumFields = model.fields.filter((f) => f.type === "enum");
  for (const field of enumFields) {
    const startLine = lines.length + 1;
    lines.push(...generateEnumDefinition(field, model.entity.name));
    lines.push("");
    sourceMap.push({
      fieldName: field.name,
      startLine,
      endLine: lines.length,
    });
  }

  // Emit model-level decorators
  lines.push(...generateModelDecorators(model));

  // Emit model definition
  lines.push(`model ${sanitizeIdentifier(model.entity.name)} {`);

  // Emit fields with source map tracking
  for (const field of model.fields) {
    const startLine = lines.length + 1;
    const fieldLines = generateFieldDefinition(field, model.entity.name);
    for (const fl of fieldLines) {
      lines.push(`  ${fl}`);
    }
    sourceMap.push({
      fieldName: field.name,
      startLine,
      endLine: lines.length,
    });
  }

  lines.push("}");

  return {
    source: lines.join("\n") + "\n",
    sourceMap,
  };
}

// ---------------------------------------------------------------------------
// Model-level decorators
// ---------------------------------------------------------------------------

function generateModelDecorators(model: SuperSchemaModel): string[] {
  const lines: string[] = [];

  if (model.entity.description) {
    lines.push(`@doc("${escapeString(model.entity.description)}")`);
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Enum definition
// ---------------------------------------------------------------------------

function generateEnumDefinition(
  field: SuperSchemaField,
  entityName: string
): string[] {
  const enumName = `${sanitizeIdentifier(entityName)}_${sanitizeIdentifier(field.name)}`;
  const lines: string[] = [];

  // Extract enum values from decorators or aliases
  const values = extractEnumValues(field);

  if (field.description) {
    lines.push(`@doc("${escapeString(field.description)}")`);
  }
  lines.push(`enum ${enumName} {`);

  for (const val of values) {
    lines.push(`  ${sanitizeIdentifier(val)},`);
  }

  // If no values found, add a placeholder
  if (values.length === 0) {
    lines.push(`  // TODO: Define enum values`);
  }

  lines.push("}");
  return lines;
}

function extractEnumValues(field: SuperSchemaField): string[] {
  // Check typespec validation for enum hints
  const validation = field.decorators.typespec?.validation;
  if (validation && "pattern" in validation && validation.pattern) {
    // If pattern looks like "val1|val2|val3", extract as enum values
    const pattern = validation.pattern;
    if (/^[\w|]+$/.test(pattern)) {
      return pattern.split("|").filter(Boolean);
    }
  }

  // Use aliases as enum values if present
  if (field.aliases.length > 0) {
    return field.aliases;
  }

  return [];
}

// ---------------------------------------------------------------------------
// Field definition
// ---------------------------------------------------------------------------

function generateFieldDefinition(
  field: SuperSchemaField,
  entityName: string
): string[] {
  const lines: string[] = [];

  // Field-level decorators
  lines.push(...generateFieldDecorators(field));

  // Build the type expression
  const typeExpr = resolveTypeSpecType(field, entityName);

  // Determine optionality
  const optional = field.nullable ? "?" : "";

  lines.push(`${sanitizeIdentifier(field.name)}${optional}: ${typeExpr};`);

  return lines;
}

// ---------------------------------------------------------------------------
// Field decorators
// ---------------------------------------------------------------------------

function generateFieldDecorators(field: SuperSchemaField): string[] {
  const decorators: string[] = [];

  // @key
  if (field.isKey) {
    decorators.push("@key");
  }

  // @doc
  if (field.description) {
    decorators.push(`@doc("${escapeString(field.description)}")`);
  }

  // @secret (from typespec identity)
  if (field.decorators.typespec?.identity?.secret) {
    decorators.push("@secret");
  }

  // @format (from typespec identity)
  if (field.decorators.typespec?.identity?.format) {
    decorators.push(`@format("${escapeString(field.decorators.typespec.identity.format)}")`);
  }

  // Validation decorators
  const validation = field.decorators.typespec?.validation;
  if (validation) {
    if (validation.minLength != null) {
      decorators.push(`@minLength(${validation.minLength})`);
    }
    if (validation.maxLength != null) {
      decorators.push(`@maxLength(${validation.maxLength})`);
    }
    if (validation.minValue != null) {
      decorators.push(`@minValue(${validation.minValue})`);
    }
    if (validation.maxValue != null) {
      decorators.push(`@maxValue(${validation.maxValue})`);
    }
    if (validation.minValueExclusive != null) {
      decorators.push(`@minValueExclusive(${validation.minValueExclusive})`);
    }
    if (validation.maxValueExclusive != null) {
      decorators.push(`@maxValueExclusive(${validation.maxValueExclusive})`);
    }
    if (validation.pattern != null && field.type !== "enum") {
      decorators.push(`@pattern("${escapeString(validation.pattern)}")`);
    }
    if (validation.minItems != null) {
      decorators.push(`@minItems(${validation.minItems})`);
    }
    if (validation.maxItems != null) {
      decorators.push(`@maxItems(${validation.maxItems})`);
    }
  }

  // Wire format decorators
  const wireFormat = field.decorators.typespec?.wireFormat;
  if (wireFormat) {
    if (wireFormat.encode) {
      if (wireFormat.encodeSubType) {
        decorators.push(
          `@encode("${escapeString(wireFormat.encode)}", "${escapeString(wireFormat.encodeSubType)}")`
        );
      } else {
        decorators.push(`@encode("${escapeString(wireFormat.encode)}")`);
      }
    }
  }

  // Visibility decorators
  const visibility = field.decorators.typespec?.visibility;
  if (visibility?.phases && visibility.phases.length > 0) {
    const phaseList = visibility.phases
      .map((p) => `Lifecycle.${p}`)
      .join(", ");
    decorators.push(`@visibility(${phaseList})`);
  }

  // Documentation decorators
  const docs = field.decorators.typespec?.documentation;
  if (docs) {
    if (docs.summary) {
      decorators.push(`@summary("${escapeString(docs.summary)}")`);
    }
    if (docs.deprecated) {
      decorators.push(`#deprecated "${escapeString(docs.deprecated)}"`);
    }
  }

  // Versioning decorators
  const versioning = field.decorators.typespec?.versioning;
  if (versioning) {
    if (versioning.added) {
      decorators.push(`@added(Versions.${sanitizeIdentifier(versioning.added)})`);
    }
    if (versioning.removed) {
      decorators.push(`@removed(Versions.${sanitizeIdentifier(versioning.removed)})`);
    }
  }

  // Classification decorator (custom annotation via @tag)
  if (field.classification) {
    decorators.push(`@tag("classification:${escapeString(field.classification)}")`);
  }

  return decorators;
}

// ---------------------------------------------------------------------------
// Type resolution — LogicalType -> TypeSpec type expression
// ---------------------------------------------------------------------------

function resolveTypeSpecType(
  field: SuperSchemaField,
  entityName: string
): string {
  const typeInfo = getTypeInfo(field.type);
  const typespecScalar = typeInfo?.typespecScalar ?? field.type;

  switch (field.type as LogicalType) {
    case "enum": {
      return `${sanitizeIdentifier(entityName)}_${sanitizeIdentifier(field.name)}`;
    }
    case "array": {
      const elementType = field.complexType?.arrayElementType ?? "string";
      const elementTypeInfo = getTypeInfo(elementType);
      const elementTypeSpec = elementTypeInfo?.typespecScalar ?? elementType;
      return `${elementTypeSpec}[]`;
    }
    case "map": {
      const keyType = field.complexType?.mapKeyType ?? "string";
      const valueType = field.complexType?.mapValueType ?? "string";
      const keyTypeInfo = getTypeInfo(keyType);
      const valueTypeInfo = getTypeInfo(valueType);
      const keyTypeSpec = keyTypeInfo?.typespecScalar ?? keyType;
      const valueTypeSpec = valueTypeInfo?.typespecScalar ?? valueType;
      if (keyTypeSpec !== "string") {
        return `Record<${keyTypeSpec}, ${valueTypeSpec}>`;
      }
      return `Record<${valueTypeSpec}>`;
    }
    case "object": {
      // Inline model or reference to a nested model
      return `Record<unknown>`;
    }
    case "reference": {
      const refName = field.complexType?.referencedEntityName;
      if (refName) {
        return sanitizeIdentifier(refName);
      }
      return "string";
    }
    case "decimal":
    case "decimal128": {
      return typespecScalar;
    }
    default: {
      return typespecScalar;
    }
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

const TYPESPEC_RESERVED_WORDS = new Set([
  "model", "enum", "interface", "namespace", "op", "union", "alias",
  "scalar", "dec", "fn", "extern", "is", "extends", "using", "import",
]);

function sanitizeIdentifier(name: string): string {
  // Replace non-alphanumeric characters with underscores
  let safe = name.replace(/[^a-zA-Z0-9_]/g, "_");
  // Ensure it doesn't start with a digit
  if (/^[0-9]/.test(safe)) {
    safe = `_${safe}`;
  }
  // Escape TypeSpec reserved words
  if (TYPESPEC_RESERVED_WORDS.has(safe)) {
    safe = `_${safe}`;
  }
  return safe;
}

function escapeString(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}
