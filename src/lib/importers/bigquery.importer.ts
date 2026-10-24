/**
 * BigQuery DDL Importer — parses CREATE TABLE DDL into ParsedEntity.
 *
 * Reverse of the BigQuery emitter: maps BigQuery types back to logical types.
 *
 * Handles:
 * - CREATE TABLE with project.dataset.table name format
 * - Column definitions with types and NOT NULL constraints
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
// Parse a column definition line
// ---------------------------------------------------------------------------

function parseColumnLine(line: string): ParsedField | null {
  // Trim and remove trailing comma
  const trimmed = line.trim().replace(/,\s*$/, "");
  if (!trimmed || trimmed.startsWith("--") || trimmed === "(" || trimmed === ")") {
    return null;
  }

  // Skip PARTITION BY, CLUSTER BY, etc.
  if (/^(PARTITION|CLUSTER|OPTIONS)\s/i.test(trimmed)) {
    return null;
  }

  // Match: column_name TYPE [NOT NULL] [OPTIONS(...)]
  // Handle backtick-quoted column names
  const match = trimmed.match(
    /^`?(\w+)`?\s+([\w<>,\s()]+?)(?:\s+(NOT\s+NULL))?(?:\s+OPTIONS\s*\((.*)\))?\s*$/i
  );

  if (!match) {
    return null;
  }

  const name = match[1];
  const rawType = match[2].trim().toUpperCase();
  const notNull = !!match[3];
  const optionsStr = match[4] || "";

  // Extract description from OPTIONS
  const description = optionStringValue(optionsStr, "description");

  // Resolve type
  const { type, confidence, originalType, precision, scale } = resolveBigQueryType(rawType);

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

/**
 * The GoogleSQL string literal that starts at `text[start]`, or null when none does (or it is not closed): single or double quoted,
 * triple quoted (it may hold the quote and parentheses), raw (`r'...'`: no escape is decoded, a backslash-quote is two characters).
 */
function readStringLiteral(text: string, start: number): { value: string; end: number } | null {
  let i = start;
  let raw = false;
  if ((text[i] === "r" || text[i] === "R") && (text[i + 1] === '"' || text[i + 1] === "'")) {
    raw = true;
    i += 1;
  }
  const quote = text[i];
  if (quote !== '"' && quote !== "'") return null;
  const delimiter = text.startsWith(quote.repeat(3), i) ? quote.repeat(3) : quote;
  i += delimiter.length;
  let value = "";
  while (i < text.length) {
    if (text.startsWith(delimiter, i)) return { value, end: i + delimiter.length };
    if (text[i] === "\\") {
      if (raw) {
        value += text.slice(i, i + 2);
        i += 2;
      } else {
        const [decoded, length] = decodeEscape(text, i);
        value += decoded;
        i += length;
      }
      continue;
    }
    value += text[i];
    i += 1;
  }
  return null;
}

/**
 * The string value of the option `name` in the text between the parentheses of OPTIONS(...): the option itself (at the top level, at the
 * start or after a comma), never text that only looks like it inside another option's string or brackets.
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
      if (found) return readStringLiteral(options, i + found[0].length)?.value;
    }
    const literal = readStringLiteral(options, i);
    if (literal) {
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
// Resolve BigQuery type to logical type
// ---------------------------------------------------------------------------

function resolveBigQueryType(rawType: string): {
  type: string;
  confidence: ImportConfidence;
  originalType: string;
  /** Declared by NUMERIC(p, s) and its aliases. */
  precision?: number;
  scale?: number;
} {
  // Handle ARRAY<...>
  const arrayMatch = rawType.match(/^ARRAY\s*<\s*(.+)\s*>$/i);
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
    const precision = numericMatch[2] !== undefined ? Number(numericMatch[2]) : undefined;
    return {
      type: mapped?.type || "decimal",
      confidence: mapped?.confidence || "high",
      originalType: rawType,
      ...(precision !== undefined ? { precision, scale: Number(numericMatch[3] ?? 0) } : {}),
    };
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function parseBigQueryDDL(content: string): Result<ParsedEntity> {
  const lines = content.split("\n");

  // Find CREATE TABLE line
  let tableName: string | null = null;
  let createTableLineIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    if (/CREATE\s+(?:OR\s+REPLACE\s+)?TABLE/i.test(lines[i])) {
      tableName = extractTableName(lines[i]);
      createTableLineIdx = i;
      break;
    }
  }

  if (!tableName || createTableLineIdx === -1) {
    return err({
      code: "PARSE_ERROR",
      message: "No CREATE TABLE statement found in DDL",
      suggestedFix: "Ensure the DDL contains a valid CREATE TABLE statement.",
    });
  }

  // Find the opening parenthesis
  let parenStart = -1;
  for (let i = createTableLineIdx; i < lines.length; i++) {
    const idx = lines[i].indexOf("(");
    if (idx !== -1) {
      parenStart = i;
      break;
    }
  }

  if (parenStart === -1) {
    return err({
      code: "PARSE_ERROR",
      message: "No column definitions found (missing opening parenthesis)",
      suggestedFix: "Ensure the CREATE TABLE statement has column definitions in parentheses.",
    });
  }

  // Extract column definitions between ( and )
  // Combine all content between parens
  let depth = 0;
  let columnContent = "";
  let foundStart = false;

  for (let i = parenStart; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "(") {
        depth++;
        if (!foundStart) {
          foundStart = true;
          continue; // Skip the opening paren
        }
      }
      if (ch === ")") {
        depth--;
        if (depth === 0) {
          break;
        }
      }
      if (foundStart && depth >= 1) {
        columnContent += ch;
      }
    }
    if (depth === 0 && foundStart) break;
    if (foundStart) columnContent += "\n";
  }

  // Parse individual column lines
  const columnLines = columnContent.split("\n");
  const parsedFields: ParsedField[] = [];

  for (const line of columnLines) {
    const field = parseColumnLine(line);
    if (field) {
      parsedFields.push(field);
    }
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
  });
}
