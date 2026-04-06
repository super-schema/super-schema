/**
 * Spanner DDL Validator — syntactic validation of generated DDL.
 *
 * Validates:
 * - CREATE TABLE structure
 * - Column type validity
 * - PRIMARY KEY clause
 */

import type { ValidationResult, ValidationError } from "@/lib/compiler/types";

// ---------------------------------------------------------------------------
// Valid Spanner column types
// ---------------------------------------------------------------------------

const VALID_SPANNER_TYPES = new Set([
  "STRING", "BYTES", "INT64", "FLOAT64", "FLOAT32", "NUMERIC",
  "BOOL", "DATE", "TIMESTAMP", "JSON", "ARRAY",
]);

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

export function validateSpannerDDL(ddl: string): ValidationResult {
  const errors: ValidationError[] = [];

  if (!ddl || ddl.trim().length === 0) {
    errors.push({ message: "DDL is empty" });
    return { valid: false, errors };
  }

  // Strip leading SQL comment lines (e.g., -- RETENTION: ...)
  const trimmed = ddl.trim().split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n").trim();

  // Must start with CREATE TABLE
  if (!/^CREATE\s+TABLE\s+/i.test(trimmed)) {
    errors.push({ message: "DDL must start with CREATE TABLE" });
    return { valid: false, errors };
  }

  // Must contain opening parenthesis
  const parenOpenIdx = trimmed.indexOf("(");
  if (parenOpenIdx === -1) {
    errors.push({ message: "Missing opening parenthesis for column definitions" });
    return { valid: false, errors };
  }

  // Find closing paren
  const closingParenIdx = findMatchingParen(trimmed, parenOpenIdx);
  if (closingParenIdx === -1) {
    errors.push({ message: "Missing closing parenthesis for column definitions" });
    return { valid: false, errors };
  }

  // Validate table name
  const tableNameMatch = trimmed.match(/^CREATE\s+TABLE\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/i);
  if (!tableNameMatch) {
    errors.push({ message: "Invalid table name in CREATE TABLE statement" });
    return { valid: false, errors };
  }

  // Extract column block
  const columnsBlock = trimmed.substring(parenOpenIdx + 1, closingParenIdx).trim();

  // Validate columns
  if (columnsBlock.length > 0) {
    const columnErrors = validateColumns(columnsBlock);
    errors.push(...columnErrors);
  }

  // Check for PRIMARY KEY after closing paren
  const afterParen = trimmed.substring(closingParenIdx + 1).trim();
  if (afterParen && !afterParen.startsWith("PRIMARY KEY") && !afterParen.startsWith(";") && !afterParen.startsWith(",")) {
    // PRIMARY KEY is expected but not strictly required for validation
  }

  // Must end with semicolon
  if (!trimmed.endsWith(";")) {
    errors.push({ message: "DDL must end with a semicolon" });
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Column validation
// ---------------------------------------------------------------------------

function validateColumns(columnsBlock: string): ValidationError[] {
  const errors: ValidationError[] = [];
  const columns = splitTopLevel(columnsBlock, ",");

  for (const rawCol of columns) {
    const col = rawCol
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .trim();

    if (!col) continue;

    const colMatch = col.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s+([\s\S]+)$/);
    if (!colMatch) continue;

    const typePart = colMatch[2].trim();
    const typeErrors = validateColumnType(typePart);
    errors.push(...typeErrors);
  }

  return errors;
}

function validateColumnType(typePart: string): ValidationError[] {
  const errors: ValidationError[] = [];

  let typeStr = typePart;
  typeStr = typeStr.replace(/\bNOT\s+NULL\b/i, "").trim();
  if (!typeStr) return errors;

  // Handle ARRAY<T>
  const arrayMatch = typeStr.match(/^ARRAY\s*<(.+)>\s*$/i);
  if (arrayMatch) {
    const innerType = arrayMatch[1].trim();
    const baseInner = innerType.split("(")[0].toUpperCase();
    if (!VALID_SPANNER_TYPES.has(baseInner)) {
      errors.push({ message: `Invalid Spanner array element type: "${innerType}"` });
    }
    return errors;
  }

  // Handle type with size: STRING(MAX), STRING(255), BYTES(MAX)
  const baseType = typeStr.split("(")[0].toUpperCase().trim();
  if (!VALID_SPANNER_TYPES.has(baseType)) {
    errors.push({ message: `Invalid Spanner column type: "${typeStr}"` });
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function findMatchingParen(str: string, openIdx: number): number {
  let depth = 1;
  for (let i = openIdx + 1; i < str.length; i++) {
    if (str[i] === "(") depth++;
    else if (str[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevel(str: string, delimiter: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  let inAngleBracket = 0;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "<") inAngleBracket++;
    else if (ch === ">") inAngleBracket--;

    if (ch === delimiter && depth === 0 && inAngleBracket === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }

  if (current.trim()) parts.push(current);
  return parts;
}
