/**
 * db-source.ts — builds TypeSpec (.tsp) source for the database emitter
 * packages (@typespec/spanner, @typespec/postgres, @typespec/bigquery) from a
 * SuperSchemaModel.
 *
 * These emitters read the logical shape from TypeSpec models + THEIR OWN
 * decorators (`@schema`, `@primaryKey`, ...), then emit dialect DDL. Each package
 * is self-contained: it declares those decorators itself and its emitter reads
 * the state of its own decorators only. A decorator of another library (a shared
 * "db" library with the same names would compile) is invisible to the emitter,
 * which then writes no file (`@schema` from the wrong library = no schema
 * namespace = no table). So the source below imports and uses exactly one
 * library: the dialect's. This builder is the bridge from our IR to that
 * authoring surface.
 *
 * It also answers for what the emitters do not: a name that cannot become a SQL
 * identifier is an ERROR naming the field/entity/domain, and an identifier the
 * emitters would write unquoted although SQL needs quotes (a reserved word, a
 * leading digit) is a WARNING — the DDL looks fine and does not run.
 *
 * Pure function — no side effects, no I/O.
 */

import type {
  SuperSchemaModel,
  SuperSchemaField,
  LogicalType,
} from "@/types/super-schema-model";
import { escapeString, propertyName, sanitizeIdentifier } from "@/lib/compiler/typespec-identifiers";
import { isReservedWord, type ReservedWordDialect } from "./sql-reserved-words";

type DbDialect = ReservedWordDialect;

const TARGET_TO_DIALECT: Record<string, DbDialect> = {
  spanner: "spanner",
  postgresql: "postgres",
  bigquery: "bigquery",
};

/** True if the target key routes through the DB TypeSpec source builder. */
export function isDbTypeSpecTarget(targetKey: string): boolean {
  return targetKey in TARGET_TO_DIALECT;
}

interface DialectConfig {
  /** The dialect's emitter package: the only library the generated source imports. */
  library: string;
  /** Its TypeSpec namespace (`using`): it carries the decorators the emitter reads. */
  namespace: string;
  /** The dialect as a person names it (warnings). */
  displayName: string;
  /** Does the dialect's DDL name the schema? (Spanner's emitter writes `CREATE TABLE <table>` only.) */
  writesSchemaName: boolean;
  /**
   * How a field description is put on its column (`@doc`), or null for no column docs. The emitters write it into the
   * DDL themselves, and two of them do it in a way that makes the DDL invalid (reproduced; sibling repo
   * `packages/{spanner,postgres,bigquery}/src/write.ts`):
   * - Spanner and PostgreSQL write ` -- <text>` and append the column's comma AFTER it, so the comma becomes part of
   *   the comment: no column docs for those two (null). Switch them on once the emitters write the comma first.
   * - BigQuery writes `OPTIONS(description='<text>')` without escaping, so an apostrophe ends the string early: the
   *   text is escaped for a single-quoted GoogleSQL string here. Drop the function once the emitter escapes it itself.
   * The table's own `@doc` is a comment line of its own in every dialect and is always kept.
   */
  columnDoc: ((description: string) => string) | null;
}

/** Text for a single-quoted SQL string literal: the backslash and the quote are backslash-escaped. */
const escapeSqlString = (text: string): string => text.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

// Models in a `@schema` namespace are tables, so no `@table` is needed (the packages have none). They have no
// decimal-precision decorator either: a decimal column is emitted as NUMERIC without precision and scale.
const DIALECTS: Record<DbDialect, DialectConfig> = {
  spanner: { library: "@typespec/spanner", namespace: "TypeSpec.Spanner", displayName: "Cloud Spanner", writesSchemaName: false, columnDoc: null },
  postgres: { library: "@typespec/postgres", namespace: "TypeSpec.Postgres", displayName: "PostgreSQL", writesSchemaName: true, columnDoc: null },
  bigquery: { library: "@typespec/bigquery", namespace: "TypeSpec.BigQuery", displayName: "BigQuery", writesSchemaName: true, columnDoc: escapeSqlString },
};

/**
 * Logical IR type → TypeSpec built-in scalar the emitters understand. `url`, `plainTime` and `duration` have no column
 * type in any of the three emitters (they skip the field with an `unsupported-type` warning and write the table without
 * it), so they are stored as their text form. Every other logical type is a scalar below, or `array` / `enum` / `map` /
 * `object` / `reference`, which {@link mapType} handles.
 */
const TYPE_MAP: Partial<Record<LogicalType, string>> = {
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

/** A name made of the characters an unquoted SQL identifier has; a leading digit gets a `_`. May be empty of letters and digits. */
function sqlWord(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_]/g, "_");
  return /^[0-9]/.test(safe) ? `_${safe}` : safe;
}

/**
 * snake_case exactly as the three emitters apply it (their `naming-convention: snake_case`, which `buildEmitterOptions`
 * sets for every DB target): split `aB` -> `a_B`, split on `_`, `-` and whitespace, drop empty words, lower-case, join with `_`.
 * Used to know the name the DDL will really contain, so that two fields that end up with the same column are caught here.
 */
function emittedName(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .split(/[_\-\s]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase())
    .join("_");
}

/** PascalCase of the letters and digits of a name, or null when it has none (a name in a non-Latin script only). */
function pascal(name: string): string | null {
  const joined = name
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
  return joined || null;
}

/** Collapse line breaks (the DDL puts a description in a one-line comment or a one-line quoted string). */
const oneLine = (text: string): string => text.replace(/\r\n|\r|\n/g, " ");

/** The `@doc("…")` decorator for text: one line, then escaped for a TypeSpec string (`\`, `"`, `${`, tab, …). */
const docDecorator = (text: string): string => `@doc("${escapeString(oneLine(text))}")`;

function mapType(field: SuperSchemaField): string {
  if (field.type === "array") {
    const el = field.complexType?.arrayElementType as LogicalType | undefined;
    const elTsp = (el && TYPE_MAP[el]) || "string";
    return `${elTsp}[]`;
  }
  // v1: FK/enum/map/object fall back to string; complex modeling is a follow-up.
  if (field.type === "reference" || field.type === "enum" || field.type === "map" || field.type === "object") {
    return "string";
  }
  return TYPE_MAP[field.type] ?? "string";
}

const NO_NAME = "it has no letters or digits that the database dialects accept. Rename it.";

/** `"a"`, `"a" and "b"`, `"a", "b" and "c"`. */
function quotedList(names: string[]): string {
  const quoted = names.map((name) => `"${name}"`);
  return quoted.length === 1 ? quoted[0] : `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
}

/** Warnings for an identifier the emitters write unquoted but SQL would need quoted. */
function identifierWarnings(dialect: DbDialect, kind: "table" | "schema" | "column", name: string): string[] {
  const where = DIALECTS[dialect].displayName;
  const remedy = `Rename the ${kind === "table" ? "entity" : kind === "schema" ? "domain" : "field"}, or quote the name in the DDL by hand.`;
  const notRunnable = "the generated DDL does not quote it, so it will not run as is";
  const warnings: string[] = [];
  if (isReservedWord(dialect, name)) warnings.push(`The ${kind} "${name}" is a reserved word in ${where} and ${notRunnable}. ${remedy}`);
  if (/^[0-9]/.test(name)) warnings.push(`The ${kind} "${name}" starts with a digit, which ${where} does not allow in an unquoted name, and ${notRunnable}. ${remedy}`);
  return warnings;
}

/** The generated source for a DB target, the warnings about it, and the errors that stop it from being generated. */
export interface DbTypeSpecTarget {
  source: string;
  warnings: string[];
  errors: string[];
}

/**
 * Build a .tsp document for the given DB target from the SuperSchemaModel.
 * @param targetKey one of "spanner" | "postgresql" | "bigquery"
 */
export function buildDbTypeSpecTarget(model: SuperSchemaModel, targetKey: string): DbTypeSpecTarget {
  const dialect = TARGET_TO_DIALECT[targetKey];
  if (!dialect) {
    throw new Error(`buildDbTypeSpecSource: not a DB target "${targetKey}"`);
  }
  const cfg = DIALECTS[dialect];
  const errors: string[] = [];
  const warnings: string[] = [];

  // The entity is the table, the domain (or namespace) the schema: a name with no Latin letter or digit has no spelling.
  const modelBase = pascal(model.entity.name);
  if (modelBase === null) errors.push(`The entity "${model.entity.name}" cannot be turned into a table name: ${NO_NAME}`);
  const domainLabel = model.entity.domain || model.namespace;
  const schemaBase = domainLabel ? pascal(domainLabel) : null;
  if (domainLabel && schemaBase === null) errors.push(`The domain "${domainLabel}" cannot be turned into a schema name: ${NO_NAME}`);
  const modelName = sanitizeIdentifier(modelBase ?? "Model");
  const ns = sanitizeIdentifier(domainLabel ? (schemaBase ?? "Schema") : (pascal(model.entity.name) ?? "Model"));
  const schemaName = (domainLabel ? sqlWord(domainLabel) : "public").toLowerCase();

  const sorted = [...model.fields].sort((a, b) => a.sortOrder - b.sortOrder);
  const columns = sorted.map((field) => ({ field, ident: sqlWord(field.name) }));
  const byColumn = new Map<string, string[]>();
  for (const { field, ident } of columns) {
    const column = emittedName(ident);
    if (column === "") {
      errors.push(`The field "${field.name}" cannot be turned into a column name: ${NO_NAME}`);
      continue;
    }
    byColumn.set(column, [...(byColumn.get(column) ?? []), field.name]);
  }
  for (const [column, names] of byColumn) {
    if (names.length > 1) errors.push(`The fields ${quotedList(names)} would ${names.length > 2 ? "all" : "both"} become the column "${column}". Rename ${names.length > 2 ? "all but one of them" : "one of them"}.`);
  }
  if (errors.length > 0) return { source: "", warnings, errors };

  warnings.push(...identifierWarnings(dialect, "table", emittedName(modelName)));
  // the schema name goes into the DDL as written (the emitters apply the naming convention to tables and columns only)
  if (cfg.writesSchemaName) warnings.push(...identifierWarnings(dialect, "schema", schemaName));
  for (const { ident } of columns) warnings.push(...identifierWarnings(dialect, "column", emittedName(ident)));

  const keyFields = sorted.filter((f) => f.isKey);
  const multiKey = keyFields.length > 1;

  const lines: string[] = [];
  lines.push(`import "${cfg.library}";`, "", `using ${cfg.namespace};`, "");
  lines.push(`@schema("${escapeString(schemaName)}")`);
  lines.push(`namespace ${ns};`, "");

  if (model.entity.description) {
    lines.push(docDecorator(model.entity.description));
  }
  // Spanner age-based retention → real ROW DELETION POLICY (D6 escalation); only @typespec/spanner has the decorator.
  if (dialect === "spanner") {
    const rp = model.entity.metadata?.retentionPolicy;
    if (
      rp &&
      rp.strategy === "age-based" &&
      rp.referenceField &&
      typeof rp.period === "number" &&
      rp.periodUnit
    ) {
      const days =
        rp.periodUnit === "years"
          ? rp.period * 365
          : rp.periodUnit === "months"
            ? rp.period * 30
            : rp.period;
      lines.push(`@rowDeletionPolicy("${escapeString(sqlWord(rp.referenceField))}", ${days})`);
    }
  }
  lines.push(`model ${modelName} {`);

  for (const { field: f, ident } of columns) {
    const decs: string[] = [];

    if (f.isKey) {
      decs.push(multiKey ? `@primaryKey(${keyFields.indexOf(f) + 1})` : "@primaryKey");
    }

    const maxLen = f.decorators?.typespec?.validation?.maxLength;
    if (f.type === "string" && typeof maxLen === "number" && maxLen > 0) {
      decs.push(`@maxLength(${maxLen})`);
    }

    const desc = f.decorators?.semantics?.description || f.description;
    if (desc && cfg.columnDoc) {
      decs.push(docDecorator(cfg.columnDoc(oneLine(desc))));
    }

    // Primary keys are never nullable.
    const optional = f.nullable && !f.isKey ? "?" : "";
    const tsType = mapType(f);
    const prefix = decs.length ? `${decs.join(" ")} ` : "";
    lines.push(`  ${prefix}${propertyName(ident)}${optional}: ${tsType};`);
  }

  lines.push("}", "");
  return { source: lines.join("\n"), warnings, errors };
}

/** {@link buildDbTypeSpecTarget}'s source alone (the pure text contract; an unbuildable model gives ""). */
export function buildDbTypeSpecSource(model: SuperSchemaModel, targetKey: string): string {
  return buildDbTypeSpecTarget(model, targetKey).source;
}
