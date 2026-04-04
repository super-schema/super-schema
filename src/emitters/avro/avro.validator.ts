/**
 * Avro schema validator — validates emitted JSON against the Avro specification.
 *
 * Checks:
 * - Valid JSON
 * - Top-level record structure (type, name, fields)
 * - Each field has name and type
 * - All types are valid Avro primitive or complex types
 * - Unions are properly formed (no nested unions)
 * - Logical types have required attributes (decimal needs precision/scale, date needs int base)
 */

import type { ValidationResult, ValidationError } from "@/lib/compiler/types";

// ---------------------------------------------------------------------------
// Valid Avro primitive types
// ---------------------------------------------------------------------------

const AVRO_PRIMITIVE_TYPES = new Set([
  "null",
  "boolean",
  "int",
  "long",
  "float",
  "double",
  "bytes",
  "string",
]);

// ---------------------------------------------------------------------------
// Valid Avro logical type base types
// ---------------------------------------------------------------------------

const LOGICAL_TYPE_BASES: Record<string, Set<string>> = {
  decimal: new Set(["bytes", "fixed"]),
  date: new Set(["int"]),
  "time-millis": new Set(["int"]),
  "time-micros": new Set(["long"]),
  "timestamp-millis": new Set(["long"]),
  "timestamp-micros": new Set(["long"]),
  duration: new Set(["fixed"]),
};

// ---------------------------------------------------------------------------
// validateAvroSchema — the main validation function
// ---------------------------------------------------------------------------

export function validateAvroSchema(output: string): ValidationResult {
  const errors: ValidationError[] = [];

  // 1. Valid JSON
  let schema: unknown;
  try {
    schema = JSON.parse(output);
  } catch {
    return {
      valid: false,
      errors: [{ message: "Invalid JSON: could not parse output" }],
    };
  }

  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return {
      valid: false,
      errors: [{ message: "Avro schema must be a JSON object" }],
    };
  }

  const record = schema as Record<string, unknown>;

  // 2. Top-level must have type: "record"
  if (record.type !== "record") {
    errors.push({
      message: `Top-level "type" must be "record", got "${String(record.type)}"`,
      path: "type",
    });
  }

  // 3. Must have "name"
  if (typeof record.name !== "string" || record.name.length === 0) {
    errors.push({
      message: 'Top-level "name" must be a non-empty string',
      path: "name",
    });
  }

  // 4. Must have "fields" array
  if (!Array.isArray(record.fields)) {
    errors.push({
      message: 'Top-level "fields" must be an array',
      path: "fields",
    });
    return { valid: errors.length === 0, errors };
  }

  // 5. Validate each field
  const fields = record.fields as unknown[];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    const fieldPath = `fields[${i}]`;

    if (typeof field !== "object" || field === null || Array.isArray(field)) {
      errors.push({
        message: `${fieldPath}: field must be a JSON object`,
        path: fieldPath,
      });
      continue;
    }

    const f = field as Record<string, unknown>;

    // Field must have "name"
    if (typeof f.name !== "string" || f.name.length === 0) {
      errors.push({
        message: `${fieldPath}: "name" must be a non-empty string`,
        path: `${fieldPath}.name`,
      });
    }

    // Field must have "type"
    if (f.type === undefined) {
      errors.push({
        message: `${fieldPath}: "type" is required`,
        path: `${fieldPath}.type`,
      });
      continue;
    }

    // Validate field type
    const typeErrors = validateAvroType(f.type, `${fieldPath}.type`);
    errors.push(...typeErrors);
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// validateAvroType — recursively validates an Avro type
// ---------------------------------------------------------------------------

function validateAvroType(type: unknown, path: string): ValidationError[] {
  const errors: ValidationError[] = [];

  // Primitive type as string
  if (typeof type === "string") {
    if (!AVRO_PRIMITIVE_TYPES.has(type)) {
      errors.push({
        message: `${path}: unknown primitive type "${type}"`,
        path,
      });
    }
    return errors;
  }

  // Union type as array
  if (Array.isArray(type)) {
    if (type.length === 0) {
      errors.push({
        message: `${path}: union must not be empty`,
        path,
      });
      return errors;
    }

    for (let i = 0; i < type.length; i++) {
      // No nested unions
      if (Array.isArray(type[i])) {
        errors.push({
          message: `${path}[${i}]: nested unions are not allowed in Avro`,
          path: `${path}[${i}]`,
        });
      } else {
        const innerErrors = validateAvroType(type[i], `${path}[${i}]`);
        errors.push(...innerErrors);
      }
    }
    return errors;
  }

  // Complex type as object
  if (typeof type === "object" && type !== null) {
    const t = type as Record<string, unknown>;

    if (typeof t.type !== "string") {
      errors.push({
        message: `${path}: complex type must have a "type" string`,
        path,
      });
      return errors;
    }

    // Validate logical types
    if (typeof t.logicalType === "string") {
      const logicalType = t.logicalType;
      const baseType = t.type;

      // Check base type is valid for this logical type
      const validBases = LOGICAL_TYPE_BASES[logicalType];
      if (validBases && !validBases.has(baseType as string)) {
        errors.push({
          message: `${path}: logical type "${logicalType}" requires base type ${[...validBases].join(" or ")}, got "${String(baseType)}"`,
          path,
        });
      }

      // decimal needs precision and scale
      if (logicalType === "decimal") {
        if (typeof t.precision !== "number" || t.precision < 1) {
          errors.push({
            message: `${path}: decimal logical type requires "precision" >= 1`,
            path: `${path}.precision`,
          });
        }
        if (typeof t.scale !== "number" || t.scale < 0) {
          errors.push({
            message: `${path}: decimal logical type requires "scale" >= 0`,
            path: `${path}.scale`,
          });
        }
      }
    }

    // Validate enum
    if (t.type === "enum") {
      if (typeof t.name !== "string" || t.name.length === 0) {
        errors.push({
          message: `${path}: enum type must have a "name"`,
          path: `${path}.name`,
        });
      }
      if (!Array.isArray(t.symbols) || t.symbols.length === 0) {
        errors.push({
          message: `${path}: enum type must have a non-empty "symbols" array`,
          path: `${path}.symbols`,
        });
      }
    }

    // Validate array
    if (t.type === "array") {
      if (t.items === undefined) {
        errors.push({
          message: `${path}: array type must have "items"`,
          path: `${path}.items`,
        });
      } else {
        const itemErrors = validateAvroType(t.items, `${path}.items`);
        errors.push(...itemErrors);
      }
    }

    // Validate map
    if (t.type === "map") {
      if (t.values === undefined) {
        errors.push({
          message: `${path}: map type must have "values"`,
          path: `${path}.values`,
        });
      } else {
        const valErrors = validateAvroType(t.values, `${path}.values`);
        errors.push(...valErrors);
      }
    }

    // Validate record (nested)
    if (t.type === "record") {
      if (typeof t.name !== "string" || t.name.length === 0) {
        errors.push({
          message: `${path}: record type must have a "name"`,
          path: `${path}.name`,
        });
      }
      if (Array.isArray(t.fields)) {
        for (let i = 0; i < (t.fields as unknown[]).length; i++) {
          const field = (t.fields as Record<string, unknown>[])[i];
          if (field && field.type !== undefined) {
            const fieldErrors = validateAvroType(
              field.type,
              `${path}.fields[${i}].type`
            );
            errors.push(...fieldErrors);
          }
        }
      }
    }

    // Validate fixed
    if (t.type === "fixed") {
      if (typeof t.name !== "string" || t.name.length === 0) {
        errors.push({
          message: `${path}: fixed type must have a "name"`,
          path: `${path}.name`,
        });
      }
      if (typeof t.size !== "number" || t.size < 1) {
        errors.push({
          message: `${path}: fixed type must have "size" >= 1`,
          path: `${path}.size`,
        });
      }
    }

    return errors;
  }

  errors.push({
    message: `${path}: invalid type — expected string, array (union), or object`,
    path,
  });
  return errors;
}
