/**
 * Pure serialization for the visual Avro builder (Avro .avsc JSON).
 *
 * Mirrors serialize.ts's JSON Schema pattern, but produces Avro-native shapes.
 * Type vocabulary and logical-type shapes are deliberately matched 1:1 against
 * avro.importer.ts's AVRO_PRIMITIVE_MAP / resolveLogicalType so a schema built
 * here parses back through the real importer with high confidence, not just
 * "low confidence string" fallbacks.
 */

export type AvroFieldType =
  | "string"
  | "int"
  | "long"
  | "float"
  | "double"
  | "boolean"
  | "bytes"
  | "date"
  | "time-millis"
  | "time-micros"
  | "timestamp-millis"
  | "timestamp-micros"
  | "decimal"
  | "duration"
  | "uuid"
  | "enum"
  | "array"
  | "map"
  | "fixed"
  | "reference";

export const AVRO_PRIMITIVE_TYPES: AvroFieldType[] = [
  "string",
  "int",
  "long",
  "float",
  "double",
  "boolean",
  "bytes",
];

export const AVRO_LOGICAL_TYPES: AvroFieldType[] = [
  "date",
  "time-millis",
  "time-micros",
  "timestamp-millis",
  "timestamp-micros",
  "decimal",
  "duration",
  "uuid",
];

export const AVRO_STRUCTURED_TYPES: AvroFieldType[] = ["enum", "array", "map", "fixed"];

/** Full picker vocabulary, in display order. */
export const AVRO_FIELD_TYPES: AvroFieldType[] = [
  ...AVRO_PRIMITIVE_TYPES,
  ...AVRO_LOGICAL_TYPES,
  ...AVRO_STRUCTURED_TYPES,
  "reference",
];

/** Restricted vocabulary for array items / map values — no nested array/map/enum/fixed. */
export const AVRO_ELEMENT_TYPES: AvroFieldType[] = [
  ...AVRO_PRIMITIVE_TYPES,
  ...AVRO_LOGICAL_TYPES,
  "reference",
];

export type AvroOrder = "ascending" | "descending" | "ignore";
export const AVRO_ORDERS: AvroOrder[] = ["ascending", "descending", "ignore"];

export interface AvroField {
  id: string;
  name: string;
  type: AvroFieldType;
  nullable: boolean;
  doc: string;

  // reference (type === "reference")
  refTarget?: string;

  // common/advanced
  aliases?: string[];
  defaultValue?: string; // raw text; parsed as JSON when possible
  order?: AvroOrder;

  // decimal
  precision?: number;
  scale?: number;

  // fixed (and duration, which is a size-12 fixed under the hood)
  fixedName?: string;
  fixedSize?: number;

  // enum
  enumName?: string;
  symbols?: string[];

  // array
  itemsType?: AvroFieldType;
  itemsRefTarget?: string;

  // map
  valuesType?: AvroFieldType;
  valuesRefTarget?: string;
}

type AvroTypeValue = string | Record<string, unknown>;

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

/** Build the Avro `type` value for a field, excluding the nullable union wrapper. */
function baseAvroTypeValue(
  type: AvroFieldType,
  opts: {
    precision?: number;
    scale?: number;
    fixedName?: string;
    fixedSize?: number;
    enumName?: string;
    symbols?: string[];
    itemsType?: AvroFieldType;
    itemsRefTarget?: string;
    valuesType?: AvroFieldType;
    valuesRefTarget?: string;
    refTarget?: string;
  }
): AvroTypeValue {
  switch (type) {
    case "string":
    case "int":
    case "long":
    case "float":
    case "double":
    case "boolean":
    case "bytes":
      return type;
    case "date":
      return { type: "int", logicalType: "date" };
    case "time-millis":
      return { type: "int", logicalType: "time-millis" };
    case "time-micros":
      return { type: "long", logicalType: "time-micros" };
    case "timestamp-millis":
      return { type: "long", logicalType: "timestamp-millis" };
    case "timestamp-micros":
      return { type: "long", logicalType: "timestamp-micros" };
    case "uuid":
      return { type: "string", logicalType: "uuid" };
    case "decimal":
      return {
        type: "bytes",
        logicalType: "decimal",
        precision: num(opts.precision) ? opts.precision : 10,
        scale: num(opts.scale) ? opts.scale : 2,
      };
    case "duration":
      return {
        type: "fixed",
        name: opts.fixedName?.trim() || "Duration",
        size: 12,
        logicalType: "duration",
      };
    case "fixed":
      return {
        type: "fixed",
        name: opts.fixedName?.trim() || "Fixed",
        size: num(opts.fixedSize) ? opts.fixedSize : 16,
      };
    case "enum":
      return {
        type: "enum",
        name: opts.enumName?.trim() || "Enum",
        symbols: opts.symbols && opts.symbols.length > 0 ? opts.symbols : ["VALUE_1"],
      };
    case "array":
      return {
        type: "array",
        items: opts.itemsType
          ? opts.itemsType === "reference"
            ? opts.itemsRefTarget?.trim() || "string"
            : baseAvroTypeValue(opts.itemsType, {})
          : "string",
      };
    case "map":
      return {
        type: "map",
        values: opts.valuesType
          ? opts.valuesType === "reference"
            ? opts.valuesRefTarget?.trim() || "string"
            : baseAvroTypeValue(opts.valuesType, {})
          : "string",
      };
    case "reference":
      return opts.refTarget?.trim() || "string";
    default:
      return "string";
  }
}

/** Build a single Avro field entry (name/type/doc/aliases/default/order). */
export function buildAvroFieldNode(field: AvroField): Record<string, unknown> {
  const base = baseAvroTypeValue(field.type, field);
  const typeValue: unknown = field.nullable ? ["null", base] : base;

  const node: Record<string, unknown> = {
    name: field.name.trim(),
    type: typeValue,
  };
  if (field.doc.trim()) node.doc = field.doc.trim();
  if (field.aliases && field.aliases.length > 0) node.aliases = field.aliases;
  if (field.order) node.order = field.order;

  if (field.nullable) {
    node.default = field.defaultValue?.trim() ? parseLoose(field.defaultValue) : null;
  } else if (field.defaultValue?.trim()) {
    node.default = parseLoose(field.defaultValue);
  }

  return node;
}

/**
 * Serialize builder rows into an Avro record schema object, or null when the
 * state is incomplete (no record name or no named fields).
 */
export function buildAvroDocument(
  name: string,
  namespace: string,
  doc: string,
  fields: AvroField[]
): Record<string, unknown> | null {
  const named = fields.filter((f) => f.name.trim());
  if (!name.trim() || named.length === 0) return null;

  const schema: Record<string, unknown> = {
    type: "record",
    name: name.trim(),
    fields: named.map(buildAvroFieldNode),
  };
  if (namespace.trim()) schema.namespace = namespace.trim();
  if (doc.trim()) schema.doc = doc.trim();
  return schema;
}

/** Same as {@link buildAvroDocument} but returns a pretty JSON string. */
export function serializeAvroSchema(
  name: string,
  namespace: string,
  doc: string,
  fields: AvroField[]
): string | null {
  const document = buildAvroDocument(name, namespace, doc, fields);
  return document ? JSON.stringify(document, null, 2) : null;
}
