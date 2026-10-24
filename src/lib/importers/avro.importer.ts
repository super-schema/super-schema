/**
 * Avro Schema Importer — parses an Avro JSON schema into entities.
 *
 * Reverse of the Avro emitter: maps Avro types back to logical types.
 *
 * `parseAvroDocument()` returns every named type the schema defines:
 * - each named `record` (root and nested) → entity; a field of that type →
 *   `reference` with `referencedEntityName`
 * - each named `enum` → shared enum; fields → `enum` with `enumName` + `enumValues`
 * - each named `fixed` → custom scalar (`bytes`); fields → `bytes` with
 *   `governance.avroFixedSize`
 * A named type is defined once (its first, inline occurrence); later uses by
 * full name (`com.shop.Address`) or by short name within the namespace resolve
 * to that definition. Entities take the short name; a short name already taken
 * by a type from another namespace falls back to the underscore-joined full name.
 *
 * Also handles primitives, nullable unions (["null", T]), logical types
 * (date, time, timestamp, decimal, duration, uuid), arrays (element type),
 * maps (value type), doc → description.
 *
 * `parseAvroSchema()` keeps the single-entity contract: the root record.
 */

import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import { pickRootEntity } from "./multi-asset";
import { declaredDecimalFacts } from "./decimal-facts";
import type {
  ParsedEntity,
  ParsedField,
  ParsedEnum,
  ParsedScalar,
  ParsedFieldGovernance,
  ImportConfidence,
  MultiEntityImportResult,
} from "./types";

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
// Resolution state
// ---------------------------------------------------------------------------

interface ResolvedType {
  type: string;
  confidence: ImportConfidence;
  nullable: boolean;
  originalType: string;
  referencedEntityName?: string;
  enumName?: string;
  enumValues?: string[];
  arrayElementType?: string;
  mapKeyType?: string;
  mapValueType?: string;
  governance?: ParsedFieldGovernance;
  /** A decimal's declared precision and scale. */
  precision?: number;
  scale?: number;
}

type NamedDefinition =
  | { kind: "record"; fullName: string; assetName: string }
  | { kind: "enum"; fullName: string; assetName: string; values: string[] }
  | { kind: "fixed"; fullName: string; assetName: string; resolved: ResolvedType };

interface AvroContext {
  content: string;
  named: Map<string, NamedDefinition>;
  usedAssetNames: Set<string>;
  entities: ParsedEntity[];
  enums: ParsedEnum[];
  scalars: ParsedScalar[];
  warnings: string[];
  /** Current nesting of `resolveAvroType` (types inside types inside …); see {@link MAX_AVRO_NESTING}. */
  depth: number;
}

/** Real schemas nest a handful of levels; past this a document is hostile (the engine's stack is the limit). */
export const MAX_AVRO_NESTING = 200;

type AvroObject = Record<string, unknown>;

/** Avro name resolution: a dotted name is a full name; otherwise it joins the namespace. */
function qualify(name: string, explicitNamespace: unknown, enclosingNamespace: string | undefined) {
  if (name.includes(".")) {
    return { fullName: name, namespace: name.slice(0, name.lastIndexOf(".")), shortName: stripNamespace(name) };
  }
  const namespace =
    typeof explicitNamespace === "string" ? explicitNamespace || undefined : enclosingNamespace;
  return { fullName: namespace ? `${namespace}.${name}` : name, namespace, shortName: name };
}

function stripNamespace(name: string): string {
  const parts = name.split(".");
  return parts[parts.length - 1];
}

function claimAssetName(ctx: AvroContext, shortName: string, fullName: string): string {
  if (!ctx.usedAssetNames.has(shortName)) {
    ctx.usedAssetNames.add(shortName);
    return shortName;
  }
  let candidate = fullName.replace(/\./g, "_");
  for (let n = 2; ctx.usedAssetNames.has(candidate); n++) candidate = `${fullName.replace(/\./g, "_")}_${n}`;
  ctx.usedAssetNames.add(candidate);
  ctx.warnings.push(
    `"${fullName}" shares its short name with another named type — imported as "${candidate}".`
  );
  return candidate;
}

function lookupNamed(ctx: AvroContext, name: string, namespace: string | undefined): NamedDefinition | undefined {
  if (name.includes(".")) return ctx.named.get(name);
  return (namespace ? ctx.named.get(`${namespace}.${name}`) : undefined) ?? ctx.named.get(name);
}

/** Field-level view of a named type used by name (or right after its definition). */
function resolveNamed(def: NamedDefinition): ResolvedType {
  switch (def.kind) {
    case "record":
      return {
        type: "reference",
        confidence: "high",
        nullable: false,
        originalType: `record(${def.fullName})`,
        referencedEntityName: def.assetName,
      };
    case "enum":
      return {
        type: "enum",
        confidence: "high",
        nullable: false,
        originalType: `enum(${def.values.join(",")})`,
        enumName: def.assetName,
        enumValues: def.values,
      };
    case "fixed":
      return { ...def.resolved };
  }
}

// ---------------------------------------------------------------------------
// Named type definitions
// ---------------------------------------------------------------------------

function existingDefinition(ctx: AvroContext, fullName: string): NamedDefinition | undefined {
  const existing = ctx.named.get(fullName);
  if (existing) {
    ctx.warnings.push(`Named type "${fullName}" is defined more than once — the first definition is used.`);
  }
  return existing;
}

function defineRecord(obj: AvroObject, enclosingNamespace: string | undefined, ctx: AvroContext): NamedDefinition {
  const { fullName, namespace, shortName } = qualify(String(obj.name || "UnnamedRecord"), obj.namespace, enclosingNamespace);
  const existing = existingDefinition(ctx, fullName);
  if (existing) return existing;

  const def: NamedDefinition = { kind: "record", fullName, assetName: claimAssetName(ctx, shortName, fullName) };
  // Register before walking fields so a record can reference itself.
  ctx.named.set(fullName, def);

  const entity: ParsedEntity = {
    name: def.assetName,
    fields: [],
    sourceFormat: "avro",
    originalContent: ctx.content,
  };
  if (typeof obj.doc === "string" && obj.doc) entity.description = obj.doc;
  ctx.entities.push(entity); // pre-order: a record precedes the records it nests

  const avroFields = Array.isArray(obj.fields) ? (obj.fields as unknown[]) : [];
  const fields: ParsedField[] = [];
  avroFields.forEach((f, index) => {
    // `"fields": [null]`, a bare string, or a field with no name is malformed — skip it, don't crash the import.
    if (typeof f !== "object" || f === null || Array.isArray(f) || typeof (f as AvroObject).name !== "string") {
      ctx.warnings.push(`Record "${def.assetName}": field #${index + 1} is not a field definition (needs a "name") — skipped.`);
      return;
    }
    const field = f as AvroObject;
    fields.push(mapField(field, namespace, ctx, `${def.assetName}.${String(field.name)}`));
  });
  entity.fields = fields;
  return def;
}

function defineEnum(obj: AvroObject, enclosingNamespace: string | undefined, ctx: AvroContext): NamedDefinition {
  const { fullName, shortName } = qualify(String(obj.name || "UnnamedEnum"), obj.namespace, enclosingNamespace);
  const existing = existingDefinition(ctx, fullName);
  if (existing) return existing;

  const values = Array.isArray(obj.symbols) ? (obj.symbols as unknown[]).map(String) : [];
  const def: NamedDefinition = { kind: "enum", fullName, assetName: claimAssetName(ctx, shortName, fullName), values };
  ctx.named.set(fullName, def);

  const parsedEnum: ParsedEnum = { name: def.assetName, values };
  if (typeof obj.doc === "string" && obj.doc) parsedEnum.description = obj.doc;
  ctx.enums.push(parsedEnum);
  return def;
}

function defineFixed(obj: AvroObject, enclosingNamespace: string | undefined, ctx: AvroContext): NamedDefinition {
  const { fullName, shortName } = qualify(String(obj.name || "UnnamedFixed"), obj.namespace, enclosingNamespace);
  const existing = existingDefinition(ctx, fullName);
  if (existing) return existing;

  const size = Number(obj.size);
  // A fixed carrying a logical type (duration, decimal) maps to that type.
  const resolved: ResolvedType = obj.logicalType
    ? resolveLogicalType(obj, ctx, `fixed type "${fullName}"`)
    : {
        type: "bytes",
        confidence: "high",
        nullable: false,
        originalType: `fixed(${shortName},${obj.size})`,
        ...(Number.isFinite(size) ? { governance: { avroFixedSize: size } } : {}),
      };

  const def: NamedDefinition = { kind: "fixed", fullName, assetName: claimAssetName(ctx, shortName, fullName), resolved };
  ctx.named.set(fullName, def);

  const scalar: ParsedScalar = { name: def.assetName, baseType: "bytes" };
  scalar.description =
    typeof obj.doc === "string" && obj.doc ? obj.doc : `Avro fixed (${obj.size} bytes)`;
  ctx.scalars.push(scalar);
  return def;
}

// ---------------------------------------------------------------------------
// Parse an Avro type to logical type
// ---------------------------------------------------------------------------

function resolveAvroType(
  avroType: unknown,
  namespace: string | undefined,
  ctx: AvroContext,
  label: string
): ResolvedType {
  if (ctx.depth >= MAX_AVRO_NESTING) {
    ctx.warnings.push(`Field "${label}": the type is nested more than ${MAX_AVRO_NESTING} levels deep — imported as string.`);
    return { type: "string", confidence: "low", nullable: false, originalType: "nested too deeply" };
  }
  ctx.depth++;
  try {
    return resolveAvroTypeAt(avroType, namespace, ctx, label);
  } finally {
    ctx.depth--;
  }
}

function resolveAvroTypeAt(
  avroType: unknown,
  namespace: string | undefined,
  ctx: AvroContext,
  label: string
): ResolvedType {
  // String: primitive or a named type used by name
  if (typeof avroType === "string") {
    const mapped = AVRO_PRIMITIVE_MAP[avroType];
    if (mapped) {
      return { type: mapped.type, confidence: mapped.confidence, nullable: false, originalType: avroType };
    }
    const def = lookupNamed(ctx, avroType, namespace);
    if (def) return resolveNamed(def);

    const shortName = stripNamespace(avroType);
    ctx.warnings.push(
      `Field "${label}": named type "${avroType}" is not defined in this schema — imported as a reference to "${shortName}".`
    );
    return {
      type: "reference",
      confidence: "low",
      nullable: false,
      originalType: avroType,
      referencedEntityName: shortName,
    };
  }

  // Array = union type
  if (Array.isArray(avroType)) {
    const nonNull = avroType.filter(
      (t) => t !== "null" && !(typeof t === "object" && t !== null && (t as AvroObject).type === "null")
    );
    const hasNull = avroType.length !== nonNull.length;
    // Resolve every member so inline named types in any branch get defined.
    const members = nonNull.map((member) => resolveAvroType(member, namespace, ctx, label));

    if (members.length === 1) {
      return { ...members[0], nullable: hasNull || members[0].nullable };
    }

    // Multi-type union (not just null + one type) → medium confidence
    if (members.length > 1) {
      return {
        ...members[0],
        confidence: "medium",
        nullable: hasNull,
        originalType: JSON.stringify(avroType),
      };
    }

    // Only null
    return { type: "string", confidence: "low", nullable: true, originalType: "null" };
  }

  // Object type (logical types, records, arrays, maps, enums, fixed)
  if (typeof avroType === "object" && avroType !== null) {
    const obj = avroType as AvroObject;

    if (obj.type === "fixed" && typeof obj.name === "string") {
      return resolveNamed(defineFixed(obj, namespace, ctx));
    }

    // Logical types
    if (obj.logicalType) {
      return resolveLogicalType(obj, ctx, `field "${label}"`);
    }

    if (obj.type === "enum") {
      return resolveNamed(defineEnum(obj, namespace, ctx));
    }

    if (obj.type === "record") {
      return resolveNamed(defineRecord(obj, namespace, ctx));
    }

    if (obj.type === "array") {
      const items = resolveAvroType(obj.items, namespace, ctx, label);
      return {
        type: "array",
        confidence: items.confidence,
        nullable: false,
        originalType: "array",
        arrayElementType: items.type,
        ...pickTargets(items),
      };
    }

    if (obj.type === "map") {
      const values = resolveAvroType(obj.values, namespace, ctx, label);
      return {
        type: "map",
        confidence: values.confidence,
        nullable: false,
        originalType: "map",
        mapKeyType: "string",
        mapValueType: values.type,
        ...pickTargets(values),
      };
    }

    // Fallback for other object types with a string `type`
    if (typeof obj.type === "string") {
      const mapped = AVRO_PRIMITIVE_MAP[obj.type];
      if (mapped) {
        return { type: mapped.type, confidence: mapped.confidence, nullable: false, originalType: obj.type };
      }
    }
  }

  return { type: "string", confidence: "low", nullable: false, originalType: String(avroType) };
}

/** Reference / enum targets of an array element or map value, lifted onto the field. */
function pickTargets(inner: ResolvedType): Partial<ResolvedType> {
  const targets: Partial<ResolvedType> = {};
  if (inner.referencedEntityName) targets.referencedEntityName = inner.referencedEntityName;
  if (inner.enumName) targets.enumName = inner.enumName;
  if (inner.enumValues) targets.enumValues = inner.enumValues;
  return targets;
}

// ---------------------------------------------------------------------------
// Resolve Avro logical types
// ---------------------------------------------------------------------------

/** A declared number or text for a message, cut short (an Avro document is untrusted text). */
function shown(value: unknown): string {
  const text = value === undefined ? "not given" : typeof value === "string" ? JSON.stringify(value) : String(value);
  return text.length > 24 ? `${text.slice(0, 24)}…` : text;
}

/** `what` names where the logical type is, for the warning of a decimal that is not kept (`field "Order.total"`). */
function resolveLogicalType(obj: AvroObject, ctx: AvroContext, what: string): ResolvedType {
  const logicalType = obj.logicalType as string;

  switch (logicalType) {
    case "date":
      return { type: "plainDate", confidence: "high", nullable: false, originalType: "int/date" };
    case "time-millis":
    case "time-micros":
      return { type: "plainTime", confidence: "high", nullable: false, originalType: `${obj.type}/${logicalType}` };
    case "timestamp-millis":
    case "timestamp-micros":
      return { type: "utcDateTime", confidence: "high", nullable: false, originalType: `long/${logicalType}` };
    case "decimal": {
      // The spec requires a `precision` (a positive whole number); `scale` defaults to 0. A pair the database cannot hold, or no decimal
      // can have, is not kept: a plain decimal, and the import says so.
      const facts = declaredDecimalFacts(obj.precision, obj.scale);
      if (!facts.ok) {
        ctx.warnings.push(`The ${what}: decimal ${facts.reason} (precision ${shown(obj.precision)}, scale ${shown(obj.scale)}) — imported as a plain decimal, without precision and scale.`);
      }
      return {
        type: "decimal",
        confidence: "high",
        nullable: false,
        originalType: `bytes/decimal(${obj.precision},${obj.scale})`,
        ...(facts.ok ? { precision: facts.precision, scale: facts.scale } : {}),
      };
    }
    case "duration":
      return { type: "duration", confidence: "high", nullable: false, originalType: "fixed/duration" };
    case "uuid":
      return { type: "string", confidence: "high", nullable: false, originalType: "string/uuid" };
    default:
      return { type: "string", confidence: "low", nullable: false, originalType: `${obj.type}/${logicalType}` };
  }
}

function mapField(f: AvroObject, namespace: string | undefined, ctx: AvroContext, label: string): ParsedField {
  const resolved = resolveAvroType(f.type, namespace, ctx, label);
  const field: ParsedField = {
    name: String(f.name),
    type: resolved.type,
    nullable: resolved.nullable,
    description: f.doc ? String(f.doc) : undefined,
    confidence: resolved.confidence,
    originalType: resolved.originalType,
  };
  if (resolved.referencedEntityName) field.referencedEntityName = resolved.referencedEntityName;
  if (resolved.enumName) field.enumName = resolved.enumName;
  if (resolved.enumValues) field.enumValues = resolved.enumValues;
  if (resolved.arrayElementType) field.arrayElementType = resolved.arrayElementType;
  if (resolved.mapKeyType) field.mapKeyType = resolved.mapKeyType;
  if (resolved.mapValueType) field.mapValueType = resolved.mapValueType;
  if (resolved.governance) field.governance = resolved.governance;
  if (resolved.precision !== undefined) field.precision = resolved.precision;
  if (resolved.scale !== undefined) field.scale = resolved.scale;
  return field;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Never throws (the `Result` contract): a leading BOM is ignored, and a document nested past the engine's stack
 * (or any other failure while mapping it) comes back as a `PARSE_ERROR`.
 */
export function parseAvroDocument(rawContent: string): Result<MultiEntityImportResult> {
  try {
    return importAvroDocument(rawContent.charCodeAt(0) === 0xfeff ? rawContent.slice(1) : rawContent);
  } catch (error) {
    return err({
      code: "PARSE_ERROR",
      message:
        error instanceof RangeError ? "Avro schema is nested too deeply to import" : "Could not import the Avro schema",
      suggestedFix: "Simplify the schema (flatten deeply nested types) or split it into named types.",
    });
  }
}

function importAvroDocument(content: string): Result<MultiEntityImportResult> {
  let schema: AvroObject;
  try {
    schema = JSON.parse(content);
  } catch {
    return err({
      code: "PARSE_ERROR",
      message: "Invalid JSON: could not parse Avro schema",
      suggestedFix: "Ensure the content is valid JSON.",
    });
  }

  if (!schema || typeof schema !== "object" || schema.type !== "record") {
    return err({
      code: "PARSE_ERROR",
      message: `Expected Avro schema type "record", got "${schema?.type}"`,
      suggestedFix: 'Ensure the Avro schema has "type": "record" at the top level.',
    });
  }

  if (!Array.isArray(schema.fields)) {
    return err({
      code: "PARSE_ERROR",
      message: "Avro schema has no fields array",
      suggestedFix: "Ensure the Avro schema has a top-level fields array.",
    });
  }

  const ctx: AvroContext = {
    content,
    named: new Map(),
    usedAssetNames: new Set(),
    entities: [],
    enums: [],
    scalars: [],
    warnings: [],
    depth: 0,
  };
  const root = defineRecord(schema, undefined, ctx);
  const rootNamespace = root.fullName.includes(".")
    ? root.fullName.slice(0, root.fullName.lastIndexOf("."))
    : undefined;

  return ok({
    sourceFormat: "avro",
    entities: ctx.entities,
    rootEntityName: root.assetName,
    enums: ctx.enums,
    scalars: ctx.scalars,
    ...(rootNamespace ? { namespace: rootNamespace } : {}),
    warnings: ctx.warnings,
  });
}

export function parseAvroSchema(content: string): Result<ParsedEntity> {
  const doc = parseAvroDocument(content);
  if (!doc.success) return doc;
  return ok(pickRootEntity(doc.data));
}
