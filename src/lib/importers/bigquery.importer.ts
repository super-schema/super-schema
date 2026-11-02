/**
 * BigQuery DDL Importer — parses CREATE TABLE DDL into ParsedEntity.
 *
 * Reverse of the BigQuery emitter: maps BigQuery types back to logical types.
 *
 * Handles:
 * - CREATE TABLE with project.dataset.table name format
 * - Column definitions with types and NOT NULL constraints, over one line or several (a top-level comma ends a column)
 * - DEFAULT clauses: recognised and not kept, so a default (a string with a quote, a comma or a parenthesis in it) cannot change a type or a
 *   nullability, nor drop the column
 * - Comments (`--`, `#` and block comments) outside string literals and backtick-quoted names are not DDL and are ignored
 * - OPTIONS(description=...) for field descriptions: a GoogleSQL string literal (single, double or triple quoted, raw r'...', with its
 *   escapes), found as the option itself and not as text inside another option's value
 * - NUMERIC(p, s) / BIGNUMERIC(p, s) / DECIMAL / BIGDECIMAL: the declared precision and scale are kept on the field
 * - PARTITION BY and CLUSTER BY (ignored for import)
 * - Standard BigQuery types: STRING, INT64, FLOAT64, BOOL, BYTES,
 *   TIMESTAMP, DATETIME, DATE, NUMERIC, BIGNUMERIC, STRUCT, ARRAY
 */

import { ok, err } from "@/types/result";
import type { Result } from "@/types/result";
import type { ParsedEntity, ParsedField, ImportConfidence } from "./types";
import { sanitizeImportedText } from "./text-safety";
import { BIGQUERY_BIGNUMERIC_LIMITS, BIGQUERY_NUMERIC_LIMITS, declaredDecimalFacts } from "./decimal-facts";

// ---------------------------------------------------------------------------
// BigQuery → Logical type mapping (reverse of bigquery.emitter.ts)
// ---------------------------------------------------------------------------

const BIGQUERY_TYPE_MAP: Record<string, { type: string; confidence: ImportConfidence }> = {
  STRING: { type: "string", confidence: "high" },
  INT64: { type: "int64", confidence: "high" },
  INTEGER: { type: "int64", confidence: "high" },
  FLOAT64: { type: "float64", confidence: "high" },
  FLOAT: { type: "float64", confidence: "high" },
  BOOL: { type: "boolean", confidence: "high" },
  BOOLEAN: { type: "boolean", confidence: "high" },
  BYTES: { type: "bytes", confidence: "high" },
  TIMESTAMP: { type: "utcDateTime", confidence: "high" },
  DATETIME: { type: "utcDateTime", confidence: "high" },
  DATE: { type: "plainDate", confidence: "high" },
  TIME: { type: "plainTime", confidence: "high" },
  NUMERIC: { type: "decimal", confidence: "high" },
  BIGNUMERIC: { type: "decimal128", confidence: "high" },
  DECIMAL: { type: "decimal", confidence: "high" },
  BIGDECIMAL: { type: "decimal128", confidence: "high" },
  JSON: { type: "string", confidence: "medium" },
  GEOGRAPHY: { type: "string", confidence: "low" },
  STRUCT: { type: "object", confidence: "low" },
  RECORD: { type: "object", confidence: "low" },
};

// ---------------------------------------------------------------------------
// Extract table name from CREATE TABLE statement
// ---------------------------------------------------------------------------

function extractTableName(line: string): string | null {
  // Match: CREATE TABLE [IF NOT EXISTS] [project.]dataset.table_name
  // or: CREATE TABLE [IF NOT EXISTS] table_name
  const match = line.match(
    /CREATE\s+(?:OR\s+REPLACE\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:`?[\w.-]+`?\.)?(?:`?[\w.-]+`?\.)?`?([\w-]+)`?/i
  );
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Parse a column definition
// ---------------------------------------------------------------------------

/**
 * One column: the text between two top-level commas of the CREATE TABLE list, `name TYPE [NOT NULL] [DEFAULT expr] [OPTIONS(...)]`, over one
 * line or several. `warnings` collects what the import says about the column it reads (a declaration it did not keep).
 */
function parseColumnDefinition(definition: string, warnings: string[]): ParsedField | null {
  const trimmed = definition.trim();
  if (!trimmed) {
    return null;
  }

  // Skip PARTITION BY, CLUSTER BY and a table's OPTIONS(...), not a column named options or cluster (neither is reserved)
  if (/^(PARTITION\s+BY|CLUSTER\s+BY|OPTIONS\s*\()/i.test(trimmed)) {
    return null;
  }

  // Match: column_name TYPE [NOT NULL] [DEFAULT expr] [OPTIONS(...)]; handle backtick-quoted column names
  const named = trimmed.match(/^(?:`(\w+)`|(\w+))\s+([\s\S]+)$/);
  if (!named) {
    return null;
  }

  const name = named[1] ?? named[2];
  const clauses = splitColumnClauses(named[3]);
  // The type holds letters, digits, angle brackets, commas, spaces and parentheses (ARRAY<STRING>, NUMERIC(12, 2)); anything else is not one
  if (!/^[\w<>,\s()]+$/.test(clauses.type)) {
    return null;
  }
  const rawType = clauses.type.split("\n").map((part) => part.trim()).filter(Boolean).join(" ").toUpperCase();
  const notNull = clauses.notNull;
  const optionsStr = clauses.options ?? "";

  // Extract description from OPTIONS
  const description = optionStringValue(optionsStr, "description");

  // Resolve type
  const { type, confidence, originalType, precision, scale, problem } = resolveBigQueryType(rawType);
  if (problem) {
    const shown = originalType.length > 40 ? `${originalType.slice(0, 40)}…` : originalType;
    warnings.push(`Field "${name}": ${shown} is outside what its type allows (${problem}) — imported as a plain decimal, without precision and scale.`);
  }

  return {
    name,
    type,
    nullable: !notNull,
    description,
    confidence,
    originalType,
    ...(precision !== undefined ? { precision } : {}),
    ...(scale !== undefined ? { scale } : {}),
  };
}

// ---------------------------------------------------------------------------
// GoogleSQL string literals (the values of OPTIONS(...))
// ---------------------------------------------------------------------------

const SIMPLE_ESCAPES: Record<string, string> = {
  a: "\x07",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
  "?": "?",
  '"': '"',
  "'": "'",
  "`": "`",
};

/** The escape that starts at `text[at]` (a backslash): what it stands for and how many characters it takes. An unknown one stays as written. */
function decodeEscape(text: string, at: number): [string, number] {
  const next = text[at + 1];
  if (next === undefined) return ["\\", 1];
  if (next in SIMPLE_ESCAPES) return [SIMPLE_ESCAPES[next], 2];
  // \ooo (octal), \xHH, \uHHHH, \UHHHHHHHH: a fixed number of digits after the prefix
  const fixed = (digits: number, radix: 8 | 16, prefix: number): [string, number] | null => {
    const body = text.slice(at + prefix, at + prefix + digits);
    const valid = radix === 8 ? /^[0-7]+$/ : /^[0-9a-fA-F]+$/;
    if (body.length !== digits || !valid.test(body)) return null;
    const code = parseInt(body, radix);
    return code <= 0x10ffff ? [String.fromCodePoint(code), prefix + digits] : null;
  };
  const decoded = /[0-7]/.test(next)
    ? fixed(3, 8, 1)
    : next === "x" || next === "X"
      ? fixed(2, 16, 2)
      : next === "u"
        ? fixed(4, 16, 2)
        : next === "U"
          ? fixed(8, 16, 2)
          : null;
  return decoded ?? [`\\${next}`, 2];
}

/** The delimiter that a string literal opening with this quote uses when it opens with three of it (triple quoted). */
const TRIPLE_QUOTE: Record<string, string> = { '"': '"""', "'": "'''" };

/**
 * The GoogleSQL string literal that starts at `text[start]`, or null when none does (or it is not closed): single or double quoted,
 * triple quoted (it may hold the quote and parentheses), raw (`r'...'`: no escape is decoded, a backslash-quote is two characters).
 * With `collect` the value is built; without it the scan only finds where the literal ends, by the same delimiters and escapes.
 */
function scanStringLiteral(text: string, start: number, collect: boolean): { value: string; end: number } | null {
  let i = start;
  let raw = false;
  if ((text[i] === "r" || text[i] === "R") && (text[i + 1] === '"' || text[i + 1] === "'")) {
    raw = true;
    i += 1;
  }
  const quote = text[i];
  if (quote !== '"' && quote !== "'") return null;
  const delimiter = text.startsWith(TRIPLE_QUOTE[quote], i) ? TRIPLE_QUOTE[quote] : quote;
  i += delimiter.length;
  let value = "";
  while (i < text.length) {
    if (text.startsWith(delimiter, i)) return { value, end: i + delimiter.length };
    if (text[i] === "\\") {
      if (raw) {
        if (collect) value += text.slice(i, i + 2);
        i += 2;
      } else if (collect) {
        const [decoded, length] = decodeEscape(text, i);
        value += decoded;
        i += length;
      } else {
        i += escapeLength(text, i);
      }
    } else {
      if (collect) value += text[i];
      i += 1;
    }
  }
  return null;
}

function readStringLiteral(text: string, start: number): { value: string; end: number } | null {
  return scanStringLiteral(text, start, true);
}

/** True when a string literal starts at `text[i]`: a quote, or a raw prefix (`r` / `R`) right before one. */
function startsStringLiteral(text: string, i: number): boolean {
  const ch = text[i];
  if (ch === '"' || ch === "'") return true;
  return (ch === "r" || ch === "R") && (text[i + 1] === '"' || text[i + 1] === "'");
}

/** How many characters the escape at `text[at]` (a backslash) takes: the length `decodeEscape` reads. */
function escapeLength(text: string, at: number): number {
  const next = text[at + 1];
  if (next === undefined) return 1;
  return next in SIMPLE_ESCAPES ? 2 : decodeEscape(text, at)[1];
}

/** The index after the string literal that starts at `text[start]` (the literal `readStringLiteral` reads), or null when it is not closed. */
function literalEnd(text: string, start: number): number | null {
  return scanStringLiteral(text, start, false)?.end ?? null;
}

/** The index after the backtick-quoted identifier that starts at `text[i]`, or null when it is not closed. Its text is a name: a comment mark, a quote or a bracket in it is not code. Backslash escapes as in string literals. */
function identifierEnd(text: string, i: number): number | null {
  for (let j = i + 1; j < text.length; ) {
    if (text[j] === "\\") j += 2;
    else if (text[j] === "`") return j + 1;
    else j += 1;
  }
  return null;
}

/**
 * The string value of the option `name` in the text between the parentheses of OPTIONS(...): the option itself (at the top level, at the
 * start or after a comma), never text that only looks like it inside another option's string or brackets.
 *
 * ONE scan of the text, left to right: every literal is read once and the scan goes on after it; a literal that is not closed
 * ends the scan (everything after its opening quote is inside it), so no quote of a pathological text starts a second scan to the
 * end. The value is made storable (`sanitizeImportedText`: an escape can write a NUL or half a surrogate pair).
 */
function optionStringValue(options: string, name: string): string | undefined {
  const key = new RegExp(`${name}\\s*=\\s*`, "iy");
  let depth = 0;
  let atStart = true; // at the start of an option: the start of the text, or after a top-level comma
  for (let i = 0; i < options.length; ) {
    const ch = options[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (atStart && depth === 0) {
      key.lastIndex = i;
      const found = key.exec(options);
      if (found) {
        const value = readStringLiteral(options, i + found[0].length);
        return value ? sanitizeImportedText(value.value) : undefined;
      }
    }
    if (startsStringLiteral(options, i)) {
      const literal = readStringLiteral(options, i);
      if (!literal) return undefined; // not closed: the rest of the text is inside it
      i = literal.end;
      atStart = false;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    atStart = ch === "," && depth === 0;
    i += 1;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Comments, clauses and the column list: each is read outside string literals only
// ---------------------------------------------------------------------------

/**
 * `sql` without its comments. `#` and `--` run to the end of their line; a block comment (opened with slash-star) is replaced by one space,
 * keeping the newlines it spans so the lines of the statement still line up. A comment mark inside a string literal is text, and a literal that
 * is not closed runs to the end of the text, so nothing after it is a comment.
 */
function stripComments(sql: string): string {
  let out = "";
  let kept = 0; // sql.slice(kept, i) is not in `out` yet
  let i = 0;
  while (i < sql.length) {
    if (startsStringLiteral(sql, i)) {
      const literalAt = literalEnd(sql, i);
      if (literalAt === null) break; // not closed: the rest is inside it
      i = literalAt;
      continue;
    }
    if (sql[i] === "`") {
      const identifierAt = identifierEnd(sql, i);
      if (identifierAt === null) break; // not closed: the rest is inside it
      i = identifierAt;
      continue;
    }
    let end: number;
    let replacement = "";
    if (sql[i] === "#" || sql.startsWith("--", i)) {
      const newline = sql.indexOf("\n", i);
      end = newline === -1 ? sql.length : newline;
    } else if (sql.startsWith("/*", i)) {
      const close = sql.indexOf("*/", i + 2);
      end = close === -1 ? sql.length : close + 2;
      replacement = " ";
      for (let k = i; k < end; k++) {
        if (sql[k] === "\n") replacement += "\n";
      }
    } else {
      i += 1;
      continue;
    }
    out += sql.slice(kept, i) + replacement;
    kept = end;
    i = end;
  }
  return out + sql.slice(kept);
}

/** The clause keywords that follow a column's type: NOT NULL (any spacing inside), DEFAULT, OPTIONS. Whole words only. */
const CLAUSE_KEYWORD = /(NOT\s+NULL|DEFAULT|OPTIONS)(?!\w)/iy;

/** The clause keyword that starts at `text[i]` (not in the middle of a word), and the index after it; null when none does. */
function clauseKeywordAt(text: string, i: number): { name: string; end: number } | null {
  if (!/[NDO]/i.test(text[i]) || (i > 0 && /\w/.test(text[i - 1]))) {
    return null;
  }
  CLAUSE_KEYWORD.lastIndex = i;
  const match = CLAUSE_KEYWORD.exec(text);
  return match ? { name: match[0].toUpperCase().replace(/\s+/g, " "), end: i + match[0].length } : null;
}

/** The index of the ")" that closes the "(" at `text[open]`, outside string literals; `text.length` when it is not closed. */
function closingParenIndex(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; ) {
    if (startsStringLiteral(text, i)) {
      const literalAt = literalEnd(text, i);
      if (literalAt === null) return text.length;
      i = literalAt;
      continue;
    }
    if (text[i] === "`") {
      const identifierAt = identifierEnd(text, i);
      if (identifierAt === null) return text.length;
      i = identifierAt;
      continue;
    }
    if (text[i] === "(") {
      depth += 1;
    } else if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return text.length;
}

/**
 * The change in the open angle brackets of a type at `text[i]`: +1 for a "<" that follows ARRAY or STRUCT (spaces allowed), -1 for a ">",
 * 0 for any other character. A "<" or ">" anywhere else is an operator of an expression (DEFAULT 1 < 2) and opens or closes nothing, so it
 * cannot hold a later comma open.
 */
function typeAngleDelta(text: string, i: number): number {
  if (text[i] === ">") return -1;
  if (text[i] !== "<") return 0;
  let j = i - 1;
  while (j >= 0 && /\s/.test(text[j])) j -= 1;
  // seven characters: the type word and the character before it, so XSTRUCT< is not STRUCT<
  return /(?<!\w)(?:ARRAY|STRUCT)$/i.test(text.slice(Math.max(0, j - 6), j + 1)) ? 1 : 0;
}

/**
 * A column definition after its name, split into its type and its clauses. The type is the text before the first NOT NULL, DEFAULT or
 * OPTIONS that stands outside brackets and string literals; the angle brackets of ARRAY<...> and STRUCT<...> count as brackets wherever they
 * are, so the NOT NULL of a struct field is not the column's and a typed default (STRUCT<x INT64, y INT64>(1, 2)) keeps its commas inside. A
 * DEFAULT is recognised and not kept: its expression is skipped, so a string, a comma or a parenthesis in it cannot change the type or the
 * nullability. `options` is what lies between the parentheses of the first OPTIONS.
 */
function splitColumnClauses(text: string): { type: string; notNull: boolean; options?: string } {
  let depth = 0;
  let angles = 0;
  let typeEnd = -1;
  let notNull = false;
  let options: string | undefined;
  for (let i = 0; i < text.length; ) {
    if (startsStringLiteral(text, i)) {
      const literalAt = literalEnd(text, i);
      if (literalAt === null) break; // not closed: the rest is inside it
      i = literalAt;
      continue;
    }
    if (text[i] === "`") {
      const identifierAt = identifierEnd(text, i);
      if (identifierAt === null) break; // not closed: the rest is inside it
      i = identifierAt;
      continue;
    }
    const keyword = depth === 0 && angles === 0 ? clauseKeywordAt(text, i) : null;
    if (keyword) {
      if (typeEnd < 0) typeEnd = i;
      if (keyword.name === "NOT NULL") notNull = true;
      if (keyword.name === "OPTIONS") {
        let open = keyword.end;
        while (open < text.length && /\s/.test(text[open])) open += 1;
        if (text[open] === "(") {
          const close = closingParenIndex(text, open);
          options ??= text.slice(open + 1, close);
          i = close + 1;
          continue;
        }
      }
      i = keyword.end;
      continue;
    }
    const ch = text[i];
    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth = Math.max(0, depth - 1);
    } else {
      angles = Math.max(0, angles + typeAngleDelta(text, i));
    }
    i += 1;
  }
  return { type: text.slice(0, typeEnd < 0 ? text.length : typeEnd).trim(), notNull, options };
}

/** A column name (a plain word or a backtick-quoted name, after any spaces) at the sticky position. */
const COLUMN_NAME = /\s*(?:`(?:\\[\s\S]|[^`\\])*`|\w+)/y;

/** Where the type of the column definition that starts at `start` begins: after its name, so a name such as options is not a clause. */
function columnTypeStart(sql: string, start: number): number {
  COLUMN_NAME.lastIndex = start;
  const name = COLUMN_NAME.exec(sql);
  return name ? start + name[0].length : start;
}

/**
 * The texts of the column definitions of the CREATE TABLE list whose "(" is at `open`: each is the text between two top-level commas, the
 * last one up to the ")" that closes the list. A comma inside a string literal, inside brackets or inside the angle brackets of a type is not a
 * separator. A literal that is not closed runs to the end of the text, so the list does not close either: `unclosed` says so, and the
 * last definition then holds the rest of the text.
 */
function columnDefinitions(sql: string, open: number): { definitions: string[]; unclosed: boolean } {
  const definitions: string[] = [];
  let unclosed = false;
  let depth = 0; // the list's own "(" makes it 1
  let angles = 0; // the angle brackets of a type (ARRAY<...>, STRUCT<...>)
  let inType = true; // no clause keyword has come yet in this definition
  let start = open + 1;
  let typeStart = columnTypeStart(sql, start);
  let end = sql.length;
  for (let i = open; i < sql.length; ) {
    if (startsStringLiteral(sql, i)) {
      const literalAt = literalEnd(sql, i);
      if (literalAt === null) {
        unclosed = true; // the rest is inside it
        break;
      }
      i = literalAt;
      continue;
    }
    if (sql[i] === "`") {
      const identifierAt = identifierEnd(sql, i);
      if (identifierAt === null) {
        unclosed = true; // the rest is inside it
        break;
      }
      i = identifierAt;
      continue;
    }
    const ch = sql[i];
    if (inType && depth === 1 && angles === 0 && i >= typeStart && clauseKeywordAt(sql, i)) {
      inType = false;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    } else if (depth === 1 && angles === 0 && ch === ",") {
      definitions.push(sql.slice(start, i));
      start = i + 1;
      typeStart = columnTypeStart(sql, start);
      inType = true;
    } else {
      angles = Math.max(0, angles + typeAngleDelta(sql, i));
    }
    i += 1;
  }
  definitions.push(sql.slice(start, end));
  return { definitions, unclosed };
}

// ---------------------------------------------------------------------------
// Resolve BigQuery type to logical type
// ---------------------------------------------------------------------------

function resolveBigQueryType(rawType: string): {
  type: string;
  confidence: ImportConfidence;
  originalType: string;
  /** Declared by NUMERIC(p, s) and its aliases. */
  precision?: number;
  scale?: number;
  /** Why a declared precision / scale was not kept (outside what the type allows). */
  problem?: string;
} {
  // Handle ARRAY<...>
  const arrayMatch = rawType.match(/^ARRAY\s*<.+>$/i);
  if (arrayMatch) {
    return {
      type: "array",
      confidence: "low",
      originalType: rawType,
    };
  }

  // Handle STRUCT<...>
  if (rawType.startsWith("STRUCT")) {
    return {
      type: "object",
      confidence: "low",
      originalType: rawType,
    };
  }

  // Handle NUMERIC(p,s) / BIGNUMERIC(p,s): the declared precision and scale are kept (BigQuery: the scale of NUMERIC(p) is 0)
  const numericMatch = rawType.match(/^(NUMERIC|BIGNUMERIC|DECIMAL|BIGDECIMAL)\s*(?:\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\))?$/i);
  if (numericMatch) {
    const baseType = numericMatch[1].toUpperCase();
    const mapped = BIGQUERY_TYPE_MAP[baseType];
    const base = { type: mapped?.type || "decimal", confidence: mapped?.confidence || "high", originalType: rawType };
    if (numericMatch[2] === undefined) return base;
    const limits = baseType === "BIGNUMERIC" || baseType === "BIGDECIMAL" ? BIGQUERY_BIGNUMERIC_LIMITS : BIGQUERY_NUMERIC_LIMITS;
    const facts = declaredDecimalFacts(Number(numericMatch[2]), numericMatch[3] === undefined ? undefined : Number(numericMatch[3]), limits);
    return facts.ok ? { ...base, precision: facts.precision, scale: facts.scale } : { ...base, problem: `${limits.what}: ${facts.reason}` };
  }

  // Direct lookup
  const baseType = rawType.split("(")[0].trim();
  const mapped = BIGQUERY_TYPE_MAP[baseType];
  if (mapped) {
    return {
      type: mapped.type,
      confidence: mapped.confidence,
      originalType: rawType,
    };
  }

  return {
    type: "string",
    confidence: "low",
    originalType: rawType,
  };
}

/**
 * Where the CREATE TABLE statement starts (-1 when there is none): its first CREATE TABLE that is not inside a comment. A comment (`#`, `--`
 * or slash-star) is skipped as a whole, so a comment that names CREATE TABLE is not the statement. Quotes outside a comment are not read here.
 */
function createTableStart(content: string): number {
  const createTable = /CREATE\s+(?:OR\s+REPLACE\s+)?TABLE(?!\w)/iy;
  for (let i = 0; i < content.length; ) {
    if (content.startsWith("/*", i)) {
      const close = content.indexOf("*/", i + 2);
      // not closed: the slash-star is prose, not a comment that runs over the statement, so the scan goes on after it
      if (close === -1) {
        i += 2;
        continue;
      }
      i = close + 2;
    } else if (content[i] === "#" || content.startsWith("--", i)) {
      const newline = content.indexOf("\n", i);
      if (newline === -1) return -1;
      i = newline;
    } else {
      createTable.lastIndex = i;
      if ((i === 0 || !/\w/.test(content[i - 1])) && createTable.test(content)) return i;
      i += 1;
    }
  }
  return -1;
}

/** Where the first CREATE TABLE of the text starts, comments or not (-1 when there is none). */
function firstCreateTable(content: string): number {
  const match = /(?<!\w)CREATE\s+(?:OR\s+REPLACE\s+)?TABLE(?!\w)/i.exec(content);
  return match ? match.index : -1;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function parseBigQueryDDL(content: string): Result<ParsedEntity> {
  // The statement is lexed from its CREATE TABLE on: the text before it is not DDL, and prose there may hold an apostrophe that opens nothing.
  // When no CREATE TABLE is outside a comment (prose with an unclosed slash-star, or a slash-star that closes only inside the statement),
  // the first CREATE TABLE is taken, as before.
  const commentFreeStart = createTableStart(content);
  const start = commentFreeStart === -1 ? firstCreateTable(content) : commentFreeStart;
  // Comments go first: a comment is not DDL, so it cannot end a column or the table
  const sql = start === -1 ? "" : stripComments(content.slice(start));
  const tableName = start === -1 ? null : extractTableName(sql.split("\n", 1)[0]);

  if (!tableName) {
    return err({
      code: "PARSE_ERROR",
      message: "No CREATE TABLE statement found in DDL",
      suggestedFix: "Ensure the DDL contains a valid CREATE TABLE statement.",
    });
  }

  // Find the opening parenthesis: the first "(" of the statement
  const parenStart = sql.indexOf("(");

  if (parenStart === -1) {
    return err({
      code: "PARSE_ERROR",
      message: "No column definitions found (missing opening parenthesis)",
      suggestedFix: "Ensure the CREATE TABLE statement has column definitions in parentheses.",
    });
  }

  // Parse the column definitions between ( and )
  const parsedFields: ParsedField[] = [];
  const importWarnings: string[] = [];

  const columns = columnDefinitions(sql, parenStart);
  for (const definition of columns.definitions) {
    const field = parseColumnDefinition(definition, importWarnings);
    if (field) {
      parsedFields.push(field);
    }
  }
  if (columns.unclosed) {
    importWarnings.push("The column list has a string literal or backtick name that is not closed, so the columns after it are not imported.");
  }

  if (parsedFields.length === 0) {
    return err({
      code: "PARSE_ERROR",
      message: "No columns could be parsed from the DDL",
      suggestedFix: "Ensure the CREATE TABLE statement has valid column definitions.",
    });
  }

  return ok({
    name: tableName,
    fields: parsedFields,
    sourceFormat: "bigquery-ddl",
    originalContent: content,
    ...(importWarnings.length > 0 ? { importWarnings } : {}),
  });
}
