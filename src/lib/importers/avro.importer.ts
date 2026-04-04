/**
 * Avro Schema Importer — parses Avro JSON schema into ParsedEntity.
 *
 * Reverse of the Avro emitter: maps Avro types back to logical types.
 *
 * Handles:
 * - Primitive types (string, int, long, float, double, boolean, bytes)
 * - Nullable via union types ["null", "string"]
 * - Logical types (date, timestamp-millis, decimal, duration)
 * - Nested records (flagged as low confidence)
 * - doc and aliases
 */

import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import type { ParsedEntity, ParsedField, ImportConfidence } from "./types";

// ---------------------------------------------------------------------------
// Avro → Logical type mapping (reverse of avro.emitter.ts)
// ---------------------------------------------------------------------------

const AVRO_PRIMITIVE_MAP: Record<string, { type: string; confidence: ImportConfidence }> = {
  string: { type: "string", confidence: "high" },
  int: { type: "int32", confidence: "high" },
  long: { type: "int64", confidence: "high" },
  float: { type: "float32", confidence: "high" },
  double: { type: "float64", confidence: "high" },
  boolean: { type: "boolean", confidence: "high" },
  bytes: { type: "bytes", confidence: "low" },
  null: { type: "string", confidence: "low" },
};

// ---------------------------------------------------------------------------
// Parse an Avro type to logical type
// ---------------------------------------------------------------------------

interface ResolvedType {
  type: string;
  confidence: ImportConfidence;
  nullable: boolean;
  originalType: string;
}

function resolveAvroType(avroType: unknown): ResolvedType {
  // String primitive
  if (typeof avroType === "string") {
    const mapped = AVRO_PRIMITIVE_MAP[avroType];
    if (mapped) {
      return {
        type: mapped.type,
        confidence: mapped.confidence,
        nullable: false,
        originalType: avroType,
      };
    }
    return {
      type: "string",
      confidence: "low",
      nullable: false,
      originalType: avroType,
    };
  }

  // Array = union type
  if (Array.isArray(avroType)) {
    const nonNull = avroType.filter(
      (t) => t !== "null" && !(typeof t === "object" && t !== null && (t as Record<string, unknown>).type === "null")
    );
    const hasNull = avroType.length !== nonNull.length;

    if (nonNull.length === 1) {
      const resolved = resolveAvroType(nonNull[0]);
      return {
        ...resolved,
        nullable: hasNull || resolved.nullable,
      };
    }

    // Multi-type union (not just null + one type) → medium confidence
    if (nonNull.length > 1) {
      const first = resolveAvroType(nonNull[0]);
      return {
        type: first.type,
        confidence: "medium",
        nullable: hasNull,
        originalType: JSON.stringify(avroType),
      };
    }

    // Only null
    return {
      type: "string",
      confidence: "low",
      nullable: true,
      originalType: "null",
    };
  }

  // Object type (logical types, records, arrays, maps, enums)
  if (typeof avroType === "object" && avroType !== null) {
    const obj = avroType as Record<string, unknown>;

    // Logical types
    if (obj.logicalType) {
      return resolveLogicalType(obj);
    }

    // Enum
    if (obj.type === "enum") {
      return {
        type: "enum",
        confidence: "high",
        nullable: false,
        originalType: `enum(${(obj.symbols as string[] || []).join(",")})`,
      };
    }

    // Array
    if (obj.type === "array") {
      return {
        type: "array",
        confidence: "medium",
        nullable: false,
        originalType: "array",
      };
    }

    // Map
    if (obj.type === "map") {
      return {
        type: "map",
        confidence: "low",
        nullable: false,
        originalType: "map",
      };
    }

    // Nested record
    if (obj.type === "record") {
      return {
        type: "object",
        confidence: "low",
        nullable: false,
        originalType: `record(${obj.name || "nested"})`,
      };
    }

    // Fixed
    if (obj.type === "fixed") {
      return {
        type: "bytes",
        confidence: "medium",
        nullable: false,
        originalType: `fixed(${obj.size})`,
      };
    }

    // Fallback for other object types with a string `type`
    if (typeof obj.type === "string") {
      const mapped = AVRO_PRIMITIVE_MAP[obj.type as string];
      if (mapped) {
        return {
          type: mapped.type,
          confidence: mapped.confidence,
          nullable: false,
          originalType: obj.type as string,
        };
      }
    }
  }

  return {
    type: "string",
    confidence: "low",
    nullable: false,
    originalType: String(avroType),
  };
}

// ---------------------------------------------------------------------------
// Resolve Avro logical types
// ---------------------------------------------------------------------------

function resolveLogicalType(obj: Record<string, unknown>): ResolvedType {
  const logicalType = obj.logicalType as string;

  switch (logicalType) {
    case "date":
      return {
        type: "plainDate",
        confidence: "high",
        nullable: false,
        originalType: "int/date",
      };
    case "time-millis":
    case "time-micros":
      return {
        type: "plainTime",
        confidence: "high",
        nullable: false,
        originalType: `${obj.type}/${logicalType}`,
      };
    case "timestamp-millis":
    case "timestamp-micros":
      return {
        type: "utcDateTime",
        confidence: "high",
        nullable: false,
        originalType: `long/${logicalType}`,
      };
    case "decimal":
      return {
        type: "decimal",
        confidence: "high",
        nullable: false,
        originalType: `bytes/decimal(${obj.precision},${obj.scale})`,
      };
    case "duration":
      return {
        type: "duration",
        confidence: "high",
        nullable: false,
        originalType: "fixed/duration",
      };
    case "uuid":
      return {
        type: "string",
        confidence: "high",
        nullable: false,
        originalType: "string/uuid",
      };
    default:
      return {
        type: "string",
        confidence: "low",
        nullable: false,
        originalType: `${obj.type}/${logicalType}`,
      };
  }
}

// ---------------------------------------------------------------------------
// Strip namespace from Avro name: "com.example.User" → "User"
// ---------------------------------------------------------------------------

function stripNamespace(name: string): string {
  const parts = name.split(".");
  return parts[parts.length - 1];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function parseAvroSchema(content: string): Result<ParsedEntity> {
  let schema: Record<string, unknown>;
  try {
    schema = JSON.parse(content);
  } catch {
    return err({
      code: "PARSE_ERROR",
      message: "Invalid JSON: could not parse Avro schema",
      suggestedFix: "Ensure the content is valid JSON.",
    });
  }

  if (schema.type !== "record") {
    return err({
      code: "PARSE_ERROR",
      message: `Expected Avro schema type "record", got "${schema.type}"`,
      suggestedFix: 'Ensure the Avro schema has "type": "record" at the top level.',
    });
  }

  const entityName = stripNamespace(String(schema.name || "UnnamedEntity"));

  const avroFields = schema.fields;
  if (!Array.isArray(avroFields)) {
    return err({
      code: "PARSE_ERROR",
      message: "Avro schema has no fields array",
      suggestedFix: "Ensure the Avro schema has a top-level fields array.",
    });
  }

  const parsedFields: ParsedField[] = avroFields.map((f: Record<string, unknown>) => {
    const resolved = resolveAvroType(f.type);
    return {
      name: String(f.name),
      type: resolved.type,
      nullable: resolved.nullable,
      description: f.doc ? String(f.doc) : undefined,
      confidence: resolved.confidence,
      originalType: resolved.originalType,
    };
  });

  return ok({
    name: entityName,
    fields: parsedFields,
    sourceFormat: "avro",
    originalContent: content,
  });
}
