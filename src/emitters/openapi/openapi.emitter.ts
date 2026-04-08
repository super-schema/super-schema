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
  SuperSchemaOperation,
} from "@/types/super-schema-model";
import type {
  Emitter,
  EmitterResult,
  EmitterWarning,
  ValidationResult,
} from "@/lib/compiler/types";
import { resolveMapping } from "@/lib/type-mapping/mapping-engine";
import { getFieldOverrideCommentFromMapping } from "@/lib/schema-targets/field-type-overrides";
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
  additionalProperties?: true | OpenApiProperty | { $ref: string };
  $ref?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  "x-precision"?: number;
  "x-scale"?: number;
  "x-super-schema-type-override"?: {
    logicalType: string;
    defaultTargetType: string | null;
    targetType: string;
    comment: string;
  };
}

// ---------------------------------------------------------------------------
// OpenAPI schema component shape
// ---------------------------------------------------------------------------

interface OpenApiSchemaComponent {
  type?: "object";
  description?: string;
  required?: string[];
  properties?: Record<string, OpenApiProperty>;
  allOf?: Array<{ $ref: string } | OpenApiSchemaComponent>;
  oneOf?: Array<{ $ref?: string; type?: string }>;
  discriminator?: { propertyName: string };
  enum?: string[];
  "x-retention"?: {
    strategy: string;
    period?: number;
    periodUnit?: string;
    referenceField?: string;
    condition?: string;
    action: string;
  };
}

interface OpenApiPathOperation {
  summary?: string;
  description?: string;
  operationId?: string;
  tags?: string[];
  parameters?: Array<{
    name: string;
    in: string;
    required?: boolean;
    description?: string;
    schema: { type: string; format?: string };
  }>;
  requestBody?: {
    required?: boolean;
    content: {
      "application/json": {
        schema: { $ref: string } | { type: string };
      };
    };
  };
  responses: Record<string, {
    description: string;
    content?: {
      "application/json": {
        schema: { $ref: string } | { type: string };
      };
    };
  }>;
}

interface OpenApiOutput {
  components: {
    schemas: Record<string, OpenApiSchemaComponent>;
  };
  paths?: Record<string, Record<string, OpenApiPathOperation>>;
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
  warnings: EmitterWarning[],
  entityId: string
): OpenApiProperty {
  const property: OpenApiProperty = {};

  // Resolve the mapping for this field type
  const mappingResult = resolveMapping(
    field.type,
    "openapi",
    policies,
    entityId,
    field.id
  );

  if (!mappingResult.success) {
    // Fallback: use string type and add a warning
    property.type = "string";
    warnings.push({
      message: `No mapping found for type "${field.type}" — defaulting to "string"`,
      fieldName: field.name,
    });
  } else {
    const { mappedType, isLossy, lossDescription, overrideSource } =
      mappingResult.result;
    const hasFieldOverride = overrideSource === "field";

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
    if (
      ((!hasFieldOverride && mappedType === "string+enum") ||
        mappedType === "string+enum")
    ) {
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
    else if ((!hasFieldOverride && field.type === "array") || mappedType === "array") {
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
    // Handle map/object type
    else if (
      ((!hasFieldOverride && field.type === "map") ||
        mappedType === "object/additionalProperties")
    ) {
      property.type = "object";
      if (field.complexType?.mapValueType) {
        const valueMapping = resolveMapping(
          field.complexType.mapValueType,
          "openapi",
          policies
        );
        if (valueMapping.success) {
          const parsedValue = parseMappedType(valueMapping.result.mappedType);
          if (parsedValue.type === "$ref") {
            property.additionalProperties = {
              $ref: `#/components/schemas/${field.complexType.referencedEntityName ?? field.complexType.mapValueType}`,
            };
          } else {
            const additionalProperty: OpenApiProperty = { type: parsedValue.type };
            if (parsedValue.format) {
              additionalProperty.format = parsedValue.format;
            }
            property.additionalProperties = additionalProperty;
          }
        } else {
          property.additionalProperties = true;
        }
      } else {
        property.additionalProperties = true;
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

    const overrideNote = getFieldOverrideCommentFromMapping(
      field.type,
      mappingResult.result
    );
    if (overrideNote) {
      property["x-super-schema-type-override"] = {
        logicalType: field.type,
        defaultTargetType: mappingResult.result.defaultMappedType ?? null,
        targetType: mappedType,
        comment: overrideNote,
      };
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
    const scopedPolicies: ScopedMappingPolicy[] = policies.map((p) => {
      const scoped = p as Partial<ScopedMappingPolicy>;
      return {
        ...p,
        isLossy: scoped.isLossy ?? false,
        lossDescription: scoped.lossDescription,
      };
    });

    const schemas: Record<string, OpenApiSchemaComponent> = {};

    // Emit shared enums as enum schemas
    if (model.sharedEnums) {
      for (const sharedEnum of model.sharedEnums) {
        const enumSchema: OpenApiSchemaComponent = {
          type: "object",
          enum: sharedEnum.values,
        };
        if (sharedEnum.description) {
          enumSchema.description = sharedEnum.description;
        }
        schemas[sharedEnum.name] = enumSchema;
      }
    }

    // Emit union types as oneOf schemas
    if (model.unionTypes) {
      for (const union of model.unionTypes) {
        const unionSchema: OpenApiSchemaComponent = {
          oneOf: union.memberTypes.map((t) => ({ $ref: `#/components/schemas/${t}` })),
        };
        if (union.description) {
          unionSchema.description = union.description;
        }
        schemas[union.name] = unionSchema;
      }
    }

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
        warnings,
        model.entity.id
      );

      if (!field.nullable) {
        requiredFields.push(field.name);
      }
    }

    // Handle inheritance with allOf
    if (model.entity.parentEntityName) {
      const ownSchema: OpenApiSchemaComponent = {
        type: "object",
        properties,
      };
      if (requiredFields.length > 0) {
        ownSchema.required = requiredFields;
      }

      const schemaComponent: OpenApiSchemaComponent = {
        allOf: [
          { $ref: `#/components/schemas/${model.entity.parentEntityName}` },
          ownSchema,
        ],
      };
      if (model.entity.description) {
        schemaComponent.description = model.entity.description;
      }
      schemas[entityName] = schemaComponent;
    } else {
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
      schemas[entityName] = schemaComponent;
    }

    // Add x-retention extension if retention policy exists
    const rp = model.entity.metadata?.retentionPolicy;
    if (rp && schemas[entityName]) {
      const ext: OpenApiSchemaComponent["x-retention"] = {
        strategy: rp.strategy,
        action: rp.action,
      };
      if (rp.period) ext.period = rp.period;
      if (rp.periodUnit) ext.periodUnit = rp.periodUnit;
      if (rp.referenceField) ext.referenceField = rp.referenceField;
      if (rp.condition) ext.condition = rp.condition;
      schemas[entityName]["x-retention"] = ext;
    }

    const output: OpenApiOutput = {
      components: {
        schemas,
      },
    };

    // Emit operations as paths
    const allOps = collectOperations(model);
    if (allOps.length > 0) {
      const paths: Record<string, Record<string, OpenApiPathOperation>> = {};
      for (const { op, interfaceName } of allOps) {
        const path = op.httpPath || `/${entityName.toLowerCase()}s`;
        const method = (op.httpMethod || "GET").toLowerCase();

        if (!paths[path]) paths[path] = {};

        const pathOp: OpenApiPathOperation = {
          operationId: op.name,
          responses: {},
        };

        if (op.description) pathOp.description = op.description;
        if (interfaceName) pathOp.tags = [interfaceName];

        // Parameters
        const params = op.parameters.filter((p) => p.location !== "body");
        if (params.length > 0) {
          pathOp.parameters = params.map((p) => ({
            name: p.name,
            in: p.location,
            required: p.required,
            description: p.description,
            schema: { type: mapParamType(p.type) },
          }));
        }

        // Request body
        const bodyParam = op.parameters.find((p) => p.location === "body");
        if (bodyParam) {
          pathOp.requestBody = {
            required: bodyParam.required,
            content: {
              "application/json": {
                schema: { $ref: `#/components/schemas/${bodyParam.type}` },
              },
            },
          };
        }

        // Responses
        if (op.responses.length > 0) {
          for (const resp of op.responses) {
            const respObj: { description: string; content?: { "application/json": { schema: { $ref: string } | { type: string } } } } = {
              description: resp.description || `${resp.statusCode} response`,
            };
            if (resp.type) {
              respObj.content = {
                "application/json": {
                  schema: { $ref: `#/components/schemas/${resp.type}` },
                },
              };
            }
            pathOp.responses[String(resp.statusCode)] = respObj;
          }
        } else {
          pathOp.responses["200"] = { description: "Successful response" };
        }

        paths[path][method] = pathOp;
      }
      output.paths = paths;
    }

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

// ---------------------------------------------------------------------------
// Operation helpers
// ---------------------------------------------------------------------------

function collectOperations(
  model: SuperSchemaModel
): Array<{ op: SuperSchemaOperation; interfaceName?: string }> {
  const ops: Array<{ op: SuperSchemaOperation; interfaceName?: string }> = [];

  if (model.interfaces) {
    for (const iface of model.interfaces) {
      for (const op of iface.operations) {
        ops.push({ op, interfaceName: iface.name });
      }
    }
  }

  return ops;
}

function mapParamType(type: string): string {
  const typeMap: Record<string, string> = {
    string: "string",
    int32: "integer",
    int64: "integer",
    integer: "integer",
    boolean: "boolean",
    float32: "number",
    float64: "number",
  };
  return typeMap[type] || "string";
}
