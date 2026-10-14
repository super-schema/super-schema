/**
 * JSON Schema Importer — parses a JSON Schema document into entities.
 *
 * Reverse of the JSON Schema emission path: maps JSON Schema types + formats
 * back to SuperSchemaModel LogicalType values. This is the landing point for
 * the schema-onboarding flow:
 *
 *   paste sample JSON / paste JSON Schema / visual build (jsonjoy-builder)
 *     → JsonSchema document (JSON or YAML)
 *     → parseJsonSchemaDocument()   (this file)
 *     → entities + enums
 *     → review screen
 *     → createDomainAssetsFromImportAction → SuperSchemaModel → emitters
 *
 * Handles:
 * - Primitive types (string, integer, number, boolean) with format refinement
 * - Nullable via `required` membership and `type: [..., "null"]` unions
 * - String formats (date, date-time, time, duration, uri, uuid, email, ...)
 * - Validation constraints (minLength/maxLength/pattern/minimum/maximum/items)
 * - Inline enum / const
 * - `$defs` / `definitions`: object entries become entities (named by their
 *   key, which is what `$ref` points at), enum entries become shared enums,
 *   any other entry is inlined into the fields that reference it
 * - `$ref` → `reference` to the defined entity (`#` → the root entity); an
 *   unresolved `$ref` stays a low-confidence reference by name (an entity
 *   that already exists in the catalog, as the visual builder emits)
 * - Arrays (element type / element reference), combinators (lower confidence)
 *
 * Inline nested objects (not `$ref`) are NOT expanded into child entities —
 * they map to the `object` logical type, flagged low confidence.
 *
 * `parseJsonSchema()` keeps the single-entity contract: the root entity.
 */

import { parse as parseYaml } from "yaml";
import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import type {
  ParsedEntity,
  ParsedEnum,
  ParsedField,
  ParsedFieldConstraint,
  ImportConfidence,
  MultiEntityImportResult,
} from "./types";

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
  referencedEntityName?: string;
  enumName?: string;
  enumValues?: string[];
}

/** One `$defs` / `definitions` entry, keyed by its local JSON pointer. */
interface DefinitionEntry {
  key: string;
  node: JsonSchemaNode;
  kind: "entity" | "enum" | "inline";
  /** Asset name (entities / enums) — the key, made unique against the root entity. */
  assetName: string;
}

interface ResolveContext {
  definitions: Map<string, DefinitionEntry>;
  /** Root entity name when the document root is itself an object schema (target of `$ref: "#"`). */
  rootEntityName?: string;
  /** Guards `$ref` chains through inline definitions. */
  depth: number;
}

const MAX_REF_DEPTH = 16;

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

function resolveRef(ref: string, ctx: ResolveContext): ResolvedType {
  if ((ref === "#" || ref === "") && ctx.rootEntityName) {
    return {
      type: "reference",
      confidence: "high",
      nullable: false,
      originalType: ref,
      referencedEntityName: ctx.rootEntityName,
    };
  }

  const def = ctx.definitions.get(ref);
  if (def?.kind === "entity") {
    return {
      type: "reference",
      confidence: "high",
      nullable: false,
      originalType: ref,
      referencedEntityName: def.assetName,
    };
  }
  if (def?.kind === "enum") {
    const values = (def.node.enum ?? []).filter((v) => v !== null).map(String);
    return {
      type: "enum",
      confidence: "high",
      nullable: (def.node.enum ?? []).includes(null),
      originalType: ref,
      enumName: def.assetName,
      enumValues: values,
    };
  }
  if (def?.kind === "inline" && ctx.depth < MAX_REF_DEPTH) {
    return resolveSchemaType(def.node, { ...ctx, depth: ctx.depth + 1 });
  }

  // Not defined in this document: a reference by name to an entity that must
  // already exist (the visual builder emits `#/$defs/<Existing>`).
  return {
    type: "reference",
    confidence: "low",
    nullable: false,
    originalType: ref,
    referencedEntityName: refToEntityName(ref),
  };
}

function resolveSchemaType(node: JsonSchemaNode, ctx: ResolveContext): ResolvedType {
  if (typeof node.$ref === "string") {
    return resolveRef(node.$ref, ctx);
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
    const symbols = node.enum.filter((v) => v !== null);
    return {
      type: "enum",
      confidence: "high",
      nullable: hasNull,
      originalType: `enum(${node.enum.map((v) => JSON.stringify(v)).join(",")})`,
      ...(symbols.every((v) => typeof v === "string") ? { enumValues: symbols as string[] } : {}),
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
    const first = resolveSchemaType(members[0], ctx);
    const keyword = node.oneOf ? "oneOf" : node.anyOf ? "anyOf" : "allOf";
    return {
      ...first,
      confidence: members.length === 1 ? first.confidence : "low",
      nullable: hasNull || first.nullable,
      originalType: `${keyword}(${members.length})`,
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
// Document structure: definitions + per-object field mapping
// ---------------------------------------------------------------------------

function isObjectSchema(node: JsonSchemaNode): boolean {
  const { base } = normalizeType(node.type);
  if (base === "object") return true;
  return base === undefined && !!node.properties && typeof node.properties === "object";
}

function hasProperties(node: JsonSchemaNode): boolean {
  return !!node.properties && typeof node.properties === "object" && Object.keys(node.properties).length > 0;
}

/** Index root-level `$defs` and `definitions` by the local pointer `$ref` uses. */
function indexDefinitions(schema: JsonSchemaNode, rootEntityName: string | undefined): Map<string, DefinitionEntry> {
  const definitions = new Map<string, DefinitionEntry>();
  const taken = new Set(rootEntityName ? [rootEntityName] : []);

  for (const keyword of ["$defs", "definitions"] as const) {
    const defs = schema[keyword];
    if (!defs || typeof defs !== "object" || Array.isArray(defs)) continue;

    for (const [key, raw] of Object.entries(defs as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object") continue;
      const node = raw as JsonSchemaNode;
      const kind: DefinitionEntry["kind"] = isObjectSchema(node)
        ? "entity"
        : Array.isArray(node.enum) && typeof node.$ref !== "string"
          ? "enum"
          : "inline";

      let assetName = key;
      if (kind !== "inline") {
        for (let n = 2; taken.has(assetName); n++) assetName = `${key}_${n}`;
        taken.add(assetName);
      }
      definitions.set(`#/${keyword}/${key}`, { key, node, kind, assetName });
    }
  }
  return definitions;
}

function buildFields(objectNode: JsonSchemaNode, ctx: ResolveContext): ParsedField[] {
  const properties = (objectNode.properties ?? {}) as Record<string, unknown>;
  const requiredSet = new Set(Array.isArray(objectNode.required) ? objectNode.required : []);

  return Object.entries(properties).map(([name, propNode]) => {
    const node = (propNode && typeof propNode === "object" ? propNode : {}) as JsonSchemaNode;
    const resolved = resolveSchemaType(node, ctx);
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

    if (resolved.referencedEntityName) field.referencedEntityName = resolved.referencedEntityName;
    if (resolved.enumName) field.enumName = resolved.enumName;
    if (resolved.enumValues) field.enumValues = resolved.enumValues;

    // Array element type (+ reference / enum target of the element).
    if (resolved.type === "array" && node.items && !Array.isArray(node.items)) {
      const item = resolveSchemaType(node.items as JsonSchemaNode, ctx);
      field.arrayElementType = item.type;
      if (item.referencedEntityName) field.referencedEntityName = item.referencedEntityName;
      if (item.enumName) field.enumName = item.enumName;
      if (item.enumValues) field.enumValues = item.enumValues;
      if (item.type === "reference" || item.type === "enum") field.confidence = item.confidence;
    }

    return field;
  });
}

/** JSON first; anything that is not JSON-shaped is tried as YAML (JSON Schema is often authored in YAML). */
function parseStructured(content: string): JsonSchemaNode | null {
  try {
    return JSON.parse(content);
  } catch {
    const trimmed = content.trim();
    if (!trimmed || trimmed.startsWith("{") || trimmed.startsWith("[")) return null;
    try {
      return parseYaml(trimmed) as JsonSchemaNode;
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function parseJsonSchemaDocument(content: string): Result<MultiEntityImportResult> {
  const schema = parseStructured(content);
  if (schema === null) {
    return err({
      code: "PARSE_ERROR",
      message: "Invalid JSON: could not parse JSON Schema",
      suggestedFix: "Ensure the content is a valid JSON Schema document (JSON or YAML).",
    });
  }

  if (typeof schema !== "object" || Array.isArray(schema)) {
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

  const rootIsEntity = hasProperties(schema);
  const rootEntityName = rootIsEntity ? deriveEntityName(schema) : undefined;
  const definitions = indexDefinitions(schema, rootEntityName);
  const ctx: ResolveContext = { definitions, rootEntityName, depth: 0 };

  const entities: ParsedEntity[] = [];
  if (rootIsEntity && rootEntityName) {
    entities.push({
      name: rootEntityName,
      description: typeof schema.description === "string" ? schema.description : undefined,
      fields: buildFields(schema, ctx),
      sourceFormat: "json-schema",
      originalContent: content,
    });
  }

  const enums: ParsedEnum[] = [];
  for (const def of definitions.values()) {
    if (def.kind === "entity") {
      entities.push({
        name: def.assetName,
        description: typeof def.node.description === "string" ? def.node.description : undefined,
        fields: buildFields(def.node, ctx),
        sourceFormat: "json-schema",
        originalContent: content,
      });
    } else if (def.kind === "enum") {
      const parsedEnum: ParsedEnum = {
        name: def.assetName,
        values: (def.node.enum ?? []).filter((v) => v !== null).map(String),
      };
      if (typeof def.node.description === "string") parsedEnum.description = def.node.description;
      enums.push(parsedEnum);
    }
  }

  if (entities.length === 0) {
    return err({
      code: "PARSE_ERROR",
      message: "JSON Schema has no properties to import",
      suggestedFix: 'Provide an object schema with a non-empty "properties" map (at the root or in "$defs").',
    });
  }

  const warnings: string[] = [];
  for (const def of definitions.values()) {
    if (def.kind !== "inline" && def.assetName !== def.key) {
      warnings.push(`Definition "${def.key}" clashes with the root entity name — imported as "${def.assetName}".`);
    }
  }

  return ok({ sourceFormat: "json-schema", entities, enums, scalars: [], warnings });
}

export function parseJsonSchema(content: string): Result<ParsedEntity> {
  const doc = parseJsonSchemaDocument(content);
  if (!doc.success) return doc;
  return ok(doc.data.entities[0]);
}
