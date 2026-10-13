/**
 * JSON Schema Importer — parses a JSON Schema document into a ParsedEntity.
 *
 * Reverse of the JSON Schema emission path: maps JSON Schema types + formats
 * back to SuperSchemaModel LogicalType values. This is the landing point for
 * the schema-onboarding flow:
 *
 *   paste sample JSON / paste JSON Schema / visual build (jsonjoy-builder)
 *     → JsonSchema document
 *     → parseJsonSchema()        (this file)
 *     → ParsedEntity
 *     → ImportReviewScreen
 *     → createDomainAssetsFromImportAction → SuperSchemaModel → emitters
 *
 * Handles:
 * - Primitive types (string, integer, number, boolean) with format refinement
 * - Nullable via `required` membership and `type: [..., "null"]` unions
 * - String formats (date, date-time, time, duration, uri, uuid, email, ...)
 * - Validation constraints (minLength/maxLength/pattern/minimum/maximum/items)
 * - Inline enum / const
 * - Arrays, nested objects, $ref, combinators (flagged lower confidence)
 *
 * Nested objects and arrays-of-objects are NOT expanded into child entities in
 * this version — they map to the `object` / `array` logical types and are
 * flagged low/medium confidence for the user to refine in the review screen.
 */

import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import type { ParsedEntity, ParsedField, ParsedFieldConstraint, ImportConfidence } from "./types";

// ---------------------------------------------------------------------------
// Minimal JSON Schema shape (we only read the keywords we map)
// ---------------------------------------------------------------------------

interface JsonSchemaNode {
  $schema?: string;
  $id?: string;
  $ref?: string;
  title?: string;
  description?: string;
  type?: string | string[];
  format?: string;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  items?: JsonSchemaNode | JsonSchemaNode[];
  enum?: unknown[];
  const?: unknown;
  deprecated?: boolean;
  default?: unknown;
  oneOf?: JsonSchemaNode[];
  anyOf?: JsonSchemaNode[];
  allOf?: JsonSchemaNode[];
  // validation
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minItems?: number;
  maxItems?: number;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// JSON Schema string `format` → logical type (high-confidence refinements)
// ---------------------------------------------------------------------------

const STRING_FORMAT_MAP: Record<string, { type: string; confidence: ImportConfidence; keepFormat?: boolean }> = {
  date: { type: "plainDate", confidence: "high" },
  time: { type: "plainTime", confidence: "high" },
  "date-time": { type: "utcDateTime", confidence: "high" },
  duration: { type: "duration", confidence: "high" },
  uri: { type: "url", confidence: "high" },
  url: { type: "url", confidence: "high" },
  "uri-reference": { type: "url", confidence: "medium" },
  iri: { type: "url", confidence: "medium" },
  // Formats with no dedicated logical type — stay `string`, keep the format hint
  uuid: { type: "string", confidence: "high", keepFormat: true },
  email: { type: "string", confidence: "high", keepFormat: true },
  "idn-email": { type: "string", confidence: "medium", keepFormat: true },
  hostname: { type: "string", confidence: "high", keepFormat: true },
  ipv4: { type: "string", confidence: "high", keepFormat: true },
  ipv6: { type: "string", confidence: "high", keepFormat: true },
  byte: { type: "bytes", confidence: "medium" },
  binary: { type: "bytes", confidence: "medium" },
};

// JSON Schema numeric `format` → logical type
const INTEGER_FORMAT_MAP: Record<string, { type: string; confidence: ImportConfidence }> = {
  int8: { type: "int8", confidence: "high" },
  int16: { type: "int16", confidence: "high" },
  int32: { type: "int32", confidence: "high" },
  int64: { type: "int64", confidence: "high" },
  uint8: { type: "uint8", confidence: "high" },
  uint16: { type: "uint16", confidence: "high" },
  uint32: { type: "uint32", confidence: "high" },
  uint64: { type: "uint64", confidence: "high" },
  "unix-timestamp": { type: "unixTimestamp32", confidence: "medium" },
};

const NUMBER_FORMAT_MAP: Record<string, { type: string; confidence: ImportConfidence }> = {
  float: { type: "float32", confidence: "high" },
  float32: { type: "float32", confidence: "high" },
  double: { type: "float64", confidence: "high" },
  float64: { type: "float64", confidence: "high" },
  decimal: { type: "decimal", confidence: "high" },
};

// ---------------------------------------------------------------------------
// Resolve a property node → logical type + metadata
// ---------------------------------------------------------------------------

interface ResolvedType {
  type: string;
  confidence: ImportConfidence;
  nullable: boolean;
  originalType: string;
  format?: string;
}

/** Split a `type` keyword into its non-null base + whether "null" was present. */
function normalizeType(type: string | string[] | undefined): {
  base: string | undefined;
  nullableFromType: boolean;
} {
  if (Array.isArray(type)) {
    const nonNull = type.filter((t) => t !== "null");
    return {
      base: nonNull[0],
      nullableFromType: type.includes("null"),
    };
  }
  return { base: type, nullableFromType: false };
}

function resolveSchemaType(node: JsonSchemaNode): ResolvedType {
  // $ref → reference to another entity (not resolved in v1)
  if (typeof node.$ref === "string") {
    return {
      type: "reference",
      confidence: "low",
      nullable: false,
      originalType: node.$ref,
    };
  }

  // const → treat as a fixed single-value enum of the const's primitive type
  if (node.const !== undefined) {
    return {
      type: "enum",
      confidence: "medium",
      nullable: node.const === null,
      originalType: `const(${JSON.stringify(node.const)})`,
    };
  }

  // enum → logical enum
  if (Array.isArray(node.enum)) {
    const hasNull = node.enum.includes(null);
    return {
      type: "enum",
      confidence: "high",
      nullable: hasNull,
      originalType: `enum(${node.enum.map((v) => JSON.stringify(v)).join(",")})`,
    };
  }

  // Combinators → take the first non-null member, medium/low confidence
  const combinator = node.oneOf ?? node.anyOf ?? node.allOf;
  if (Array.isArray(combinator) && combinator.length > 0) {
    const nonNull = combinator.filter(
      (m) => !(m && normalizeType(m.type).base === undefined && normalizeType(m.type).nullableFromType) && normalizeType(m.type).base !== "null"
    );
    const members = nonNull.length > 0 ? nonNull : combinator;
    const hasNull = combinator.some((m) => normalizeType(m.type).base === "null" || normalizeType(m.type).nullableFromType);
    const first = resolveSchemaType(members[0]);
    const keyword = node.oneOf ? "oneOf" : node.anyOf ? "anyOf" : "allOf";
    return {
      type: first.type,
      confidence: members.length === 1 ? first.confidence : "low",
      nullable: hasNull || first.nullable,
      originalType: `${keyword}(${members.length})`,
      format: first.format,
    };
  }

  const { base, nullableFromType } = normalizeType(node.type);

  switch (base) {
    case "string": {
      const fmt = node.format ? STRING_FORMAT_MAP[node.format] : undefined;
      if (fmt) {
        return {
          type: fmt.type,
          confidence: fmt.confidence,
          nullable: nullableFromType,
          originalType: `string/${node.format}`,
          format: fmt.keepFormat ? node.format : undefined,
        };
      }
      return {
        type: "string",
        confidence: "high",
        nullable: nullableFromType,
        originalType: node.format ? `string/${node.format}` : "string",
        format: node.format,
      };
    }
    case "integer": {
      const fmt = node.format ? INTEGER_FORMAT_MAP[node.format] : undefined;
      return {
        type: fmt?.type ?? "integer",
        confidence: fmt?.confidence ?? "high",
        nullable: nullableFromType,
        originalType: node.format ? `integer/${node.format}` : "integer",
      };
    }
    case "number": {
      const fmt = node.format ? NUMBER_FORMAT_MAP[node.format] : undefined;
      return {
        type: fmt?.type ?? "float64",
        confidence: fmt ? fmt.confidence : "medium",
        nullable: nullableFromType,
        originalType: node.format ? `number/${node.format}` : "number",
      };
    }
    case "boolean":
      return { type: "boolean", confidence: "high", nullable: nullableFromType, originalType: "boolean" };
    case "array":
      return { type: "array", confidence: "medium", nullable: nullableFromType, originalType: "array" };
    case "object":
      return { type: "object", confidence: "low", nullable: nullableFromType, originalType: "object" };
    case "null":
      return { type: "string", confidence: "low", nullable: true, originalType: "null" };
    default:
      // No `type` keyword but has properties → treat as nested object
      if (node.properties) {
        return { type: "object", confidence: "low", nullable: nullableFromType, originalType: "object" };
      }
      return { type: "string", confidence: "low", nullable: nullableFromType, originalType: "unknown" };
  }
}

// ---------------------------------------------------------------------------
// Extract validation constraints into ParsedField shape
// ---------------------------------------------------------------------------

function extractConstraints(node: JsonSchemaNode): {
  constraints: ParsedFieldConstraint[];
  minValueExclusive?: number;
  maxValueExclusive?: number;
} {
  const constraints: ParsedFieldConstraint[] = [];
  // Keys below map 1:1 onto ValidationDecorators via buildDecoratorsFromParsedField.
  if (typeof node.minLength === "number") constraints.push({ type: "minLength", value: node.minLength });
  if (typeof node.maxLength === "number") constraints.push({ type: "maxLength", value: node.maxLength });
  if (typeof node.pattern === "string") constraints.push({ type: "pattern", value: node.pattern });
  if (typeof node.minimum === "number") constraints.push({ type: "minValue", value: node.minimum });
  if (typeof node.maximum === "number") constraints.push({ type: "maxValue", value: node.maximum });
  if (typeof node.minItems === "number") constraints.push({ type: "minItems", value: node.minItems });
  if (typeof node.maxItems === "number") constraints.push({ type: "maxItems", value: node.maxItems });

  return {
    constraints,
    minValueExclusive: typeof node.exclusiveMinimum === "number" ? node.exclusiveMinimum : undefined,
    maxValueExclusive: typeof node.exclusiveMaximum === "number" ? node.exclusiveMaximum : undefined,
  };
}

/** "#/$defs/Customer" → "Customer"; "https://x/Order.json" → "Order"; "Card" → "Card". */
function refToEntityName(ref: string): string {
  const last = ref.split(/[/#]/).filter(Boolean).pop() ?? ref;
  return last.replace(/\.(schema\.json|json)$/i, "");
}

function deriveEntityName(schema: JsonSchemaNode): string {
  if (typeof schema.title === "string" && schema.title.trim()) {
    return schema.title.trim();
  }
  if (typeof schema.$id === "string" && schema.$id.trim()) {
    // "https://example.com/schemas/user.json" → "user"
    const last = schema.$id.split(/[/#]/).filter(Boolean).pop() ?? "";
    const stripped = last.replace(/\.(json|schema\.json)$/i, "");
    if (stripped) return stripped;
  }
  return "ImportedEntity";
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function parseJsonSchema(content: string): Result<ParsedEntity> {
  let schema: JsonSchemaNode;
  try {
    schema = JSON.parse(content);
  } catch {
    return err({
      code: "PARSE_ERROR",
      message: "Invalid JSON: could not parse JSON Schema",
      suggestedFix: "Ensure the content is a valid JSON Schema document.",
    });
  }

  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return err({
      code: "PARSE_ERROR",
      message: "Expected a JSON Schema object at the top level",
      suggestedFix: 'The root must be an object with a "properties" map (an object schema).',
    });
  }

  const { base: rootBase } = normalizeType(schema.type);

  if (rootBase === "array") {
    return err({
      code: "PARSE_ERROR",
      message: "Array-root JSON Schemas are not supported for entity import",
      suggestedFix: "Wrap the item schema in an object, or import the element schema directly.",
    });
  }

  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Object.keys(properties).length === 0) {
    return err({
      code: "PARSE_ERROR",
      message: "JSON Schema has no properties to import",
      suggestedFix: 'Provide an object schema with a non-empty "properties" map.',
    });
  }

  const requiredSet = new Set(Array.isArray(schema.required) ? schema.required : []);

  const parsedFields: ParsedField[] = Object.entries(properties).map(([name, propNode]) => {
    const node = (propNode && typeof propNode === "object" ? propNode : {}) as JsonSchemaNode;
    const resolved = resolveSchemaType(node);
    const isRequired = requiredSet.has(name);
    // nullable = optional (not in required) OR explicitly `type: [..., "null"]`.
    const nullable = resolved.nullable || !isRequired;

    const { constraints, minValueExclusive, maxValueExclusive } = extractConstraints(node);

    const field: ParsedField = {
      name,
      type: resolved.type,
      nullable,
      description: typeof node.description === "string" ? node.description : undefined,
      confidence: resolved.confidence,
      originalType: resolved.originalType,
      // Heuristic: a required property literally named "id" is the key.
      isKey: isRequired && name === "id",
      format: resolved.format,
      deprecated: node.deprecated === true || undefined,
      constraints: constraints.length > 0 ? constraints : undefined,
      minValueExclusive,
      maxValueExclusive,
    };

    // Link a reference field to its target entity (from the $ref).
    if (resolved.type === "reference" && typeof node.$ref === "string") {
      field.referencedEntityName = refToEntityName(node.$ref);
    }

    // Array element type (+ reference target when items is a $ref).
    if (resolved.type === "array" && node.items && !Array.isArray(node.items)) {
      const itemNode = node.items as JsonSchemaNode;
      if (typeof itemNode.$ref === "string") {
        field.arrayElementType = "reference";
        field.referencedEntityName = refToEntityName(itemNode.$ref);
      } else {
        field.arrayElementType = resolveSchemaType(itemNode).type;
      }
    }

    return field;
  });

  return ok({
    name: deriveEntityName(schema),
    description: typeof schema.description === "string" ? schema.description : undefined,
    fields: parsedFields,
    sourceFormat: "json-schema",
    originalContent: content,
  });
}
