// src/features/events/builder/properties-schema.ts
// The pure side of the Properties table: a set of message properties is the JSON Schema object `spec.headers`
// (`{ type: "object", properties, required }`); the table shows one row per property with a friendly type, and edits write the
// schema back. A row keeps the property's WHOLE raw schema and every edit merges into it, so anything the table has no column for
// (`const`, `format`, `pattern`, nested keys, `x-` extensions) survives untouched. Never depends on object key order: rows read
// `required` first (in `required` order), then the other properties in the order the object lists them. Pure — no React.
import type { JsonObject, JsonValue } from "@/lib/event-specs/types";
import type { PropertySummaryRow } from "@/lib/events/bundled-traits";
import { isJsonObject } from "@/lib/events/inputs";

export type PropertyType = "text" | "integer" | "number" | "boolean" | "date-time" | "link";

/** The types a user picks from, in the order they are offered. */
export const PROPERTY_TYPES: ReadonlyArray<{ value: PropertyType; label: string }> = [
  { value: "text", label: "Text" },
  { value: "integer", label: "Whole number" },
  { value: "number", label: "Decimal" },
  { value: "boolean", label: "True/false" },
  { value: "date-time", label: "Date-time" },
  { value: "link", label: "Link" },
];

/** `format` values the friendly types write or read: changing the type replaces these and leaves any other format alone. */
const MANAGED_FORMATS = new Set(["date-time", "uri", "uri-reference"]);
const LINK_FORMATS = new Set(["uri", "uri-reference"]);

/** The JSON Schema of one property: an object, or the booleans (`true`/`false`) JSON Schema allows. */
export type PropertySchema = JsonObject | boolean;

/** One row of the editable table. `id` is a local identity (not stored); `schema` is the property's raw schema. */
export interface PropertyRow { id: string; name: string; schema: PropertySchema; required: boolean }

/** The allowed values of a property: `const` (always this value) or `enum` (one of these). */
export interface AllowedValues { kind: "const" | "enum"; values: string[] }

/** A row as the read-only table shows it. */
export interface DisplayRow {
  name: string;
  /** "Text", "Whole number", … — or the raw type (`array`, `object`) when no friendly name exists. */
  type: string;
  required: boolean;
  description: string;
  allowed: AllowedValues | null;
}

const isPrimitive = (v: unknown): v is string | number | boolean => typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/** The friendly type of a schema, or null when it has none (an array, an object, a union, no type at all, an unmanaged string format stays Text). */
export function friendlyType(schema: unknown): PropertyType | null {
  if (!isJsonObject(schema)) return null;
  const { type, format } = schema;
  if (type === "integer") return "integer";
  if (type === "number") return "number";
  if (type === "boolean") return "boolean";
  if (type === "string") {
    if (format === "date-time") return "date-time";
    if (typeof format === "string" && LINK_FORMATS.has(format)) return "link";
    return "text";
  }
  return null;
}

const FRIENDLY_LABELS = new Map<PropertyType, string>(PROPERTY_TYPES.map((t) => [t.value, t.label]));

/** What the Type column says: the friendly name, `Text (email)` for a string with some other format, else the raw JSON Schema type. */
export function typeLabel(schema: unknown): string {
  const friendly = friendlyType(schema);
  if (friendly && isJsonObject(schema)) {
    const format = schema.format;
    const label = FRIENDLY_LABELS.get(friendly) ?? friendly;
    return friendly === "text" && typeof format === "string" && format !== "" ? `${label} (${format})` : label;
  }
  if (!isJsonObject(schema)) return schema === false ? "Nothing" : "Any";
  const { type } = schema;
  if (typeof type === "string" && type !== "") return type === "array" ? "List" : type === "object" ? "Object" : type;
  if (Array.isArray(type) && type.length > 0 && type.every((t) => typeof t === "string")) return type.join(" or ");
  return "Any";
}

/** The Type column text for a row that only has the loader's summary (`string (date-time)`): the same friendly names, else the text as given. */
export function summaryTypeLabel(summaryType: string): string {
  const match = /^([a-z]+)(?: \(([^)]+)\))?$/.exec(summaryType);
  if (!match) return summaryType;
  const [, base, format] = match;
  const schema: JsonObject = { type: base, ...(format ? { format } : {}) };
  return friendlyType(schema) ? typeLabel(schema) : summaryType === "any" ? "Any" : summaryType;
}

/** The description of a property schema, or "". */
export function descriptionOf(schema: unknown): string {
  return isJsonObject(schema) && typeof schema.description === "string" ? schema.description : "";
}

/** `enum` (a list of simple values) wins over `const`; null when the schema restricts nothing. */
export function allowedValues(schema: unknown): AllowedValues | null {
  if (!isJsonObject(schema)) return null;
  if (Array.isArray(schema.enum)) {
    const values = schema.enum.filter(isPrimitive).map(String);
    if (values.length > 0) return { kind: "enum", values };
  }
  if (isPrimitive(schema.const)) return { kind: "const", values: [String(schema.const)] };
  return null;
}

/** The table rows of `headers` (the `spec.headers` schema): required first, in `required` order, then the rest in the order given. */
export function readRows(headers: unknown, nextId: () => string): PropertyRow[] {
  if (!isJsonObject(headers) || !isJsonObject(headers.properties)) return [];
  const properties = headers.properties;
  const requiredList = Array.isArray(headers.required) ? headers.required.filter((r): r is string => typeof r === "string") : [];
  const requiredNames = new Set(requiredList);
  const names = [
    ...new Set(requiredList.filter((name) => Object.hasOwn(properties, name))),
    ...Object.keys(properties).filter((name) => !requiredNames.has(name)),
  ];
  return names.map((name): PropertyRow => {
    const schema = properties[name];
    return { id: nextId(), name, schema: isJsonObject(schema) || typeof schema === "boolean" ? schema : {}, required: requiredNames.has(name) };
  });
}

/** The rows that can be stored: a name, and not a name an earlier row already has. */
function storable(rows: PropertyRow[]): PropertyRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const name = row.name.trim();
    if (name === "" || seen.has(name)) return false;
    seen.add(name);
    return true;
  });
}

/** The names that a row shares with an earlier row (they are not stored, and the table says so). */
export function duplicateNames(rows: PropertyRow[]): Set<string> {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const row of rows) {
    const name = row.name.trim();
    if (name === "") continue;
    if (seen.has(name)) dup.add(name);
    seen.add(name);
  }
  return dup;
}

/**
 * `spec.headers` for `rows`: `{ type: "object", properties, required }` (`required` only when something is required), or undefined
 * when there is nothing to store (no rows with a usable name), which removes `headers` from the spec. `base` is the previous headers
 * schema: keys the table does not manage (`additionalProperties`, `title`, …) are carried over.
 */
export function writeHeaders(rows: PropertyRow[], base?: unknown): JsonObject | undefined {
  const usable = storable(rows);
  if (usable.length === 0) return undefined;
  const rest: JsonObject = {};
  if (isJsonObject(base)) for (const [k, v] of Object.entries(base)) if (k !== "properties" && k !== "required" && k !== "type") rest[k] = v;
  const properties: JsonObject = {};
  for (const row of usable) properties[row.name.trim()] = row.schema;
  const required = usable.filter((r) => r.required).map((r) => r.name.trim());
  return { type: "object", ...rest, properties, ...(required.length > 0 ? { required } : {}) };
}

const asObject = (schema: PropertySchema): JsonObject => (isJsonObject(schema) ? { ...schema } : {});

/** `schema` as the friendly `type`: unchanged when it already is that type (a `uri-reference` stays one), otherwise only `type` and the managed `format` are rewritten. */
export function setType(schema: PropertySchema, type: PropertyType): PropertySchema {
  if (friendlyType(schema) === type) return schema;
  const next = asObject(schema);
  if (typeof next.format === "string" && MANAGED_FORMATS.has(next.format)) delete next.format;
  switch (type) {
    case "text": next.type = "string"; break;
    case "integer": next.type = "integer"; break;
    case "number": next.type = "number"; break;
    case "boolean": next.type = "boolean"; break;
    case "date-time": next.type = "string"; next.format = "date-time"; break;
    case "link": next.type = "string"; next.format = "uri"; break;
  }
  return next;
}

/** `schema` with the description set, or removed when the text is empty. */
export function setDescription(schema: PropertySchema, text: string): PropertySchema {
  const next = asObject(schema);
  if (text === "") delete next.description;
  else next.description = text;
  return next;
}

const asNumberIfNumeric = (text: string): string | number => (text.trim() !== "" && Number.isFinite(Number(text)) ? Number(text) : text);

/**
 * `schema` restricted to `values`. One value on a property that had `const` stays a `const`; otherwise a list is an `enum`; an empty list
 * removes both. Whole numbers and decimals store numbers, true/false stores booleans, everything else the text as typed.
 */
export function setAllowedValues(schema: PropertySchema, values: string[]): PropertySchema {
  const next = asObject(schema);
  const hadConst = Object.hasOwn(next, "const");
  delete next.const;
  delete next.enum;
  if (values.length === 0) return next;
  const type = friendlyType(schema);
  const typed = values.map((v): JsonValue => {
    if (type === "integer" || type === "number") return asNumberIfNumeric(v);
    if (type === "boolean" && (v === "true" || v === "false")) return v === "true";
    return v;
  });
  if (typed.length === 1 && hadConst) next.const = typed[0];
  else next.enum = typed;
  return next;
}

/** Whether two JSON values are equal, ignoring the order of object keys (arrays keep theirs): a database round trip re-sorts keys. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
  }
  if (isJsonObject(a) && isJsonObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]));
  }
  return false;
}

/** The read-only rows of a headers schema, in the table's order. */
export function displayRowsFromHeaders(headers: unknown): DisplayRow[] {
  let n = 0;
  return readRows(headers, () => `r${++n}`).map((row) => ({
    name: row.name, type: typeLabel(row.schema), required: row.required, description: descriptionOf(row.schema), allowed: allowedValues(row.schema),
  }));
}

/** The read-only rows of the loader's property summary (no allowed values: the summary does not carry them). */
export function displayRowsFromSummary(rows: ReadonlyArray<PropertySummaryRow>): DisplayRow[] {
  return rows.map((r) => ({ name: r.name, type: summaryTypeLabel(r.type), required: r.required, description: r.description ?? "", allowed: null }));
}
