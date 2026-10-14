/**
 * TypeSpec source code generator.
 *
 * Transforms a SuperSchemaModel IR into a valid TypeSpec (.tsp) source string.
 * Supports: models (with inheritance/spread), enums, custom scalars, unions,
 * aliases, namespaces, operations, interfaces.
 *
 * Pure function — no side effects, no I/O.
 */

import type {
  SuperSchemaModel,
  SuperSchemaField,
  DecoratorSet,
  LogicalType,
  SuperSchemaSharedEnum,
  SuperSchemaCustomScalar,
  SuperSchemaUnionType,
  SuperSchemaAlias,
  SuperSchemaInterface,
  SuperSchemaOperation,
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

  // Emit namespace if present
  const ns = model.namespace || model.entity.domain;
  const useNamespace = model.namespace !== undefined;

  if (useNamespace && ns) {
    lines.push(`namespace ${sanitizeNamespace(ns)};`);
    lines.push("");
  }

  // Emit custom scalars
  if (model.customScalars && model.customScalars.length > 0) {
    for (const scalar of model.customScalars) {
      lines.push(...generateScalarDefinition(scalar));
      lines.push("");
    }
  }

  // Emit shared enums
  if (model.sharedEnums && model.sharedEnums.length > 0) {
    for (const sharedEnum of model.sharedEnums) {
      lines.push(...generateSharedEnumDefinition(sharedEnum));
      lines.push("");
    }
  }

  // Emit unions
  if (model.unionTypes && model.unionTypes.length > 0) {
    for (const union of model.unionTypes) {
      lines.push(...generateUnionDefinition(union));
      lines.push("");
    }
  }

  // Emit aliases
  if (model.aliases && model.aliases.length > 0) {
    for (const alias of model.aliases) {
      lines.push(`alias ${sanitizeIdentifier(alias.name)} = ${alias.type};`);
      lines.push("");
    }
  }

  // Emit inline enum definitions (for enum-type fields not in shared enums)
  const sharedEnumNames = new Set(model.sharedEnums?.map((e) => e.name) ?? []);
  const enumFields = model.fields.filter(needsInlineEnum);
  for (const field of enumFields) {
    // Only emit inline enum if it's not a shared enum reference
    const enumName = `${sanitizeIdentifier(model.entity.name)}_${sanitizeIdentifier(field.name)}`;
    if (!sharedEnumNames.has(enumName)) {
      lines.push(...generateInlineEnumDefinition(field, model.entity.name));
      lines.push("");
    }
  }

  // Emit model-level decorators
  lines.push(...generateModelDecorators(model));

  // Emit model definition with optional extends
  const modelName = sanitizeIdentifier(model.entity.name);
  const extendsClause = model.entity.parentEntityName
    ? ` extends ${sanitizeIdentifier(model.entity.parentEntityName)}`
    : "";
  lines.push(`model ${modelName}${extendsClause} {`);

  // Emit spread references
  if (model.entity.spreadFrom && model.entity.spreadFrom.length > 0) {
    for (const spreadName of model.entity.spreadFrom) {
      lines.push(`  ...${sanitizeIdentifier(spreadName)};`);
    }
  }

  // Emit fields
  for (const field of model.fields) {
    const fieldLines = generateFieldDefinition(field, model.entity.name);
    for (const fl of fieldLines) {
      lines.push(`  ${fl}`);
    }
  }

  lines.push("}");

  // Emit interfaces
  if (model.interfaces && model.interfaces.length > 0) {
    for (const iface of model.interfaces) {
      lines.push("");
      lines.push(...generateInterfaceDefinition(iface));
    }
  }

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

  // Namespace
  const ns = model.namespace || model.entity.domain;
  const useNamespace = model.namespace !== undefined;
  if (useNamespace && ns) {
    lines.push(`namespace ${sanitizeNamespace(ns)};`);
    lines.push("");
  }

  // Custom scalars
  if (model.customScalars && model.customScalars.length > 0) {
    for (const scalar of model.customScalars) {
      lines.push(...generateScalarDefinition(scalar));
      lines.push("");
    }
  }

  // Shared enums
  if (model.sharedEnums && model.sharedEnums.length > 0) {
    for (const sharedEnum of model.sharedEnums) {
      lines.push(...generateSharedEnumDefinition(sharedEnum));
      lines.push("");
    }
  }

  // Unions
  if (model.unionTypes && model.unionTypes.length > 0) {
    for (const union of model.unionTypes) {
      lines.push(...generateUnionDefinition(union));
      lines.push("");
    }
  }

  // Aliases
  if (model.aliases && model.aliases.length > 0) {
    for (const alias of model.aliases) {
      lines.push(`alias ${sanitizeIdentifier(alias.name)} = ${alias.type};`);
      lines.push("");
    }
  }

  // Emit inline enum definitions first
  const sharedEnumNames = new Set(model.sharedEnums?.map((e) => e.name) ?? []);
  const enumFields = model.fields.filter(needsInlineEnum);
  for (const field of enumFields) {
    const enumName = `${sanitizeIdentifier(model.entity.name)}_${sanitizeIdentifier(field.name)}`;
    if (!sharedEnumNames.has(enumName)) {
      const startLine = lines.length + 1;
      lines.push(...generateInlineEnumDefinition(field, model.entity.name));
      lines.push("");
      sourceMap.push({
        fieldName: field.name,
        startLine,
        endLine: lines.length,
      });
    }
  }

  // Emit model-level decorators
  lines.push(...generateModelDecorators(model));

  // Emit model definition
  const modelName = sanitizeIdentifier(model.entity.name);
  const extendsClause = model.entity.parentEntityName
    ? ` extends ${sanitizeIdentifier(model.entity.parentEntityName)}`
    : "";
  lines.push(`model ${modelName}${extendsClause} {`);

  // Spread
  if (model.entity.spreadFrom && model.entity.spreadFrom.length > 0) {
    for (const spreadName of model.entity.spreadFrom) {
      lines.push(`  ...${sanitizeIdentifier(spreadName)};`);
    }
  }

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

  if (model.entity.metadata?.isError) {
    lines.push("@error");
  }

  if (model.entity.metadata?.friendlyName) {
    lines.push(`@friendlyName("${escapeString(model.entity.metadata.friendlyName)}")`);
  }

  if (model.entity.metadata?.tags && model.entity.metadata.tags.length > 0) {
    for (const tag of model.entity.metadata.tags) {
      lines.push(`@tag("${escapeString(tag)}")`);
    }
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Shared enum definition
// ---------------------------------------------------------------------------

function generateSharedEnumDefinition(sharedEnum: SuperSchemaSharedEnum): string[] {
  const lines: string[] = [];

  if (sharedEnum.description) {
    lines.push(`@doc("${escapeString(sharedEnum.description)}")`);
  }
  lines.push(`enum ${sanitizeIdentifier(sharedEnum.name)} {`);

  for (const val of sharedEnum.values) {
    lines.push(`  ${sanitizeIdentifier(val)},`);
  }

  if (sharedEnum.values.length === 0) {
    lines.push(`  // TODO: Define enum values`);
  }

  lines.push("}");
  return lines;
}

// ---------------------------------------------------------------------------
// Inline enum definition (field-scoped)
// ---------------------------------------------------------------------------

function inlineEnumName(entityName: string, field: SuperSchemaField): string {
  return `${sanitizeIdentifier(entityName)}_${sanitizeIdentifier(field.name)}`;
}

/**
 * Fields that get a field-scoped enum: every `enum` field, plus arrays / maps
 * whose element / value is an enum with known symbols.
 */
function needsInlineEnum(field: SuperSchemaField): boolean {
  if (field.type === "enum") return true;
  const member =
    field.type === "array"
      ? field.complexType?.arrayElementType
      : field.type === "map"
        ? field.complexType?.mapValueType
        : undefined;
  return member === "enum" && extractEnumValues(field).length > 0;
}

function generateInlineEnumDefinition(
  field: SuperSchemaField,
  entityName: string
): string[] {
  const enumName = inlineEnumName(entityName, field);
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
  // Array element / map value enums carry their symbols in complexType.
  if (field.type !== "enum") {
    return field.complexType?.enumValues ?? [];
  }

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
// Custom scalar definition
// ---------------------------------------------------------------------------

function generateScalarDefinition(scalar: SuperSchemaCustomScalar): string[] {
  const lines: string[] = [];

  if (scalar.description) {
    lines.push(`@doc("${escapeString(scalar.description)}")`);
  }

  lines.push(`scalar ${sanitizeIdentifier(scalar.name)} extends ${scalar.baseType};`);
  return lines;
}

// ---------------------------------------------------------------------------
// Union definition
// ---------------------------------------------------------------------------

function generateUnionDefinition(union: SuperSchemaUnionType): string[] {
  const lines: string[] = [];

  if (union.description) {
    lines.push(`@doc("${escapeString(union.description)}")`);
  }

  if (union.memberTypes.length <= 3) {
    // Inline form for short unions
    lines.push(`union ${sanitizeIdentifier(union.name)} = ${union.memberTypes.join(" | ")};`);
  } else {
    // Block form for longer unions
    lines.push(`union ${sanitizeIdentifier(union.name)} {`);
    for (const member of union.memberTypes) {
      lines.push(`  ${member},`);
    }
    lines.push("}");
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Interface definition
// ---------------------------------------------------------------------------

function generateInterfaceDefinition(iface: SuperSchemaInterface): string[] {
  const lines: string[] = [];

  if (iface.description) {
    lines.push(`@doc("${escapeString(iface.description)}")`);
  }

  lines.push(`interface ${sanitizeIdentifier(iface.name)} {`);

  for (const op of iface.operations) {
    lines.push(...generateOperationDefinition(op).map((l) => `  ${l}`));
  }

  lines.push("}");
  return lines;
}

// ---------------------------------------------------------------------------
// Operation definition
// ---------------------------------------------------------------------------

function generateOperationDefinition(op: SuperSchemaOperation): string[] {
  const lines: string[] = [];

  if (op.description) {
    lines.push(`@doc("${escapeString(op.description)}")`);
  }

  if (op.httpPath) {
    lines.push(`@route("${escapeString(op.httpPath)}")`);
  }

  if (op.httpMethod) {
    lines.push(`@${op.httpMethod.toLowerCase()}`);
  }

  // Build parameter list
  const paramParts: string[] = [];
  for (const param of op.parameters) {
    const locationDecorator = param.location !== "body" ? `@${param.location} ` : "";
    const optional = param.required ? "" : "?";
    paramParts.push(`${locationDecorator}${param.name}${optional}: ${param.type}`);
  }

  const paramStr = paramParts.join(", ");
  const returnType = op.responses.length > 0
    ? op.responses[0].type || "void"
    : "void";

  lines.push(`op ${sanitizeIdentifier(op.name)}(${paramStr}): ${returnType};`);
  return lines;
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

  // Default value
  const defaultClause = field.decorators.typespec?.identity?.defaultValue !== undefined
    ? ` = ${JSON.stringify(field.decorators.typespec.identity.defaultValue)}`
    : "";

  lines.push(`${sanitizeIdentifier(field.name)}${optional}: ${typeExpr}${defaultClause};`);

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

  // @discriminator
  if (field.decorators.typespec?.identity?.discriminator) {
    decorators.push(`@discriminator("${field.name}")`);
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
    if (wireFormat.encodedNames) {
      for (const [mime, name] of Object.entries(wireFormat.encodedNames)) {
        decorators.push(`@encodedName("${escapeString(mime)}", "${escapeString(name)}")`);
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
    if (docs.example != null) {
      decorators.push(`@example(${docs.example})`);
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

  // Classification decorator (custom annotation via @tag). NOTE: real TypeSpec's
  // `@tag` only accepts Namespace | Interface | Operation — applying it to a
  // field is invalid TypeSpec and fails a real `tsp compile` (confirmed
  // 2026-10-12: the old native avro/openapi emitters never actually compiled
  // this text, so the bug was latent until a real-compiler typespec-cli
  // target exercised a classified field). Kept here because
  // `typespec.importer.ts#extractClassification` still parses this exact
  // `classification:` prefix back out for the regex-based Paste-Import round
  // trip — stripped instead at the real-compile boundary, in
  // `emitter.service.ts#buildSourceForTarget`, for every typespec-cli target.
  if (field.classification) {
    decorators.push(`@tag("classification:${escapeString(field.classification)}")`);
  }

  return decorators;
}

// ---------------------------------------------------------------------------
// Type resolution — LogicalType -> TypeSpec type expression
// ---------------------------------------------------------------------------

/** Structured logical types as a collection member (their `typespecScalar` is not a type). */
const STRUCTURED_MEMBER_TYPES: Record<string, string> = {
  object: "Record<unknown>",
  map: "Record<unknown>",
  array: "unknown[]",
};

/**
 * TypeSpec type of an array element / map value: a reference resolves to the
 * referenced entity, an enum to the field's generated enum, structured types to
 * their generic form; anything else as before (scalar, or a declared type name).
 */
function resolveCollectionMemberType(
  memberType: string,
  field: SuperSchemaField,
  entityName: string
): string {
  if (memberType === "reference") {
    const refName = field.complexType?.referencedEntityName;
    return refName ? sanitizeIdentifier(refName) : "string";
  }
  if (memberType === "enum") {
    return extractEnumValues(field).length > 0 ? inlineEnumName(entityName, field) : "string";
  }
  if (STRUCTURED_MEMBER_TYPES[memberType]) {
    return STRUCTURED_MEMBER_TYPES[memberType];
  }
  return getTypeInfo(memberType)?.typespecScalar ?? memberType;
}

function resolveTypeSpecType(
  field: SuperSchemaField,
  entityName: string
): string {
  const typeInfo = getTypeInfo(field.type);
  const typespecScalar = typeInfo?.typespecScalar ?? field.type;

  switch (field.type as LogicalType) {
    case "enum": {
      return inlineEnumName(entityName, field);
    }
    case "array": {
      const elementType = field.complexType?.arrayElementType ?? "string";
      return `${resolveCollectionMemberType(elementType, field, entityName)}[]`;
    }
    case "map": {
      // TypeSpec `Record<T>` is string-keyed only (a key type argument does not
      // compile), so the key type stays in the IR (complexType.mapKeyType).
      const valueType = field.complexType?.mapValueType ?? "string";
      return `Record<${resolveCollectionMemberType(valueType, field, entityName)}>`;
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

export function sanitizeIdentifier(name: string): string {
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

function sanitizeNamespace(ns: string): string {
  // Namespace can have dots, so only sanitize each segment
  return ns
    .split(".")
    .map((segment) => sanitizeIdentifier(segment))
    .join(".");
}

function escapeString(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}
