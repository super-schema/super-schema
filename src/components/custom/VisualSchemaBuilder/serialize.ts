/**
 * Pure serialization for the visual JSON Schema builder (JSON Schema 2020-12).
 *
 * The builder is JSON-native: fields carry real JSON Schema types + keywords,
 * not Super Schema logical types. This module assembles a 2020-12 document from
 * the editor rows. The importer (jsonschema.importer.ts) maps the result back
 * into the IR downstream — so this stays a faithful JSON Schema producer.
 */

import { numberFromText } from "@/lib/compiler/typed-value-literal";

export const JSON_SCHEMA_VERSION = "2020-12";
export const JSON_SCHEMA_DIALECT =
  "https://json-schema.org/draft/2020-12/schema";

export type JsonType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array"
  | "null";

export const JSON_TYPES: JsonType[] = [
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null",
];

/**
 * Field type in the builder: a JSON type, or a `reference` to another entity
 * (serialized as `$ref`). References keep each entity/schema individual and
 * composable instead of deep-nesting everything inline.
 */
export type FieldType = JsonType | "reference";

/** JSON-pointer `$ref` to a sibling entity/schema by name. */
export function entityRef(name: string | undefined): string {
  const n = (name ?? "").trim();
  if (!n) return "#";
  if (n.startsWith("#") || n.startsWith("http")) return n;
  return `#/$defs/${n}`;
}

/** 2020-12 built-in string `format` values. */
export const STRING_FORMATS_2020_12 = [
  "",
  "date-time",
  "date",
  "time",
  "duration",
  "email",
  "idn-email",
  "hostname",
  "idn-hostname",
  "ipv4",
  "ipv6",
  "uri",
  "uri-reference",
  "iri",
  "iri-reference",
  "uuid",
  "uri-template",
  "json-pointer",
  "relative-json-pointer",
  "regex",
] as const;

export interface JsonSchemaField {
  id: string;
  name: string;
  type: FieldType;
  /** Membership in the parent `required` array. */
  required: boolean;
  description: string;

  // reference (type === "reference")
  refTarget?: string; // target entity/schema name

  // common
  defaultValue?: string; // raw text; parsed as JSON when possible
  constValue?: string; // raw text; parsed as JSON when possible
  enumValues?: string[];
  deprecated?: boolean;
  readOnly?: boolean;
  writeOnly?: boolean;

  // string
  format?: string;
  minLength?: number;
  maxLength?: number;
  pattern?: string;

  // number / integer
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;

  // array
  itemsType?: FieldType; // element type (JSON type or "reference")
  itemsRefTarget?: string; // target entity when itemsType === "reference"
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
}

/** Parse a raw text value as JSON, falling back to the string itself. */
function parseLoose(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return raw;
  }
}

function num(value: number | undefined): boolean {
  return typeof value === "number" && !Number.isNaN(value);
}

/**
 * An enum symbol, typed for the field's JSON type: a number or boolean stays one (`"1"` on an integer is `1`), text stays text, and any other
 * type reads the symbol as JSON when it parses. `undefined` when the symbol does not fit the type (`"two"` on an integer).
 */
export function typedEnumValue(symbol: string, type: FieldType): unknown {
  switch (type) {
    case "string":
      return symbol;
    case "integer": {
      const n = numberFromText(symbol);
      return n !== undefined && Number.isInteger(n) ? n : undefined;
    }
    case "number":
      return numberFromText(symbol);
    case "boolean": {
      const word = symbol.trim();
      return word === "true" ? true : word === "false" ? false : undefined;
    }
    default:
      return parseLoose(symbol);
  }
}

/**
 * The enum symbols of a field that fit its type, typed, each value once: `"1"` and `"1.0"` on an integer are both 1, and the enum keeps the first.
 * A symbol that does not fit is left out (see {@link enumIssues}).
 */
function typedEnumValues(field: JsonSchemaField): unknown[] {
  const values: unknown[] = [];
  for (const symbol of field.enumValues ?? []) {
    const value = typedEnumValue(symbol, field.type);
    if (value !== undefined && !values.includes(value)) values.push(value);
  }
  return values;
}

/** The enum symbols of a field that do not fit its type: the editor reports them, and they are left out of the schema. */
export function enumIssues(field: JsonSchemaField): string[] {
  return (field.enumValues ?? []).filter((symbol) => typedEnumValue(symbol, field.type) === undefined);
}

/** Build a single JSON Schema node for a field (only set keywords are emitted). */
export function buildFieldNode(field: JsonSchemaField): Record<string, unknown> {
  // reference → $ref (keeps entities individual + composable)
  if (field.type === "reference") {
    const node: Record<string, unknown> = { $ref: entityRef(field.refTarget) };
    if (field.description.trim()) node.description = field.description.trim();
    return node;
  }

  const node: Record<string, unknown> = { type: field.type };

  if (field.description.trim()) node.description = field.description.trim();

  // enum (typed for the field's type) / const (loose JSON)
  const enumValues = typedEnumValues(field);
  if (enumValues.length > 0) node.enum = enumValues;
  if (field.constValue != null && field.constValue.trim() !== "") {
    node.const = parseLoose(field.constValue);
  }
  if (field.defaultValue != null && field.defaultValue.trim() !== "") {
    node.default = parseLoose(field.defaultValue);
  }
  if (field.deprecated) node.deprecated = true;
  if (field.readOnly) node.readOnly = true;
  if (field.writeOnly) node.writeOnly = true;

  switch (field.type) {
    case "string":
      if (field.format) node.format = field.format;
      if (num(field.minLength)) node.minLength = field.minLength;
      if (num(field.maxLength)) node.maxLength = field.maxLength;
      if (field.pattern?.trim()) node.pattern = field.pattern.trim();
      break;
    case "number":
    case "integer":
      if (num(field.minimum)) node.minimum = field.minimum;
      if (num(field.maximum)) node.maximum = field.maximum;
      if (num(field.exclusiveMinimum)) node.exclusiveMinimum = field.exclusiveMinimum;
      if (num(field.exclusiveMaximum)) node.exclusiveMaximum = field.exclusiveMaximum;
      if (num(field.multipleOf)) node.multipleOf = field.multipleOf;
      break;
    case "array":
      node.items =
        field.itemsType === "reference"
          ? { $ref: entityRef(field.itemsRefTarget) }
          : field.itemsType
            ? { type: field.itemsType }
            : {};
      if (num(field.minItems)) node.minItems = field.minItems;
      if (num(field.maxItems)) node.maxItems = field.maxItems;
      if (field.uniqueItems) node.uniqueItems = true;
      break;
    case "object":
      node.properties = {};
      break;
    default:
      break;
  }

  return node;
}

/**
 * Serialize builder rows into a JSON Schema 2020-12 document object, or null
 * when the state is incomplete (no title or no named fields).
 */
export function buildJsonSchemaDocument(
  title: string,
  description: string,
  fields: JsonSchemaField[]
): Record<string, unknown> | null {
  const named = fields.filter((f) => f.name.trim());
  if (!title.trim() || named.length === 0) return null;

  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const f of named) {
    const key = f.name.trim();
    properties[key] = buildFieldNode(f);
    if (f.required) required.push(key);
  }

  const doc: Record<string, unknown> = {
    $schema: JSON_SCHEMA_DIALECT,
    title: title.trim(),
    type: "object",
    properties,
  };
  if (description.trim()) doc.description = description.trim();
  if (required.length > 0) doc.required = required;
  return doc;
}

/** Same as {@link buildJsonSchemaDocument} but returns a pretty JSON string. */
export function serializeJsonSchema(
  title: string,
  description: string,
  fields: JsonSchemaField[]
): string | null {
  const doc = buildJsonSchemaDocument(title, description, fields);
  return doc ? JSON.stringify(doc, null, 2) : null;
}
