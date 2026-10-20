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
 * What the DDL cannot say about a column (a decimal's precision and scale, a url stored as text, ...) is a NOTE in the table's
 * comment, after the entity's description (see db-column-types.ts): the comment is the mechanism, not a warning.
 *
 * Pure function — no side effects, no I/O.
 */

import type {
  SuperSchemaModel,
  SuperSchemaField,
} from "@/types/super-schema-model";
import { escapeString, propertyName, sanitizeIdentifier } from "@/lib/compiler/typespec-identifiers";
import { isReservedWord, POSTGRES_SYSTEM_COLUMNS } from "./sql-reserved-words";
import { mapType, stringMaxLength, tableComment, tableNotes, type DbDialect } from "./db-column-types";
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
}

// A field's description is its column's `@doc`; the entity's description is the table's. The emitters (built with the
// sibling write.ts patch, docs/events/REVIEW.md gap 15) write a column's as `col TYPE, -- text` (Spanner, PostgreSQL: the
// comma comes first, so the comment cannot swallow it) or `OPTIONS(description='...')` (BigQuery, which escapes `\` and
// `'` itself), and the table's as a comment line before CREATE TABLE.
// Models in a `@schema` namespace are tables, so no `@table` is needed (the packages have none). They have no
// decimal-precision decorator either: a decimal column is emitted as NUMERIC without precision and scale.
const DIALECTS: Record<DbDialect, DialectConfig> = {
  spanner: { library: "@typespec/spanner", namespace: "TypeSpec.Spanner", displayName: "Cloud Spanner", writesSchemaName: false },
  postgres: { library: "@typespec/postgres", namespace: "TypeSpec.Postgres", displayName: "PostgreSQL", writesSchemaName: true },
  bigquery: { library: "@typespec/bigquery", namespace: "TypeSpec.BigQuery", displayName: "BigQuery", writesSchemaName: true },
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

/**
 * Collapse line breaks (the DDL puts a description in a one-line comment or a one-line quoted string). Besides CR, LF and
 * CRLF this takes the other characters that tools split a line on (VT, FF, NEL, LS, PS: Python's `splitlines()` ends a
 * `--` comment at U+2028, and what follows would run as SQL).
 */
const oneLine = (text: string): string => text.replace(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/g, " ");

/** A description as the DDL carries it: one line, ends trimmed; null when nothing is left (an empty comment is noise). */
function descriptionText(description: string | undefined): string | null {
  const text = oneLine(description ?? "").trim();
  return text === "" ? null : text;
}

/** The `@doc("…")` decorator for text: one line, then escaped for a TypeSpec string (`\`, `"`, `${`, tab, …). */
const docDecorator = (text: string): string => `@doc("${escapeString(oneLine(text))}")`;

const NO_NAME = "it has no letters or digits that the database dialects accept. Rename it.";

/** `"a"`, `"a" and "b"`, `"a", "b" and "c"`. */
function quotedList(names: string[]): string {
  const quoted = names.map((name) => `"${name}"`);
  return quoted.length === 1 ? quoted[0] : `${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}`;
}

/**
 * What a dialect limits in an identifier (the DDL carries the name as written: the emitters never shorten it). PostgreSQL
 * counts bytes and truncates silently, which turns two long names with the same start into one column; Spanner and
 * BigQuery count characters and reject. Our names are ASCII (`sqlWord`), so bytes and characters agree.
 */
const IDENTIFIER_LIMITS: Record<DbDialect, { table: number; schema: number; column: number; unit: string }> = {
  spanner: { table: 128, schema: 128, column: 128, unit: "characters" },
  postgres: { table: 63, schema: 63, column: 63, unit: "bytes" },
  bigquery: { table: 1024, schema: 1024, column: 300, unit: "characters" },
};

/** BigQuery rejects a column description over this many characters (`OPTIONS(description=...)`). */
const BIGQUERY_MAX_DESCRIPTION = 1024;

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

/** Warnings for an identifier the emitters write unquoted but SQL would need quoted, or that the dialect cannot hold. */
function identifierWarnings(dialect: DbDialect, kind: "table" | "schema" | "column", name: string): string[] {
  const where = DIALECTS[dialect].displayName;
  const remedy = `Rename the ${kind === "table" ? "entity" : kind === "schema" ? "domain" : "field"}, or quote the name in the DDL by hand.`;
  const notRunnable = "the generated DDL does not quote it, so it will not run as is";
  const warnings: string[] = [];
  // PostgreSQL's emitter always writes `schema.table`, and a reserved word is fine after the dot (checked on PGlite:
  // `payments.order` runs). Whether BigQuery's `dataset.order` is fine too is NOT verified, so it keeps the warning.
  const qualifiedByPostgres = dialect === "postgres" && kind === "table";
  if (!qualifiedByPostgres && isReservedWord(dialect, name)) warnings.push(`The ${kind} "${name}" is a reserved word in ${where} and ${notRunnable}. ${remedy}`);
  if (/^[0-9]/.test(name)) warnings.push(`The ${kind} "${name}" starts with a digit, which ${where} does not allow in an unquoted name, and ${notRunnable}. ${remedy}`);
  if (dialect === "postgres" && kind === "column" && POSTGRES_SYSTEM_COLUMNS.has(name.toLowerCase())) {
    warnings.push(`The column "${name}" has the name of a PostgreSQL system column, so the table cannot be created. Rename the field.`);
  }
  const limit = IDENTIFIER_LIMITS[dialect];
  const size = dialect === "postgres" ? byteLength(name) : name.length;
  if (size > limit[kind]) warnings.push(`The ${kind} "${name}" is longer than ${where}'s limit of ${limit[kind]} ${limit.unit} and will be truncated or rejected.`);
  return warnings;
}

/** PostgreSQL cuts an identifier to 63 bytes: columns that differ only after that become one column. */
function truncationWarnings(columnNames: readonly string[]): string[] {
  const limit = IDENTIFIER_LIMITS.postgres.column;
  const groups = new Map<string, string[]>();
  for (const name of columnNames) {
    if (byteLength(name) <= limit) continue;
    const key = name.slice(0, limit);
    groups.set(key, [...(groups.get(key) ?? []), name]);
  }
  return [...groups.values()]
    .filter((names) => names.length > 1)
    .map((names) => `The columns ${quotedList(names)} share their first ${limit} bytes, which PostgreSQL truncates names to, so they would become one column. Rename ${names.length > 2 ? "all but one of them" : "one of them"}.`);
}

/** Warnings about a field that the column name or the column description cannot carry faithfully. */
function fieldWarnings(dialect: DbDialect, field: SuperSchemaField, column: string, columnDocText: string | null): string[] {
  const warnings: string[] = [];
  // `aB` -> `a_b` is plain case/underscore normalisation and not worth a word; a LETTER or digit that is not a-z/0-9
  // (an accent, a non-Latin character) is dropped by the identifier rules, so the column no longer spells the field.
  if (Array.from(field.name).some((char) => char.charCodeAt(0) > 127 && /[\p{L}\p{N}]/u.test(char))) {
    warnings.push(`The field "${field.name}" is written as the column "${column}": letters outside a-z were dropped.`);
  }
  if (dialect === "bigquery" && columnDocText !== null && columnDocText.length > BIGQUERY_MAX_DESCRIPTION) {
    warnings.push(`The description of the field "${field.name}" is longer than BigQuery's limit of ${BIGQUERY_MAX_DESCRIPTION.toLocaleString("en-US")} characters, so BigQuery will reject the DDL as is. Shorten it.`);
  }
  return warnings;
}

/** The column name the DDL will contain for a field called `fieldName` (what the builder's collision check compares). */
export function emittedColumnName(fieldName: string): string {
  return emittedName(sqlWord(fieldName));
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
  for (const { field, ident } of columns) {
    const column = emittedName(ident);
    const description = descriptionText(field.decorators?.semantics?.description || field.description);
    warnings.push(...identifierWarnings(dialect, "column", column), ...fieldWarnings(dialect, field, column, description));
  }
  if (dialect === "postgres") warnings.push(...truncationWarnings(columns.map(({ ident }) => emittedName(ident))));

  const keyFields = sorted.filter((f) => f.isKey);
  const multiKey = keyFields.length > 1;

  const lines: string[] = [];
  lines.push(`import "${cfg.library}";`, "", `using ${cfg.namespace};`, "");
  lines.push(`@schema("${escapeString(schemaName)}")`);
  lines.push(`namespace ${ns};`, "");

  // The table's comment: the entity's description, then the notes for every column the DDL cannot state as declared.
  const notes = tableNotes(dialect, cfg.displayName, columns.map(({ field, ident }) => ({ field, column: emittedName(ident) })));
  const tableText = tableComment(dialect, descriptionText(model.entity.description), notes);
  if (tableText !== null) {
    lines.push(docDecorator(tableText));
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

    const maxLen = stringMaxLength(f);
    if (maxLen !== undefined) {
      decs.push(`@maxLength(${maxLen})`);
    }

    const desc = descriptionText(f.decorators?.semantics?.description || f.description);
    if (desc !== null) {
      decs.push(docDecorator(desc));
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
