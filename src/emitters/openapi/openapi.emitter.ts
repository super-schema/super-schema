/**
 * OpenAPI 3.0 Schema Emitter
 *
 * Converts a SuperSchemaModel into a valid OpenAPI 3.0 schema component YAML.
 * Uses the type mapping engine to resolve logical types to OpenAPI types.
 *
 * Module boundaries: depends only on SuperSchemaModel, MappingPolicy,
 * and the mapping engine. No database access, no compiler internals.
 */

import { stringify as yamlStringify } from "yaml";
import type {
  SuperSchemaModel,
  SuperSchemaField,
  MappingPolicy,
  QualityRule,
} from "@/types/super-schema-model";
import type {
  Emitter,
  EmitterResult,
  EmitterWarning,
  ValidationResult,
} from "@/lib/compiler/types";
import { resolveMapping } from "@/lib/type-mapping/mapping-engine";
import type { ScopedMappingPolicy } from "@/lib/type-mapping/types";
import { validateOpenApiSchema } from "./openapi.validator";

// ---------------------------------------------------------------------------
// OpenAPI property shape
// ---------------------------------------------------------------------------

interface OpenApiProperty {
  type?: string;
  format?: string;
  description?: string;
  nullable?: boolean;
  enum?: string[];
  items?: OpenApiProperty | { $ref: string };
  $ref?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  "x-precision"?: number;
  "x-scale"?: number;
}

// ---------------------------------------------------------------------------
// OpenAPI schema component shape
// ---------------------------------------------------------------------------

interface OpenApiSchemaComponent {
  type: "object";
  description?: string;
  required?: string[];
  properties: Record<string, OpenApiProperty>;
}

interface OpenApiOutput {
  components: {
    schemas: Record<string, OpenApiSchemaComponent>;
  };
}

// ---------------------------------------------------------------------------
// Parse a mappedType string like "integer/int64" into { type, format }
// ---------------------------------------------------------------------------

function parseMappedType(mappedType: string): { type: string; format?: string } {
  // Special: "$ref" for references
  if (mappedType === "$ref") {
    return { type: "$ref" };
  }

  // Special: "string+enum"
  if (mappedType === "string+enum") {
    return { type: "string" };
  }

  // Special: "object/additionalProperties" for maps
  if (mappedType === "object/additionalProperties") {
    return { type: "object" };
  }

  const slashIndex = mappedType.indexOf("/");
  if (slashIndex === -1) {
    return { type: mappedType };
  }

  return {
    type: mappedType.substring(0, slashIndex),
    format: mappedType.substring(slashIndex + 1),
  };
}

// ---------------------------------------------------------------------------
// Map quality rules to OpenAPI validation keywords
// ---------------------------------------------------------------------------

function applyQualityRules(
  property: OpenApiProperty,
  rules: QualityRule[]
): void {
  for (const rule of rules) {
    switch (rule.type) {
      case "range": {
        if (rule.params.min !== undefined) {
          property.minimum = rule.params.min as number;
        }
        if (rule.params.max !== undefined) {
          property.maximum = rule.params.max as number;
        }
        break;
      }
      case "min_length": {
        if (rule.params.value !== undefined) {
          property.minLength = rule.params.value as number;
        }
        break;
      }
      case "max_length": {
        if (rule.params.value !== undefined) {
          property.maxLength = rule.params.value as number;
        }
        break;
      }
      case "regex": {
        if (rule.params.pattern !== undefined) {
          property.pattern = rule.params.pattern as string;
        }
        break;
      }
      case "enum_values": {
        if (Array.isArray(rule.params.values)) {
          property.enum = rule.params.values as string[];
        }
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Build an OpenAPI property for a single field
// ---------------------------------------------------------------------------

function buildFieldProperty(
  field: SuperSchemaField,
  policies: ScopedMappingPolicy[],
  warnings: EmitterWarning[]
): OpenApiProperty {
  const property: OpenApiProperty = {};

  // Resolve the mapping for this field type
  const mappingResult = resolveMapping(field.type, "openapi", policies);

  if (!mappingResult.success) {
    // Fallback: use string type and add a warning
    property.type = "string";
    warnings.push({
      message: `No mapping found for type "${field.type}" — defaulting to "string"`,
      fieldName: field.name,
    });
  } else {
    const { mappedType, isLossy, lossDescription } = mappingResult.result;

    // Handle reference type
    if (mappedType === "$ref") {
      const refName =
        field.complexType?.referencedEntityName ?? field.name;
      property.$ref = `#/components/schemas/${refName}`;

      // References are returned directly with nullable/description only
      if (field.nullable) {
        property.nullable = true;
      }
      if (field.description) {
        property.description = field.description;
      }
      return property;
    }

    // Handle enum type
    if (mappedType === "string+enum") {
      property.type = "string";
      // Get enum values from quality rules or complexType
      const enumRule = field.decorators?.quality?.rules?.find(
        (r) => r.type === "enum_values"
      );
      if (enumRule && Array.isArray(enumRule.params.values)) {
        property.enum = enumRule.params.values as string[];
      }
    }
    // Handle array type
    else if (field.type === "array") {
      property.type = "array";
      if (field.complexType?.arrayElementType) {
        const elementMapping = resolveMapping(
          field.complexType.arrayElementType,
          "openapi",
          policies
        );
        if (elementMapping.success) {
          const elemParsed = parseMappedType(elementMapping.result.mappedType);
          if (elemParsed.type === "$ref") {
            property.items = {
              $ref: `#/components/schemas/${field.complexType.referencedEntityName ?? field.complexType.arrayElementType}`,
            };
          } else {
            const itemsProp: OpenApiProperty = { type: elemParsed.type };
            if (elemParsed.format) {
              itemsProp.format = elemParsed.format;
            }
            property.items = itemsProp;
          }
        } else {
          property.items = { type: "string" };
        }
      } else {
        property.items = { type: "string" };
      }
    }
    // Standard type mapping
    else {
      const parsed = parseMappedType(mappedType);
      property.type = parsed.type;
      if (parsed.format) {
        property.format = parsed.format;
      }
    }

    // Handle decimal precision extensions
    if (
      field.type === "decimal" ||
      field.type === "decimal128"
    ) {
      if (field.precision !== undefined) {
        property["x-precision"] = field.precision;
      }
      if (field.scale !== undefined) {
        property["x-scale"] = field.scale;
      }
    }

    // Lossy mapping warning
    if (isLossy && lossDescription) {
      warnings.push({
        message: `Lossy mapping for field "${field.name}": ${lossDescription}`,
        fieldName: field.name,
      });
    }
  }

  // Nullable
  if (field.nullable) {
    property.nullable = true;
  }

  // Description from field.description or semantics decorator
  const description =
    field.description ||
    field.decorators?.semantics?.description;
  if (description) {
    property.description = description;
  }

  // Quality rules
  const qualityRules = field.decorators?.quality?.rules;
  if (qualityRules && qualityRules.length > 0) {
    applyQualityRules(property, qualityRules);
  }

  return property;
}

// ---------------------------------------------------------------------------
// OpenAPI Emitter
// ---------------------------------------------------------------------------

export const openApiEmitter: Emitter = {
  name: "openapi",
  version: "1.0.0",
  targetFormat: "openapi",

  emit(model: SuperSchemaModel, policies: MappingPolicy[]): EmitterResult {
    const warnings: EmitterWarning[] = [];

    // Convert MappingPolicy[] to ScopedMappingPolicy[] for the engine.
    // If the input already has ScopedMappingPolicy fields (isLossy, lossDescription),
    // preserve them; otherwise default to non-lossy.
    const scopedPolicies: ScopedMappingPolicy[] = policies.map((p) => {
      const scoped = p as Partial<ScopedMappingPolicy>;
      return {
        ...p,
        isLossy: scoped.isLossy ?? false,
        lossDescription: scoped.lossDescription,
      };
    });

    // Build entity schema
    const entityName = model.entity.name;
    const requiredFields: string[] = [];
    const properties: Record<string, OpenApiProperty> = {};

    // Sort fields by sortOrder for deterministic output
    const sortedFields = [...model.fields].sort(
      (a, b) => a.sortOrder - b.sortOrder
    );

    for (const field of sortedFields) {
      properties[field.name] = buildFieldProperty(
        field,
        scopedPolicies,
        warnings
      );

      if (!field.nullable) {
        requiredFields.push(field.name);
      }
    }

    const schemaComponent: OpenApiSchemaComponent = {
      type: "object",
      properties,
    };

    if (model.entity.description) {
      schemaComponent.description = model.entity.description;
    }

    if (requiredFields.length > 0) {
      schemaComponent.required = requiredFields;
    }

    const output: OpenApiOutput = {
      components: {
        schemas: {
          [entityName]: schemaComponent,
        },
      },
    };

    const yamlOutput = yamlStringify(output, {
      sortMapEntries: false,
      lineWidth: 0,
    });

    return {
      output: yamlOutput,
      warnings,
      targetFormat: "openapi",
    };
  },

  validate(output: string): ValidationResult {
    return validateOpenApiSchema(output);
  },
};
