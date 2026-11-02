/**
 * db-column-types.ts — what a field becomes in the three database emitters (@typespec/spanner, @typespec/postgres,
 * @typespec/bigquery), and the table notes for what the database cannot say about it.
 *
 * The builder in db-source.ts writes a field as a TypeSpec scalar ({@link TYPE_MAP}, {@link scalarOf}); each emitter prints
 * that scalar as a column type of its own ({@link emittedColumnType}, read from `packages/{spanner,postgres,bigquery}/src/
 * transform.ts` of the sibling repo, and checked against the real emitters by a test over every logical type). Where the
 * printed type is not what the field declares (precision and scale of a decimal, a `url` or `duration` stored as text, the
 * offset of an `offsetDateTime`, a `uint64` that does not fit a signed 64-bit integer) the table gets a NOTE in its comment:
 * the DDL looks complete and is not, and the comment is the only place to say so ({@link tableNotes}, {@link tableComment}).
 *
 * The notes contain constants, numbers, the builder's own type names and column names only. A column name is the emitted one
 * (a sanitised identifier); the field's own name follows in parentheses when it differs AND is a plain identifier
 * (`order_total (orderTotal)`). Nothing the user typed freely (a description, an unknown element type) is ever in a note.
 *
 * Pure functions, no I/O.
 */

import type { LogicalType, SuperSchemaField } from "@/types/super-schema-model";
import { ALL_DATA_TYPES } from "@/lib/data-types";
import type { ReservedWordDialect } from "./sql-reserved-words";

export type DbDialect = ReservedWordDialect;

/** The TypeSpec built-in scalars the builder writes (and the three emitters have a column type for). */
export type TspScalar =
  | "string" | "boolean" | "bytes"
  | "int8" | "int16" | "int32" | "int64" | "safeint" | "uint8" | "uint16" | "uint32" | "uint64"
  | "float32" | "float64" | "decimal" | "decimal128"
  | "plainDate" | "utcDateTime" | "offsetDateTime";

/**
 * Logical IR type → TypeSpec built-in scalar the emitters understand. `url`, `plainTime` and `duration` have no column
 * type in any of the three emitters (they skip the field with an `unsupported-type` warning and write the table without
 * it), so they are stored as their text form. Every other logical type is a scalar below, or `array` / `enum` / `map` /
 * `object` / `reference`, which {@link scalarOf} and {@link mapType} turn into a string.
 */
export const TYPE_MAP: Partial<Record<LogicalType, TspScalar>> = {
  string: "string",
  url: "string",
  integer: "int64",
  int8: "int8",
  int16: "int16",
  int32: "int32",
  int64: "int64",
  safeint: "safeint",
  uint8: "uint8",
  uint16: "uint16",
  uint32: "uint32",
  uint64: "uint64",
  numeric: "decimal",
  float: "float64",
  float32: "float32",
  float64: "float64",
  decimal: "decimal",
  decimal128: "decimal128",
  boolean: "boolean",
  bytes: "bytes",
  plainDate: "plainDate",
  plainTime: "string",
  utcDateTime: "utcDateTime",
  offsetDateTime: "offsetDateTime",
  duration: "string",
  unixTimestamp32: "int32",
};

/** The scalar a logical type (or an array's element type) is written as; what has none (enum, map, object, reference, unset, unknown) is a string. */
export function scalarOf(type: string | undefined): TspScalar {
  // own keys only: an element type from the client may be `constructor` or `__proto__`
  return (type !== undefined && Object.hasOwn(TYPE_MAP, type) ? TYPE_MAP[type as LogicalType] : undefined) ?? "string";
}

/**
 * The logical types a note may name: the builder's own table plus the four it stores as text. Anything else (a stale
 * type, an array element type the client typed freely) is never printed: a note holds no text we did not write.
 */
const NAMEABLE_TYPES: ReadonlySet<string> = new Set([...Object.keys(TYPE_MAP), "enum", "map", "object", "reference"]);

/**
 * The element type of an array field, or undefined for any other field or an array whose element type was never set. It is
 * unvalidated client data (`decorators.arrayElementType`): only a non-empty string counts, a number or an object is "never set".
 */
function elementType(field: SuperSchemaField): string | undefined {
  if (field.type !== "array") return undefined;
  const raw: unknown = field.complexType?.arrayElementType;
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}
/** The TypeSpec type of a field's property: its scalar, or `scalar[]` for an array. */
export function mapType(field: SuperSchemaField): string {
  return field.type === "array" ? `${scalarOf(elementType(field))}[]` : scalarOf(field.type);
}

/** The field types a column can be written for: the app's data types and a union (its members are declared where they are). */
const COLUMN_TYPES: ReadonlySet<string> = new Set<string>([...ALL_DATA_TYPES, "union"]);

/**
 * The type name a field carries that is not a type of this app (a row written before the writers refused it, such as a model
 * or scalar name), or null when the field's type, or its array's element type, is one of the app's. An array whose element
 * type was never set is not unknown. {@link buildDbTypeSpecTarget} refuses such a field: {@link scalarOf} would otherwise write
 * it as a string column, with no diagnostic.
 */
export function unknownColumnType(field: SuperSchemaField): string | null {
  const written = field.type === "array" ? elementType(field) : field.type;
  return written === undefined || COLUMN_TYPES.has(written) ? null : written;
}

/**
 * The maximum length the builder passes on (`@maxLength`) and the emitters print: a `string` field's. The emitters read it
 * from the property, so an array's elements and every other type (a `url` too) carry none.
 */
export function stringMaxLength(field: SuperSchemaField): number | undefined {
  const max = field.decorators?.typespec?.validation?.maxLength;
  return field.type === "string" && typeof max === "number" && max > 0 ? max : undefined;
}

/** The column type an emitter prints for a scalar (`packages/<dialect>/src/transform.ts`, `mapScalarTo<Dialect>Type`). */
function printedScalar(dialect: DbDialect, scalar: TspScalar, maxLength?: number): string {
  const postgres = dialect === "postgres";
  switch (scalar) {
    case "string":
      if (postgres) return maxLength === undefined ? "TEXT" : `VARCHAR(${maxLength})`;
      if (dialect === "spanner") return `STRING(${maxLength ?? "MAX"})`;
      return maxLength === undefined ? "STRING" : `STRING(${maxLength})`;
    case "boolean":
      return postgres ? "BOOLEAN" : "BOOL";
    case "bytes":
      return postgres ? "BYTEA" : dialect === "spanner" ? "BYTES(MAX)" : "BYTES";
    case "int8":
    case "int16":
    case "uint8":
    case "uint16":
      return postgres ? "SMALLINT" : "INT64";
    case "int32":
    case "uint32":
      return postgres ? "INTEGER" : "INT64";
    case "int64":
    case "safeint":
    case "uint64":
      return postgres ? "BIGINT" : "INT64";
    case "float32":
      return postgres ? "REAL" : dialect === "spanner" ? "FLOAT32" : "FLOAT64";
    case "float64":
      return postgres ? "DOUBLE PRECISION" : "FLOAT64";
    case "decimal":
    case "decimal128":
      return "NUMERIC";
    case "plainDate":
      return "DATE";
    case "utcDateTime":
    case "offsetDateTime":
      return postgres ? "TIMESTAMPTZ" : "TIMESTAMP";
  }
}

/** The column type the DDL carries for a field: `NUMERIC`, `TEXT`, `STRING(50)`, `ARRAY<STRING(MAX)>`, `TIMESTAMPTZ[]` ... */
export function emittedColumnType(dialect: DbDialect, field: SuperSchemaField): string {
  if (field.type !== "array") return printedScalar(dialect, scalarOf(field.type), stringMaxLength(field));
  const element = printedScalar(dialect, scalarOf(elementType(field)));
  return dialect === "postgres" ? `${element}[]` : `ARRAY<${element}>`;
}

// ---------------------------------------------------------------------------
// Table notes
// ---------------------------------------------------------------------------

/**
 * The notes block of a table comment is cut at this many characters, for every dialect (a `-- ` comment line has no engine
 * limit in any of them), ending `- ...and N more.`.
 */
export const NOTES_LIMIT = 2000;
const NOTES_HEAD = "Notes:";

/** The declared types the builder writes as a decimal: the emitters print all of them as NUMERIC, without precision or scale. */
const DECIMAL_TYPES: ReadonlySet<string> = new Set(["numeric", "decimal", "decimal128"]);

/** Largest value of the printed integer type, for an unsigned type that can exceed it; null when everything the type holds fits. */
function integerCeiling(dialect: DbDialect, scalar: TspScalar): string | null {
  if (scalar === "uint64") return "9223372036854775807"; // INT64 and BIGINT are signed 64-bit in all three
  if (dialect === "postgres" && scalar === "uint32") return "2147483647"; // INTEGER
  if (dialect === "postgres" && scalar === "uint16") return "32767"; // SMALLINT
  return null;
}

const isPlainIdentifier = (name: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);

/** `decimal(19,4)`, `decimal(19)`, `decimal(scale 4)`, or just `decimal` when nothing was declared. */
function declaredDecimal(type: string, precision: number | undefined, scale: number | undefined): string {
  if (precision !== undefined && scale !== undefined) return `${type}(${precision},${scale})`;
  if (precision !== undefined) return `${type}(${precision})`;
  if (scale !== undefined) return `${type}(scale ${scale})`;
  return type;
}

const numberOrUndefined = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/**
 * The note for one column, or null when the DDL type says what the field declares. No `.` at the end: a note is one line of
 * the table comment (`- <note>`).
 * - a decimal with a declared precision or scale: NUMERIC has none (PostgreSQL) or a fixed one (38 and 9 in Spanner and BigQuery);
 * - a type the DDL has no column for (url, plainTime, duration, enum, reference, map, object, an array of those, an array
 *   with no element type): stored as text; a `url`'s declared maximum length is lost with it;
 * - an offsetDateTime (the instant is kept, the offset is not) and a unixTimestamp32 (a plain integer);
 * - an unsigned integer whose DDL type tops out lower (uint64 everywhere; uint32 and uint16 on PostgreSQL).
 * Not noted: a narrower integer in a wider column, a float32 in FLOAT64, an `integer` (arbitrary precision) in a 64-bit
 * integer, a decimal that declared no precision: the DDL type holds everything the field can and nobody is misled.
 *
 * A note holds only words, numbers and identifiers we wrote: a type is named when it is one of the builder's own
 * ({@link NAMEABLE_TYPES}), otherwise it is `array` (an element type we do not know) or `unknown`.
 */
export function columnNote(dialect: DbDialect, displayName: string, column: string, field: SuperSchemaField): string | null {
  const array = field.type === "array";
  const element = array ? elementType(field) : field.type;
  const label = column !== field.name && isPlainIdentifier(field.name) ? `${column} (${field.name})` : column;
  const printed = emittedColumnType(dialect, field);
  const scalar = scalarOf(element);
  const nameable = element !== undefined && NAMEABLE_TYPES.has(element) ? element : undefined;
  const brackets = array && nameable !== undefined ? "[]" : "";
  const declaredName = nameable ?? (array ? "array" : "unknown"); // an array with no (known) element type has nothing more to name

  if (element !== undefined && DECIMAL_TYPES.has(element)) {
    const precision = numberOrUndefined(array ? field.complexType?.arrayElementPrecision : field.precision);
    const scale = numberOrUndefined(array ? field.complexType?.arrayElementScale : field.scale);
    if (precision === undefined && scale === undefined) return null;
    const declared = `${declaredDecimal(element, precision, scale)}${brackets}`;
    const subject = array ? "whose elements" : "which";
    const consequence = dialect === "postgres" ? "and does not enforce precision or scale" : `${subject} ${displayName} fixes at precision 38 and scale 9`;
    const separator = dialect === "postgres" ? " " : ", ";
    return `${label}: declared ${declared}; the DDL type is ${printed}${separator}${consequence}`;
  }

  const declared = `${declaredName}${brackets}`;
  if (element === undefined || (scalar === "string" && element !== "string")) {
    // a `url` that declared a maximum length: it is not passed on (only a `string`'s is), so the DDL type has none
    const lostLength = !array && field.type === "url" ? numberOrUndefined(field.decorators?.typespec?.validation?.maxLength) : undefined;
    if (lostLength !== undefined && lostLength > 0) {
      return `${label}: declared ${declared} with maximum length ${lostLength}; stored as ${printed}, which does not carry the maximum length`;
    }
    return `${label}: declared ${declared}; stored as ${printed}`;
  }
  if (element === "offsetDateTime") return `${label}: declared ${declared}; stored as ${printed}, which keeps the instant but not the UTC offset`;
  if (element === "unixTimestamp32") return `${label}: declared ${declared}; stored as ${printed}, a plain number without a date or time type`;
  const ceiling = integerCeiling(dialect, scalar);
  if (ceiling !== null) return `${label}: declared ${declared}; stored as ${printed}, which cannot hold values above ${ceiling}`;
  return null;
}

/** The notes of a table's columns, in column order. `columns` pair each field with the column name the DDL has. */
export function tableNotes(dialect: DbDialect, displayName: string, columns: ReadonlyArray<{ column: string; field: SuperSchemaField }>): string[] {
  const notes: string[] = [];
  for (const { column, field } of columns) {
    const note = columnNote(dialect, displayName, column, field);
    if (note !== null) notes.push(note);
  }
  return notes;
}

/**
 * `<description>`, then `Notes:` and one `- <note>` line per note: the lines of the table comment, joined by real line
 * breaks (the emitters split the table's doc on `\n` and write each line as `-- <line>`). With no description the comment
 * starts at `Notes:`; with no notes it is the description alone (null when there is neither). The description is one line
 * already ({@link descriptionText} in db-source.ts) and a note holds no line break.
 *
 * The notes block (from `Notes:` on) is cut at {@link NOTES_LIMIT} characters, on a whole-note boundary, with a last line
 * `- ...and N more.` counting the notes left out. The description is never cut.
 */
export function tableComment(description: string | null, notes: readonly string[]): string | null {
  if (notes.length === 0) return description;
  // the block's length as notes are added: `Notes:`, then `\n- <note>` for each; a cut block ends with `\n- ...and N more.`
  let kept = 0;
  let length = NOTES_HEAD.length;
  for (let count = 1; count <= notes.length; count++) {
    length += 3 + notes[count - 1].length;
    const tail = count === notes.length ? 0 : 3 + `...and ${notes.length - count} more.`.length;
    if (length + tail <= NOTES_LIMIT) kept = count;
  }
  const lines = [NOTES_HEAD, ...notes.slice(0, kept).map((note) => `- ${note}`)];
  if (kept < notes.length) lines.push(`- ...and ${notes.length - kept} more.`);
  const block = lines.join("\n");
  return description === null ? block : `${description}\n${block}`;
}
