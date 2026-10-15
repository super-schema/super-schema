/**
 * Text → form state: the strict inverse of the visual builders' serializers.
 *
 * Only text shaped like what `serializeJsonSchema` / `serializeAvroSchema` /
 * `serializeProtobufSchema` produce is accepted. Anything else returns
 * `{ ok: false }` so the Schema Workbench leaves the form untouched instead of
 * silently dropping constructs the form cannot represent. Never throws.
 */

import {
  AVRO_ORDERS,
  AVRO_PRIMITIVE_TYPES,
  type AvroField,
  type AvroFieldType,
  type AvroOrder,
} from "@/components/custom/VisualSchemaBuilder/avro-serialize";
import {
  PROTO_MAP_KEY_TYPES,
  PROTO_SCALAR_TYPES,
  PROTO_WELL_KNOWN_TYPES,
  type ProtoField,
  type ProtoFieldType,
} from "@/components/custom/VisualSchemaBuilder/protobuf-serialize";
import {
  JSON_SCHEMA_DIALECT,
  JSON_TYPES,
  type FieldType,
  type JsonSchemaField,
  type JsonType,
} from "@/components/custom/VisualSchemaBuilder/serialize";
import type { FormState, WorkbenchFormat } from "./form-state";

export type ParseResult = { ok: true; state: FormState } | { ok: false; reason: string };

type Obj = Record<string, unknown>;

class Unmappable extends Error {}

function fail(reason: string): never {
  throw new Unmappable(reason);
}

function genId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function onlyKeys(obj: Obj, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail(`${where}: "${key}" can't be shown in the form`);
  }
}

function optString(obj: Obj, key: string, where: string): string | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") fail(`${where}: "${key}" must be a string`);
  return v;
}

function optNumber(obj: Obj, key: string, where: string): number | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || Number.isNaN(v)) fail(`${where}: "${key}" must be a number`);
  return v;
}

function optTrue(obj: Obj, key: string, where: string): true | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (v !== true) fail(`${where}: "${key}" must be true when present`);
  return true;
}

/**
 * Raw-text form of a JSON value, such that the serializers' `parseLoose` yields
 * the same value back. Bare strings stay bare unless they would parse as JSON.
 */
function toRawText(value: unknown): string {
  if (typeof value === "string") {
    try {
      JSON.parse(value);
      return JSON.stringify(value);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// JSON Schema
// ---------------------------------------------------------------------------

const JSON_COMMON_KEYS = ["type", "description", "enum", "const", "default", "deprecated", "readOnly", "writeOnly"];
const JSON_TYPE_KEYS: Record<string, readonly string[]> = {
  string: ["format", "minLength", "maxLength", "pattern"],
  number: ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"],
  integer: ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"],
  array: ["items", "minItems", "maxItems", "uniqueItems"],
  object: ["properties"],
};

function refName(ref: unknown, where: string): string {
  if (typeof ref !== "string") fail(`${where}: "$ref" must be a string`);
  if (ref === "#") return "";
  if (ref.startsWith("#/$defs/")) return ref.slice("#/$defs/".length);
  return ref;
}

function parseJsonField(name: string, node: unknown, required: boolean): JsonSchemaField {
  const where = `property "${name}"`;
  if (!isObj(node)) fail(`${where} must be an object`);

  if ("$ref" in node) {
    onlyKeys(node, ["$ref", "description"], where);
    return {
      id: genId(),
      name,
      type: "reference",
      required,
      description: optString(node, "description", where) ?? "",
      refTarget: refName(node.$ref, where),
    };
  }

  const type = node.type;
  if (typeof type !== "string" || !(JSON_TYPES as string[]).includes(type)) {
    fail(`${where}: "type" must be one of ${JSON_TYPES.join(", ")}`);
  }
  onlyKeys(node, [...JSON_COMMON_KEYS, ...(JSON_TYPE_KEYS[type] ?? [])], where);

  const field: JsonSchemaField = {
    id: genId(),
    name,
    type: type as JsonType,
    required,
    description: optString(node, "description", where) ?? "",
  };

  if (node.enum !== undefined) {
    if (!Array.isArray(node.enum) || !node.enum.every((v) => typeof v === "string")) {
      fail(`${where}: "enum" must be a list of strings`);
    }
    field.enumValues = node.enum as string[];
  }
  if ("const" in node) field.constValue = toRawText(node.const);
  if ("default" in node) field.defaultValue = toRawText(node.default);
  field.deprecated = optTrue(node, "deprecated", where);
  field.readOnly = optTrue(node, "readOnly", where);
  field.writeOnly = optTrue(node, "writeOnly", where);

  switch (type) {
    case "string":
      field.format = optString(node, "format", where);
      field.minLength = optNumber(node, "minLength", where);
      field.maxLength = optNumber(node, "maxLength", where);
      field.pattern = optString(node, "pattern", where);
      break;
    case "number":
    case "integer":
      field.minimum = optNumber(node, "minimum", where);
      field.maximum = optNumber(node, "maximum", where);
      field.exclusiveMinimum = optNumber(node, "exclusiveMinimum", where);
      field.exclusiveMaximum = optNumber(node, "exclusiveMaximum", where);
      field.multipleOf = optNumber(node, "multipleOf", where);
      break;
    case "array": {
      const items = node.items;
      if (items !== undefined) {
        if (!isObj(items)) fail(`${where}: "items" must be an object`);
        if ("$ref" in items) {
          onlyKeys(items, ["$ref"], `${where} items`);
          field.itemsType = "reference";
          field.itemsRefTarget = refName(items.$ref, `${where} items`);
        } else if (Object.keys(items).length > 0) {
          onlyKeys(items, ["type"], `${where} items`);
          const itemType = items.type;
          if (typeof itemType !== "string" || !(JSON_TYPES as string[]).includes(itemType)) {
            fail(`${where}: items "type" must be one of ${JSON_TYPES.join(", ")}`);
          }
          field.itemsType = itemType as FieldType;
        }
      }
      field.minItems = optNumber(node, "minItems", where);
      field.maxItems = optNumber(node, "maxItems", where);
      field.uniqueItems = optTrue(node, "uniqueItems", where);
      break;
    }
    case "object":
      if (node.properties !== undefined) {
        if (!isObj(node.properties) || Object.keys(node.properties).length > 0) {
          fail(`${where}: nested properties can't be edited in the form`);
        }
      }
      break;
  }

  // Keep only keys that carry a value so state stays minimal.
  for (const key of Object.keys(field) as (keyof JsonSchemaField)[]) {
    if (field[key] === undefined) delete field[key];
  }
  return field;
}

function parseJsonSchema(text: string): FormState {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    fail("Not valid JSON");
  }
  if (!isObj(doc)) fail("A JSON Schema must be an object");
  onlyKeys(doc, ["$schema", "title", "type", "properties", "description", "required"], "schema");
  if (doc.$schema !== undefined && doc.$schema !== JSON_SCHEMA_DIALECT) {
    fail(`"$schema" must be ${JSON_SCHEMA_DIALECT} to edit in the form`);
  }
  if (doc.type !== "object") fail(`Top-level "type" must be "object"`);
  if (typeof doc.title !== "string" || !doc.title.trim()) fail(`A non-empty "title" is required`);
  if (!isObj(doc.properties)) fail(`"properties" must be an object`);

  const requiredList = doc.required === undefined ? [] : doc.required;
  if (!Array.isArray(requiredList) || !requiredList.every((r) => typeof r === "string")) {
    fail(`"required" must be a list of strings`);
  }
  for (const name of requiredList as string[]) {
    if (!(name in doc.properties)) fail(`"required" lists unknown property "${name}"`);
  }

  const properties = doc.properties;
  const fields = Object.keys(properties).map((name) =>
    parseJsonField(name, properties[name], (requiredList as string[]).includes(name))
  );

  return {
    format: "json-schema",
    title: doc.title,
    description: optString(doc, "description", "schema") ?? "",
    fields,
  };
}

// ---------------------------------------------------------------------------
// Avro
// ---------------------------------------------------------------------------

const AVRO_LOGICAL_BY_KEY: Record<string, AvroFieldType> = {
  "int/date": "date",
  "int/time-millis": "time-millis",
  "long/time-micros": "time-micros",
  "long/timestamp-millis": "timestamp-millis",
  "long/timestamp-micros": "timestamp-micros",
  "string/uuid": "uuid",
};

type AvroBase = Partial<AvroField> & { type: AvroFieldType };

/** An array-items / map-values type: primitive, logical (no extras) or a named reference. */
function parseAvroElement(value: unknown, where: string): { type: AvroFieldType; ref?: string } {
  if (typeof value === "string") {
    if ((AVRO_PRIMITIVE_TYPES as string[]).includes(value)) return { type: value as AvroFieldType };
    return { type: "reference", ref: value };
  }
  if (isObj(value)) {
    const key = `${String(value.type)}/${String(value.logicalType)}`;
    const logical = AVRO_LOGICAL_BY_KEY[key];
    if (logical) {
      onlyKeys(value, ["type", "logicalType"], where);
      return { type: logical };
    }
  }
  return fail(`${where}: only primitive, logical or named types can be shown in the form`);
}

function parseAvroBase(value: unknown, where: string): AvroBase {
  if (typeof value === "string") {
    if ((AVRO_PRIMITIVE_TYPES as string[]).includes(value)) return { type: value as AvroFieldType };
    return { type: "reference", refTarget: value };
  }
  if (!isObj(value)) return fail(`${where}: unsupported type`);

  const kind = value.type;
  const logical = value.logicalType;

  const logicalKey = `${String(kind)}/${String(logical)}`;
  if (AVRO_LOGICAL_BY_KEY[logicalKey]) {
    onlyKeys(value, ["type", "logicalType"], where);
    return { type: AVRO_LOGICAL_BY_KEY[logicalKey] };
  }

  if (kind === "bytes" && logical === "decimal") {
    onlyKeys(value, ["type", "logicalType", "precision", "scale"], where);
    return {
      type: "decimal",
      precision: optNumber(value, "precision", where),
      scale: optNumber(value, "scale", where),
    };
  }
  if (kind === "fixed" && logical === "duration") {
    onlyKeys(value, ["type", "name", "size", "logicalType"], where);
    if (value.size !== 12) fail(`${where}: duration must have size 12`);
    return { type: "duration", fixedName: optString(value, "name", where) };
  }
  if (kind === "fixed" && logical === undefined) {
    onlyKeys(value, ["type", "name", "size"], where);
    return {
      type: "fixed",
      fixedName: optString(value, "name", where),
      fixedSize: optNumber(value, "size", where),
    };
  }
  if (kind === "enum") {
    onlyKeys(value, ["type", "name", "symbols"], where);
    if (!Array.isArray(value.symbols) || !value.symbols.every((s) => typeof s === "string")) {
      fail(`${where}: "symbols" must be a list of strings`);
    }
    return {
      type: "enum",
      enumName: optString(value, "name", where),
      symbols: value.symbols as string[],
    };
  }
  if (kind === "array") {
    onlyKeys(value, ["type", "items"], where);
    const items = parseAvroElement(value.items, `${where} items`);
    return {
      type: "array",
      itemsType: items.type,
      ...(items.ref !== undefined ? { itemsRefTarget: items.ref } : {}),
    };
  }
  if (kind === "map") {
    onlyKeys(value, ["type", "values"], where);
    const values = parseAvroElement(value.values, `${where} values`);
    return {
      type: "map",
      valuesType: values.type,
      ...(values.ref !== undefined ? { valuesRefTarget: values.ref } : {}),
    };
  }
  return fail(`${where}: unsupported type`);
}

function parseAvroField(node: unknown): AvroField {
  if (!isObj(node)) fail("Each Avro field must be an object");
  onlyKeys(node, ["name", "type", "doc", "aliases", "default", "order"], "field");
  if (typeof node.name !== "string" || !node.name.trim()) fail("Every field needs a name");
  const where = `field "${node.name}"`;

  let nullable = false;
  let typeValue: unknown = node.type;
  if (Array.isArray(typeValue)) {
    if (typeValue.length !== 2 || typeValue[0] !== "null") {
      fail(`${where}: only ["null", type] unions can be shown in the form`);
    }
    nullable = true;
    typeValue = typeValue[1];
  }
  const base = parseAvroBase(typeValue, where);

  const field: AvroField = {
    id: genId(),
    name: node.name,
    nullable,
    doc: optString(node, "doc", where) ?? "",
    ...base,
  };

  if (node.aliases !== undefined) {
    if (!Array.isArray(node.aliases) || !node.aliases.every((a) => typeof a === "string")) {
      fail(`${where}: "aliases" must be a list of strings`);
    }
    field.aliases = node.aliases as string[];
  }
  if (node.order !== undefined) {
    if (!(AVRO_ORDERS as unknown[]).includes(node.order)) fail(`${where}: invalid "order"`);
    field.order = node.order as AvroOrder;
  }
  if ("default" in node && !(nullable && node.default === null)) {
    field.defaultValue = toRawText(node.default);
  }
  return field;
}

function parseAvro(text: string): FormState {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    fail("Not valid JSON");
  }
  if (!isObj(doc)) fail("An Avro schema must be an object");
  onlyKeys(doc, ["type", "name", "namespace", "doc", "fields"], "record");
  if (doc.type !== "record") fail(`Top-level "type" must be "record"`);
  if (typeof doc.name !== "string" || !doc.name.trim()) fail(`A non-empty "name" is required`);
  if (!Array.isArray(doc.fields)) fail(`"fields" must be a list`);

  return {
    format: "avro",
    name: doc.name,
    namespace: optString(doc, "namespace", "record") ?? "",
    doc: optString(doc, "doc", "record") ?? "",
    fields: doc.fields.map(parseAvroField),
  };
}

// ---------------------------------------------------------------------------
// Protobuf
// ---------------------------------------------------------------------------

const PROTO_VALUE_TYPES: readonly string[] = [...PROTO_SCALAR_TYPES, ...PROTO_WELL_KNOWN_TYPES];
const PROTO_FIELD_RE =
  /^(repeated\s+)?(map<[^>]*>|[A-Za-z_][\w.]*)\s+([A-Za-z_]\w*)\s*=\s*(\d+)\s*;(?:\s*\/\/\s?(.*))?$/;
const PROTO_MAP_RE = /^map<\s*([\w.]+)\s*,\s*([\w.]+)\s*>$/;
const IDENT_RE = /^[A-Za-z_][\w.]*$/;

function parseProtoField(match: RegExpMatchArray, oneofGroup: string | undefined): ProtoField {
  const [, repeated, typeToken, name, number, doc] = match;
  const where = `field "${name}"`;
  const field: ProtoField = {
    id: genId(),
    name,
    type: "string",
    fieldNumber: Number(number),
    repeated: Boolean(repeated),
    doc: (doc ?? "").trim(),
  };
  if (oneofGroup) field.oneofGroup = oneofGroup;

  const map = PROTO_MAP_RE.exec(typeToken);
  if (typeToken.startsWith("map<")) {
    if (!map) fail(`${where}: malformed map type`);
    if (repeated) fail(`${where}: map fields can't be repeated`);
    if (oneofGroup) fail(`${where}: map fields can't be inside a oneof`);
    if (!(PROTO_MAP_KEY_TYPES as string[]).includes(map[1])) {
      fail(`${where}: invalid map key type "${map[1]}"`);
    }
    field.type = "map";
    field.mapKeyType = map[1] as ProtoFieldType;
    if (PROTO_VALUE_TYPES.includes(map[2])) {
      field.mapValueType = map[2] as ProtoFieldType;
    } else {
      field.mapValueType = "reference";
      field.mapValueRefTarget = map[2];
    }
    return field;
  }

  if (oneofGroup && repeated) fail(`${where}: oneof members can't be repeated`);
  if (PROTO_VALUE_TYPES.includes(typeToken)) {
    field.type = typeToken as ProtoFieldType;
  } else {
    field.type = "reference";
    field.refTarget = typeToken;
  }
  return field;
}

function parseProtobuf(text: string): FormState {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");

  let i = 0;
  if (!/^syntax\s*=\s*"proto3"\s*;$/.test(lines[i] ?? "")) fail(`Expected syntax = "proto3";`);
  i++;

  let packageName = "";
  const pkg = /^package\s+([\w.]+)\s*;$/.exec(lines[i] ?? "");
  if (pkg) {
    packageName = pkg[1];
    i++;
  }

  const head = /^message\s+([A-Za-z_]\w*)\s*\{$/.exec(lines[i] ?? "");
  if (!head) fail("Expected a single message declaration");
  const name = head[1];
  i++;

  const fields: ProtoField[] = [];
  let group: string | undefined;
  let closed = false;

  for (; i < lines.length; i++) {
    const line = lines[i];
    if (group) {
      if (line === "}") {
        group = undefined;
        continue;
      }
      const m = PROTO_FIELD_RE.exec(line);
      if (!m) fail(`Can't read line: ${line}`);
      fields.push(parseProtoField(m, group));
      continue;
    }
    if (line === "}") {
      closed = true;
      i++;
      break;
    }
    const oneof = /^oneof\s+([A-Za-z_]\w*)\s*\{$/.exec(line);
    if (oneof) {
      group = oneof[1];
      continue;
    }
    const m = PROTO_FIELD_RE.exec(line);
    if (!m) fail(`Can't read line: ${line}`);
    fields.push(parseProtoField(m, undefined));
  }

  if (!closed || group) fail("Unbalanced braces");
  if (i < lines.length) fail("Only a single message is supported in the form");
  if (!IDENT_RE.test(name)) fail("Invalid message name");

  return { format: "protobuf", name, packageName, fields };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function parseToFormState(format: WorkbenchFormat, text: string): ParseResult {
  try {
    switch (format) {
      case "json-schema":
        return { ok: true, state: parseJsonSchema(text) };
      case "avro":
        return { ok: true, state: parseAvro(text) };
      case "protobuf":
        return { ok: true, state: parseProtobuf(text) };
    }
  } catch (e) {
    if (e instanceof Unmappable) return { ok: false, reason: e.message };
    return { ok: false, reason: "Could not read this schema" };
  }
}
