/**
 * sql-reserved-words.ts — reserved words per DB dialect, so the DB source builder can warn about a column, table or schema
 * name the generated DDL cannot use. The TypeSpec emitters (@typespec/spanner|postgres|bigquery) write identifiers UNQUOTED,
 * so `CREATE TABLE ... (order TEXT)` is a syntax error that no emitter reports.
 *
 * ADVISORY: written by hand from the documentation as of 2026 — PostgreSQL's "SQL Key Words" table (the words marked
 * "reserved" and "reserved (can be function or type)"), and the GoogleSQL "Lexical structure > Reserved keywords" list that
 * Cloud Spanner and BigQuery both document (the lists differ in a few entries over time). A word missing here is not proof
 * that it is safe, and a listed word may be accepted by a newer engine version. Lower case; compare case-insensitively
 * (SQL keywords are). Pure data, no I/O.
 */

/** PostgreSQL: reserved + reserved-(can be function or type) keywords. */
export const POSTGRES_RESERVED_WORDS: ReadonlySet<string> = new Set([
  "all", "analyse", "analyze", "and", "any", "array", "as", "asc", "asymmetric", "authorization", "binary", "both", "case",
  "cast", "check", "collate", "collation", "column", "concurrently", "constraint", "create", "cross", "current_catalog",
  "current_date", "current_role", "current_schema", "current_time", "current_timestamp", "current_user", "default",
  "deferrable", "desc", "distinct", "do", "else", "end", "except", "false", "fetch", "for", "foreign", "freeze", "from",
  "full", "grant", "group", "having", "ilike", "in", "initially", "inner", "intersect", "into", "is", "isnull", "join",
  "lateral", "leading", "left", "like", "limit", "localtime", "localtimestamp", "natural", "not", "notnull", "null",
  "offset", "on", "only", "or", "order", "outer", "overlaps", "placing", "primary", "references", "returning", "right",
  "select", "session_user", "similar", "some", "symmetric", "system_user", "table", "tablesample", "then", "to",
  "trailing", "true", "union", "unique", "user", "using", "variadic", "verbose", "when", "where", "window", "with",
]);

/** GoogleSQL reserved keywords, as BigQuery documents them. */
export const BIGQUERY_RESERVED_WORDS: ReadonlySet<string> = new Set([
  "all", "and", "any", "array", "as", "asc", "assert_rows_modified", "at", "between", "by", "case", "cast", "collate",
  "contains", "create", "cross", "cube", "current", "default", "define", "desc", "distinct", "else", "end", "enum",
  "escape", "except", "exclude", "exists", "extract", "false", "fetch", "following", "for", "from", "full", "group",
  "grouping", "groups", "hash", "having", "if", "ignore", "in", "inner", "intersect", "interval", "into", "is", "join",
  "lateral", "left", "like", "limit", "lookup", "merge", "natural", "new", "no", "not", "null", "nulls", "of", "on", "or",
  "order", "outer", "over", "partition", "preceding", "proto", "qualify", "range", "recursive", "respect", "right",
  "rollup", "rows", "select", "set", "some", "struct", "tablesample", "then", "to", "treat", "true", "unbounded", "union",
  "unnest", "using", "when", "where", "window", "with", "within",
]);

/** Cloud Spanner (GoogleSQL dialect): the same reserved-keyword family; BigQuery's QUALIFY is not in Spanner's list. */
export const SPANNER_RESERVED_WORDS: ReadonlySet<string> = new Set([...BIGQUERY_RESERVED_WORDS].filter((word) => word !== "qualify"));

export type ReservedWordDialect = "spanner" | "postgres" | "bigquery";

const RESERVED_WORDS: Record<ReservedWordDialect, ReadonlySet<string>> = {
  spanner: SPANNER_RESERVED_WORDS,
  postgres: POSTGRES_RESERVED_WORDS,
  bigquery: BIGQUERY_RESERVED_WORDS,
};

/** Is `identifier` (any case) a reserved word of the dialect? */
export function isReservedWord(dialect: ReservedWordDialect, identifier: string): boolean {
  return RESERVED_WORDS[dialect].has(identifier.toLowerCase());
}
