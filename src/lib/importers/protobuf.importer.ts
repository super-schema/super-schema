/**
 * Protobuf (.proto) Importer — built on `protobufjs` (real parser, no regex).
 *
 * `parseProtobufDocument()` returns every asset the file defines:
 * - every top-level and nested `message` → entity. Nested messages are named
 *   by their nesting path joined with `_` (`Order.LineItem` → `Order_LineItem`),
 *   the protoc-gen-go convention: stable, a valid TypeSpec identifier, and it
 *   cannot clash with a PascalCase top-level name.
 * - every `enum` (top-level or nested, same naming) → shared enum; fields of
 *   that type become `enum` fields carrying `enumName` + `enumValues`.
 * - `oneof` membership → `governance.protobufOneofGroup` (the key the TypeSpec
 *   governance path already stores); proto3 `optional` synthetic oneofs are not groups.
 * - `map<K,V>` → `map` with `mapKeyType` / `mapValueType`.
 * - `repeated T` → `array` with `arrayElementType`.
 * - field numbers → `fieldNumber`.
 * - well-known types (`google.protobuf.Timestamp`, `Duration`, wrappers, …) →
 *   temporal / scalar logical types.
 * - message-typed fields → `reference` with `referencedEntityName`; a type the
 *   file does not define (from an unresolved import) stays a low-confidence
 *   reference by its simple name, with a warning.
 * - `service` / `rpc` are not imported (gRPC APIs need a protocol model) —
 *   reported as warnings, as are non-well-known imports.
 *
 * `parseProtobufSchema()` keeps the single-entity contract (drift detection,
 * bulk import, visual-builder round trip): the first top-level message.
 */

import { parse, Type, Enum, Service, MapField, type Namespace, type ReflectionObject, type Field } from "protobufjs";
import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import type {
  ParsedEntity,
  ParsedField,
  ParsedEnum,
  ImportConfidence,
  MultiEntityImportResult,
} from "./types";

// ---------------------------------------------------------------------------
// Protobuf → logical type mapping
// ---------------------------------------------------------------------------

interface Mapped {
  type: string;
  confidence: ImportConfidence;
}

const PROTO_SCALAR_MAP: Record<string, Mapped> = {
  string: { type: "string", confidence: "high" },
  int32: { type: "int32", confidence: "high" },
  int64: { type: "int64", confidence: "high" },
  sint32: { type: "int32", confidence: "high" },
  sint64: { type: "int64", confidence: "high" },
  uint32: { type: "uint32", confidence: "high" },
  uint64: { type: "uint64", confidence: "high" },
  fixed32: { type: "uint32", confidence: "medium" },
  fixed64: { type: "uint64", confidence: "medium" },
  sfixed32: { type: "int32", confidence: "medium" },
  sfixed64: { type: "int64", confidence: "medium" },
  float: { type: "float32", confidence: "high" },
  double: { type: "float64", confidence: "high" },
  bool: { type: "boolean", confidence: "high" },
  bytes: { type: "bytes", confidence: "high" },
};

/** Well-known types, keyed by fully-qualified name without the leading dot. */
const WELL_KNOWN_TYPE_MAP: Record<string, Mapped & { nullable?: boolean }> = {
  "google.protobuf.Timestamp": { type: "utcDateTime", confidence: "high" },
  "google.protobuf.Duration": { type: "duration", confidence: "high" },
  // Wrappers exist to make a scalar nullable.
  "google.protobuf.StringValue": { type: "string", confidence: "high", nullable: true },
  "google.protobuf.BytesValue": { type: "bytes", confidence: "high", nullable: true },
  "google.protobuf.BoolValue": { type: "boolean", confidence: "high", nullable: true },
  "google.protobuf.Int32Value": { type: "int32", confidence: "high", nullable: true },
  "google.protobuf.Int64Value": { type: "int64", confidence: "high", nullable: true },
  "google.protobuf.UInt32Value": { type: "uint32", confidence: "high", nullable: true },
  "google.protobuf.UInt64Value": { type: "uint64", confidence: "high", nullable: true },
  "google.protobuf.FloatValue": { type: "float32", confidence: "high", nullable: true },
  "google.protobuf.DoubleValue": { type: "float64", confidence: "high", nullable: true },
  // Dynamic values have no faithful logical type.
  "google.protobuf.Any": { type: "string", confidence: "low" },
  "google.protobuf.Struct": { type: "object", confidence: "low" },
  "google.protobuf.Value": { type: "string", confidence: "low" },
  "google.protobuf.ListValue": { type: "array", confidence: "low" },
  "google.protobuf.FieldMask": { type: "string", confidence: "medium" },
  "google.type.Date": { type: "plainDate", confidence: "high" },
  "google.type.TimeOfDay": { type: "plainTime", confidence: "high" },
};

const WELL_KNOWN_IMPORT_PREFIXES = ["google/protobuf/", "google/type/"];

// ---------------------------------------------------------------------------
// Document walk
// ---------------------------------------------------------------------------

/** A single resolved type reference (a field's type, a map value, an array element). */
interface ResolvedRef {
  type: string;
  confidence: ImportConfidence;
  nullable?: boolean;
  referencedEntityName?: string;
  enumName?: string;
  enumValues?: string[];
}

interface WalkState {
  names: Map<ReflectionObject, string>;
  warnings: string[];
}

function nestingName(obj: ReflectionObject): string {
  const parts: string[] = [];
  let cur: ReflectionObject | null = obj;
  while (cur && (cur instanceof Type || cur instanceof Enum)) {
    parts.unshift(cur.name);
    cur = cur.parent;
  }
  return parts.join("_");
}

/** Depth-first, declaration order: each message, then its nested types. */
function collectDefinitions(ns: Namespace, types: Type[], enums: Enum[], services: Service[]): void {
  for (const obj of ns.nestedArray) {
    if (obj instanceof Type) {
      types.push(obj);
      collectDefinitions(obj, types, enums, services);
    } else if (obj instanceof Enum) {
      enums.push(obj);
    } else if (obj instanceof Service) {
      services.push(obj);
    } else if ("nestedArray" in obj) {
      // Package namespaces
      collectDefinitions(obj as Namespace, types, enums, services);
    }
  }
}

/** Unique asset name per definition (messages and enums share the registry namespace). */
function assignNames(defs: ReflectionObject[], warnings: string[]): Map<ReflectionObject, string> {
  const names = new Map<ReflectionObject, string>();
  const used = new Set<string>();
  for (const def of defs) {
    const base = nestingName(def);
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
    if (name !== base) {
      warnings.push(`"${def.fullName.replace(/^\./, "")}" clashes with another definition named "${base}" — imported as "${name}".`);
    }
    used.add(name);
    names.set(def, name);
  }
  return names;
}

function enumValues(e: Enum): string[] {
  return Object.keys(e.values);
}

function resolveTypeName(typeName: string, scope: Type, state: WalkState, fieldLabel: string): ResolvedRef {
  const scalar = PROTO_SCALAR_MAP[typeName];
  if (scalar) return { ...scalar };

  const qualified = typeName.replace(/^\./, "");
  const wkt = WELL_KNOWN_TYPE_MAP[qualified];
  if (wkt) return { ...wkt };

  const found = scope.lookup(typeName, [Type, Enum]);
  if (found instanceof Type) {
    return { type: "reference", confidence: "high", referencedEntityName: state.names.get(found) };
  }
  if (found instanceof Enum) {
    return {
      type: "enum",
      confidence: "high",
      enumName: state.names.get(found),
      enumValues: enumValues(found),
    };
  }

  const simpleName = qualified.split(".").pop() ?? qualified;
  state.warnings.push(
    `Field "${fieldLabel}": type "${qualified}" is not defined in this file — imported as a reference to "${simpleName}".`
  );
  return { type: "reference", confidence: "low", referencedEntityName: simpleName };
}

/** Key type of a `map<K,V>` field (protobufjs builds those as MapField). */
function mapKeyTypeOf(field: Field): string | undefined {
  const base: unknown = field;
  return base instanceof MapField ? base.keyType : undefined;
}

function originalTypeOf(field: Field): string {
  if (field.map) return `map<${mapKeyTypeOf(field) ?? "string"}, ${field.type}>`;
  return field.repeated ? `repeated ${field.type}` : field.type;
}

function isProto2(content: string): boolean {
  if (/^\s*syntax\s*=\s*["']proto3["']/m.test(content)) return false;
  if (/^\s*edition\s*=/m.test(content)) return false;
  return true; // explicit proto2, or no syntax statement (proto2 by spec)
}

function mapField(field: Field, owner: Type, ownerName: string, proto2: boolean, state: WalkState): ParsedField {
  const label = `${ownerName}.${field.name}`;
  const ref = resolveTypeName(field.type, owner, state, label);

  const parsed: ParsedField = {
    name: field.name,
    type: ref.type,
    nullable: true,
    fieldNumber: field.id,
    confidence: ref.confidence,
    originalType: originalTypeOf(field),
  };
  if (field.comment) parsed.description = field.comment;

  if (field.map) {
    const key = PROTO_SCALAR_MAP[mapKeyTypeOf(field) ?? "string"];
    parsed.type = "map";
    parsed.mapKeyType = key?.type ?? "string";
    parsed.mapValueType = ref.type;
    parsed.confidence = ref.confidence;
  } else if (field.repeated) {
    parsed.type = "array";
    parsed.arrayElementType = ref.type;
  }

  if (ref.referencedEntityName) parsed.referencedEntityName = ref.referencedEntityName;
  if (ref.enumName) parsed.enumName = ref.enumName;
  if (ref.enumValues) parsed.enumValues = ref.enumValues;

  // proto3 / editions: every field has presence semantics we model as nullable.
  // proto2: `required` is not nullable, and repeated/map are never null.
  if (field.rule === "required") parsed.nullable = false;
  else if (proto2 && (field.repeated || field.map)) parsed.nullable = false;

  // Real oneof groups only — proto3 `optional` creates a synthetic `_name` oneof.
  const oneof = field.partOf;
  if (oneof && !field.options?.proto3_optional) {
    parsed.governance = { protobufOneofGroup: oneof.name };
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function parseProtobufDocument(content: string): Result<MultiEntityImportResult> {
  if (!content || !content.trim()) {
    return err({
      code: "PARSE_ERROR",
      message: "Empty .proto content",
      suggestedFix: 'Provide a .proto file with at least one "message Name { ... }" definition.',
    });
  }

  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(content, { keepCase: true, alternateCommentMode: true });
  } catch (e) {
    return err({
      code: "PARSE_ERROR",
      message: `Invalid .proto file: ${e instanceof Error ? e.message : String(e)}`,
      suggestedFix: "Fix the syntax error at the reported line and import again.",
    });
  }

  const types: Type[] = [];
  const enums: Enum[] = [];
  const services: Service[] = [];
  collectDefinitions(parsed.root, types, enums, services);

  if (types.length === 0) {
    return err({
      code: "PARSE_ERROR",
      message: "No message definition found in .proto file",
      suggestedFix: 'Ensure the .proto file contains a "message MessageName { ... }" definition.',
    });
  }

  const warnings: string[] = [];
  const state: WalkState = { names: assignNames([...types, ...enums], warnings), warnings };
  const proto2 = isProto2(content);

  for (const imp of [...(parsed.imports ?? []), ...(parsed.weakImports ?? [])]) {
    if (WELL_KNOWN_IMPORT_PREFIXES.some((prefix) => imp.startsWith(prefix))) continue;
    warnings.push(`Import "${imp}" is not resolved — types it defines import as references by name.`);
  }

  const entities: ParsedEntity[] = types.map((type) => {
    const name = state.names.get(type) as string;
    const entity: ParsedEntity = {
      name,
      fields: type.fieldsArray.map((field) => mapField(field, type, name, proto2, state)),
      sourceFormat: "protobuf",
      originalContent: content,
    };
    if (type.comment) entity.description = type.comment;
    return entity;
  });

  const parsedEnums: ParsedEnum[] = enums.map((e) => {
    const parsedEnum: ParsedEnum = { name: state.names.get(e) as string, values: enumValues(e) };
    if (e.comment) parsedEnum.description = e.comment;
    return parsedEnum;
  });

  for (const service of services) {
    const rpcCount = service.methodsArray.length;
    warnings.push(
      `Service "${service.name}" (${rpcCount} rpc${rpcCount === 1 ? "" : "s"}) not imported — gRPC API import is not supported yet.`
    );
  }

  return ok({
    sourceFormat: "protobuf",
    entities,
    enums: parsedEnums,
    scalars: [],
    ...(parsed.package ? { namespace: parsed.package } : {}),
    warnings,
  });
}

export function parseProtobufSchema(content: string): Result<ParsedEntity> {
  const doc = parseProtobufDocument(content);
  if (!doc.success) return doc;
  return ok(doc.data.entities[0]);
}
