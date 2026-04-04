/**
 * OpenAPI Schema Validator
 *
 * Validates emitted OpenAPI 3.0 schema component YAML against structural
 * rules: valid YAML, correct top-level structure, valid OpenAPI types,
 * well-formed $ref paths, and required array correctness.
 */

import { parse as yamlParse } from "yaml";
import type { ValidationResult, ValidationError } from "@/lib/compiler/types";

// ---------------------------------------------------------------------------
// Valid OpenAPI 3.0 types
// ---------------------------------------------------------------------------

const VALID_OPENAPI_TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "array",
  "object",
]);

// ---------------------------------------------------------------------------
// validateOpenApiSchema
// ---------------------------------------------------------------------------

export function validateOpenApiSchema(output: string): ValidationResult {
  const errors: ValidationError[] = [];

  // 1. Parse YAML
  let parsed: unknown;
  try {
    parsed = yamlParse(output);
  } catch (e) {
    errors.push({
      message: `Invalid YAML: ${e instanceof Error ? e.message : String(e)}`,
    });
    return { valid: false, errors };
  }

  if (typeof parsed !== "object" || parsed === null) {
    errors.push({ message: "Root must be an object" });
    return { valid: false, errors };
  }

  const root = parsed as Record<string, unknown>;

  // 2. Check top-level structure
  if (!root.components || typeof root.components !== "object") {
    errors.push({
      message: 'Missing top-level "components" object',
      path: "components",
    });
    return { valid: false, errors };
  }

  const components = root.components as Record<string, unknown>;
  if (!components.schemas || typeof components.schemas !== "object") {
    errors.push({
      message: 'Missing "components.schemas" object',
      path: "components.schemas",
    });
    return { valid: false, errors };
  }

  const schemas = components.schemas as Record<string, unknown>;

  // 3. Validate each schema
  for (const [schemaName, schema] of Object.entries(schemas)) {
    if (typeof schema !== "object" || schema === null) {
      errors.push({
        message: `Schema "${schemaName}" must be an object`,
        path: `components.schemas.${schemaName}`,
      });
      continue;
    }

    const schemaObj = schema as Record<string, unknown>;

    // Must have type: object
    if (schemaObj.type !== "object") {
      errors.push({
        message: `Schema "${schemaName}" must have type: object`,
        path: `components.schemas.${schemaName}.type`,
      });
    }

    // Must have properties
    if (
      !schemaObj.properties ||
      typeof schemaObj.properties !== "object"
    ) {
      errors.push({
        message: `Schema "${schemaName}" must have a "properties" object`,
        path: `components.schemas.${schemaName}.properties`,
      });
      continue;
    }

    const properties = schemaObj.properties as Record<string, unknown>;
    const required = Array.isArray(schemaObj.required)
      ? (schemaObj.required as string[])
      : [];

    // Validate required array only contains property names
    for (const reqField of required) {
      if (!(reqField in properties)) {
        errors.push({
          message: `Required field "${reqField}" not found in properties of "${schemaName}"`,
          path: `components.schemas.${schemaName}.required`,
        });
      }
    }

    // Validate each property
    for (const [propName, prop] of Object.entries(properties)) {
      if (typeof prop !== "object" || prop === null) {
        errors.push({
          message: `Property "${propName}" in "${schemaName}" must be an object`,
          path: `components.schemas.${schemaName}.properties.${propName}`,
        });
        continue;
      }

      const propObj = prop as Record<string, unknown>;

      // Properties with $ref don't need a type
      if (propObj.$ref) {
        if (
          typeof propObj.$ref !== "string" ||
          !propObj.$ref.startsWith("#/components/schemas/")
        ) {
          errors.push({
            message: `Invalid $ref "${propObj.$ref}" in property "${propName}" — must start with "#/components/schemas/"`,
            path: `components.schemas.${schemaName}.properties.${propName}.$ref`,
          });
        }
        continue;
      }

      // Validate type
      if (!propObj.type) {
        errors.push({
          message: `Property "${propName}" in "${schemaName}" must have a "type" or "$ref"`,
          path: `components.schemas.${schemaName}.properties.${propName}`,
        });
        continue;
      }

      if (!VALID_OPENAPI_TYPES.has(propObj.type as string)) {
        errors.push({
          message: `Invalid OpenAPI type "${propObj.type}" in property "${propName}" — must be one of: ${[...VALID_OPENAPI_TYPES].join(", ")}`,
          path: `components.schemas.${schemaName}.properties.${propName}.type`,
        });
      }

      // Validate enum if present
      if ("enum" in propObj) {
        if (!Array.isArray(propObj.enum) || propObj.enum.length === 0) {
          errors.push({
            message: `Property "${propName}" has "enum" keyword but values array is empty or invalid`,
            path: `components.schemas.${schemaName}.properties.${propName}.enum`,
          });
        }
      }

      // Validate array has items
      if (propObj.type === "array") {
        if (!propObj.items || typeof propObj.items !== "object") {
          errors.push({
            message: `Array property "${propName}" must have an "items" schema`,
            path: `components.schemas.${schemaName}.properties.${propName}.items`,
          });
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
