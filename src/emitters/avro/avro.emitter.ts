/**
 * Avro Schema Emitter — generates valid Avro schema JSON from SuperSchemaModel.
 *
 * Implements the Emitter interface with:
 *   name: "avro", version: "1.0.0", targetFormat: "avro"
 *
 * Handles:
 * - Nullable fields as Avro unions ["null", type]
 * - Decimal as bytes with logicalType "decimal" + precision/scale
 * - Enum as Avro enum with symbols
 * - Array/map as Avro array/map
 * - Date as int with logicalType "date"
 * - Timestamp as long with logicalType "timestamp-millis"
 * - doc from field description, aliases from field aliases
 *
 * Module boundary: depends only on SuperSchemaModel and MappingPolicy.
 */

import type {
  Emitter,
  EmitterResult,
  EmitterWarning,
  ValidationResult,
} from "@/lib/compiler/types";
import type {
  SuperSchemaModel,
  SuperSchemaField,
  MappingPolicy,
} from "@/types/super-schema-model";
import type { ScopedMappingPolicy } from "@/lib/type-mapping/types";
import { resolveMapping } from "@/lib/type-mapping/mapping-engine";
import { validateAvroSchema } from "./avro.validator";

// ---------------------------------------------------------------------------
// Avro schema types (internal)
// ---------------------------------------------------------------------------

type AvroType =
  | string
  | AvroType[]
  | AvroEnumType
  | AvroArrayType
  | AvroMapType
  | AvroLogicalType
  | AvroRecordType
  | AvroFixedType;

interface AvroEnumType {
  type: "enum";
  name: string;
  symbols: string[];
}

interface AvroArrayType {
  type: "array";
  items: AvroType;
}

interface AvroMapType {
  type: "map";
  values: AvroType;
}

interface AvroLogicalType {
  type: string;
  logicalType: string;
  precision?: number;
  scale?: number;
  name?: string;
  size?: number;
}

interface AvroRecordType {
  type: "record";
  name: string;
  fields: AvroField[];
}

interface AvroFixedType {
  type: "fixed";
  name: string;
  size: number;
  logicalType?: string;
}

interface AvroField {
  name: string;
  type: AvroType;
  doc?: string;
  aliases?: string[];
  default?: null;
}

interface AvroRecordSchema {
  type: "record";
  name: string;
  namespace: string;
  doc?: string;
  fields: AvroField[];
}

// ---------------------------------------------------------------------------
// PascalCase helper
// ---------------------------------------------------------------------------

function toPascalCase(input: string): string {
  return input
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .split(" ")
    .filter((s) => s.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
}

// ---------------------------------------------------------------------------
// Namespace helper — domain name to reversed dot notation
// ---------------------------------------------------------------------------

function toNamespace(domain: string): string {
  const sanitized = domain
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, ".");
  return `com.superschema.${sanitized}`;
}

// ---------------------------------------------------------------------------
// Convert MappingPolicy[] to ScopedMappingPolicy[] for resolveMapping
// ---------------------------------------------------------------------------

function toScopedPolicies(policies: MappingPolicy[]): ScopedMappingPolicy[] {
  return policies.map((p) => ({
    ...p,
    // Preserve isLossy if already present (e.g., from getDefaultPolicies())
    isLossy: (p as ScopedMappingPolicy).isLossy ?? false,
    lossDescription: (p as ScopedMappingPolicy).lossDescription,
  }));
}

// ---------------------------------------------------------------------------
// Resolve a field's Avro type from the mapping engine
// ---------------------------------------------------------------------------

function resolveFieldAvroType(
  field: SuperSchemaField,
  policies: ScopedMappingPolicy[],
  warnings: EmitterWarning[]
): AvroType {
  // Special-case: decimal with precision/scale
  if (
    (field.type === "decimal" ||
      field.type === "decimal128" ||
      field.type === "numeric") &&
    field.precision !== undefined &&
    field.scale !== undefined
  ) {
    return {
      type: "bytes",
      logicalType: "decimal",
      precision: field.precision,
      scale: field.scale,
    };
  }

  // Special-case: enum with values from complexType or decorators
  if (field.type === "enum") {
    const symbols = extractEnumSymbols(field);
    if (symbols.length > 0) {
      return {
        type: "enum",
        name: `${toPascalCase(field.name)}Enum`,
        symbols,
      };
    }
    // Fallback: enum with no symbols emits string + warning
    warnings.push({
      message: `Field "${field.name}": enum has no symbols, falling back to string`,
      fieldName: field.name,
    });
    return "string";
  }

  // Special-case: array with element type
  if (field.type === "array") {
    const itemType = resolveArrayItemType(field, policies, warnings);
    return {
      type: "array",
      items: itemType,
    };
  }

  // Special-case: map with value type
  if (field.type === "map") {
    const valueType = resolveMapValueType(field, policies, warnings);
    return {
      type: "map",
      values: valueType,
    };
  }

  // Use the mapping engine for everything else
  const result = resolveMapping(field.type, "avro", policies);

  if (!result.success) {
    warnings.push({
      message: `Field "${field.name}": ${result.error.message}, defaulting to "string"`,
      fieldName: field.name,
    });
    return "string";
  }

  const mappedType = result.result.mappedType;

  // Handle lossy mapping warnings
  if (result.result.isLossy && result.result.lossDescription) {
    warnings.push({
      message: `Field "${field.name}": ${result.result.lossDescription}`,
      fieldName: field.name,
    });
  }

  // Parse logical type notation: "base/logicalType" → { type: base, logicalType }
  return parseAvroMappedType(mappedType, field);
}

// ---------------------------------------------------------------------------
// Parse mapped type strings like "long/timestamp-millis", "int/date"
// ---------------------------------------------------------------------------

function parseAvroMappedType(
  mappedType: string,
  field: SuperSchemaField
): AvroType {
  if (mappedType.includes("/")) {
    const [baseType, logicalType] = mappedType.split("/", 2);

    // decimal logical type with precision/scale
    if (logicalType === "decimal") {
      return {
        type: baseType,
        logicalType: "decimal",
        precision: field.precision ?? 38,
        scale: field.scale ?? 0,
      };
    }

    // duration on fixed
    if (logicalType === "duration") {
      return {
        type: "fixed",
        name: `${toPascalCase(field.name)}Duration`,
        size: 12,
        logicalType: "duration",
      };
    }

    return {
      type: baseType,
      logicalType,
    };
  }

  return mappedType;
}

// ---------------------------------------------------------------------------
// Extract enum symbols from field metadata
// ---------------------------------------------------------------------------

function extractEnumSymbols(field: SuperSchemaField): string[] {
  // Check complexType for enum values
  if (field.complexType?.nestedFields) {
    return field.complexType.nestedFields.map((nf) => nf.name);
  }

  // Check decorators for enum values (validation.pattern or custom)
  if (field.decorators?.typespec?.validation?.pattern) {
    const pattern = field.decorators.typespec.validation.pattern;
    // Try to extract from regex-like pattern: ^(A|B|C)$
    const match = pattern.match(/^\^?\(([^)]+)\)\$?$/);
    if (match) {
      return match[1].split("|");
    }
  }

  return [];
}

// ---------------------------------------------------------------------------
// Resolve array item type
// ---------------------------------------------------------------------------

function resolveArrayItemType(
  field: SuperSchemaField,
  policies: ScopedMappingPolicy[],
  warnings: EmitterWarning[]
): AvroType {
  if (field.complexType?.arrayElementType) {
    const elementType = field.complexType.arrayElementType;
    const result = resolveMapping(elementType, "avro", policies);
    if (result.success) {
      // Handle element types that have precision (e.g., decimal array items)
      if (
        elementType === "decimal" &&
        field.complexType.arrayElementPrecision !== undefined &&
        field.complexType.arrayElementScale !== undefined
      ) {
        return {
          type: "bytes",
          logicalType: "decimal",
          precision: field.complexType.arrayElementPrecision,
          scale: field.complexType.arrayElementScale,
        };
      }
      return parseAvroMappedType(result.result.mappedType, field);
    }
    warnings.push({
      message: `Field "${field.name}": could not resolve array element type "${elementType}", defaulting to "string"`,
      fieldName: field.name,
    });
  }
  return "string";
}

// ---------------------------------------------------------------------------
// Resolve map value type
// ---------------------------------------------------------------------------

function resolveMapValueType(
  field: SuperSchemaField,
  policies: ScopedMappingPolicy[],
  warnings: EmitterWarning[]
): AvroType {
  if (field.complexType?.mapValueType) {
    const valueType = field.complexType.mapValueType;
    const result = resolveMapping(valueType, "avro", policies);
    if (result.success) {
      return parseAvroMappedType(result.result.mappedType, field);
    }
    warnings.push({
      message: `Field "${field.name}": could not resolve map value type "${valueType}", defaulting to "string"`,
      fieldName: field.name,
    });
  }
  return "string";
}

// ---------------------------------------------------------------------------
// Build a single Avro field from a SuperSchemaField
// ---------------------------------------------------------------------------

function buildAvroField(
  field: SuperSchemaField,
  policies: ScopedMappingPolicy[],
  warnings: EmitterWarning[]
): AvroField {
  let avroType = resolveFieldAvroType(field, policies, warnings);

  // Wrap nullable fields in union ["null", type]
  if (field.nullable) {
    if (Array.isArray(avroType)) {
      // Already a union — prepend "null" if not present
      if (!avroType.includes("null")) {
        avroType = ["null", ...avroType];
      }
    } else {
      avroType = ["null", avroType];
    }
  }

  const avroField: AvroField = {
    name: field.name,
    type: avroType,
  };

  // Add default null for nullable fields
  if (field.nullable) {
    avroField.default = null;
  }

  // Add doc from field description (semantics decorator or direct)
  const doc =
    field.decorators?.semantics?.description ?? field.description;
  if (doc && doc.length > 0) {
    avroField.doc = doc;
  }

  // Add aliases
  const aliases =
    field.decorators?.semantics?.aliases ?? field.aliases;
  if (aliases && aliases.length > 0) {
    avroField.aliases = aliases;
  }

  return avroField;
}

// ---------------------------------------------------------------------------
// AvroEmitter — implements the Emitter interface
// ---------------------------------------------------------------------------

export const avroEmitter: Emitter = {
  name: "avro",
  version: "1.0.0",
  targetFormat: "avro",

  emit(model: SuperSchemaModel, policies: MappingPolicy[]): EmitterResult {
    const warnings: EmitterWarning[] = [];
    const scopedPolicies = toScopedPolicies(policies);

    // Sort fields by sortOrder for deterministic output
    const sortedFields = [...model.fields].sort(
      (a, b) => a.sortOrder - b.sortOrder
    );

    // Build Avro fields
    const avroFields = sortedFields.map((field) =>
      buildAvroField(field, scopedPolicies, warnings)
    );

    // Build the top-level Avro record schema
    const schema: AvroRecordSchema = {
      type: "record",
      name: toPascalCase(model.entity.name),
      namespace: toNamespace(model.entity.domain),
      fields: avroFields,
    };

    // Add doc from entity description
    if (model.entity.description && model.entity.description.length > 0) {
      schema.doc = model.entity.description;
    }

    // Serialize to formatted JSON with deterministic key ordering
    const output = JSON.stringify(schema, null, 2);

    return {
      output,
      warnings,
      targetFormat: "avro",
    };
  },

  validate(output: string): ValidationResult {
    return validateAvroSchema(output);
  },
};
