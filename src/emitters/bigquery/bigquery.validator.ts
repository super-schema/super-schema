/**
 * BigQuery DDL Validator — syntactic validation of generated DDL.
 *
 * Validates:
 * - CREATE TABLE structure
 * - Column type validity
 * - OPTIONS(...) syntax
 * - PARTITION BY / CLUSTER BY references
 */

import type { ValidationResult, ValidationError } from "@/lib/compiler/types";

// ---------------------------------------------------------------------------
// Valid BigQuery base types
// ---------------------------------------------------------------------------

const VALID_BQ_TYPES = new Set([
  "STRING", "BYTES", "INT64", "FLOAT64", "NUMERIC", "BIGNUMERIC",
  "BOOL", "BOOLEAN", "DATE", "TIME", "DATETIME", "TIMESTAMP",
  "STRUCT", "ARRAY", "JSON", "GEOGRAPHY",
]);

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

export function validateBigQueryDDL(ddl: string): ValidationResult {
  const errors: ValidationError[] = [];

  if (!ddl || ddl.trim().length === 0) {
    errors.push({ message: "DDL is empty" });
    return { valid: false, errors };
  }

  // Strip leading SQL comment lines (e.g., -- RETENTION: ...)
  const trimmed = ddl.trim().split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n").trim();

  // 1. Must start with CREATE TABLE
  if (!/^CREATE\s+TABLE\s+/i.test(trimmed)) {
    errors.push({
      message: "DDL must start with CREATE TABLE",
    });
    return { valid: false, errors };
  }

  // 2. Must contain opening and closing parentheses for column definitions
  const parenOpenIdx = trimmed.indexOf("(");
  if (parenOpenIdx === -1) {
    errors.push({
      message: "Missing opening parenthesis for column definitions",
    });
    return { valid: false, errors };
  }

  // Find the matching closing paren (accounting for nested parens in OPTIONS, ARRAY<>, etc.)
  const closingParenIdx = findMatchingParen(trimmed, parenOpenIdx);
  if (closingParenIdx === -1) {
    errors.push({
      message: "Missing closing parenthesis for column definitions",
    });
    return { valid: false, errors };
  }

  // 3. Extract table name
  const tableNameMatch = trimmed.match(
    /^CREATE\s+TABLE\s+([a-zA-Z0-9_.`]+)\s*\(/i
  );
  if (!tableNameMatch) {
    errors.push({ message: "Invalid table name in CREATE TABLE statement" });
    return { valid: false, errors };
  }

  // 4. Extract column definitions block
  const columnsBlock = trimmed.substring(parenOpenIdx + 1, closingParenIdx).trim();

  // 5. Parse and validate columns (if any)
  if (columnsBlock.length > 0) {
    const columnErrors = validateColumns(columnsBlock);
    errors.push(...columnErrors);
  }

  // 6. Check remainder after closing paren for PARTITION BY / CLUSTER BY
  const remainder = trimmed.substring(closingParenIdx + 1).trim();
  const remainderErrors = validateClauses(remainder, columnsBlock);
  errors.push(...remainderErrors);

  // 7. Must end with semicolon
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

  // Split columns by top-level commas (not inside parens/brackets)
  const columns = splitTopLevel(columnsBlock, ",");

  for (const rawCol of columns) {
    // Strip comment lines (-- WARNING: ...)
    const col = rawCol
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .trim();

    if (!col) continue;

    // Match: column_name TYPE [NOT NULL] [OPTIONS(...)]
    const colMatch = col.match(
      /^(`[^`]+`|[a-zA-Z_][a-zA-Z0-9_]*)\s+([\s\S]+)$/
    );
    if (!colMatch) {
      errors.push({
        message: `Invalid column definition: "${col.substring(0, 60)}..."`,
      });
      continue;
    }

    const typePart = colMatch[2].trim();

    // Validate type — extract base type
    const typeErrors = validateColumnType(typePart);
    errors.push(...typeErrors);
  }

  return errors;
}

function validateColumnType(typePart: string): ValidationError[] {
  const errors: ValidationError[] = [];

  // Remove NOT NULL, OPTIONS(...) from the type string for type checking
  let typeStr = typePart;
  typeStr = typeStr.replace(/\bNOT\s+NULL\b/i, "").trim();

  // Remove OPTIONS(...) — find it and strip
  const optionsIdx = typeStr.indexOf("OPTIONS(");
  if (optionsIdx !== -1) {
    const optEnd = findMatchingParen(typeStr, optionsIdx + 7);
    if (optEnd === -1) {
      errors.push({ message: "Malformed OPTIONS clause — missing closing parenthesis" });
      return errors;
    }
    typeStr = (typeStr.substring(0, optionsIdx) + typeStr.substring(optEnd + 1)).trim();
  }

  if (!typeStr) return errors;

  // Handle ARRAY<T>
  const arrayMatch = typeStr.match(/^ARRAY\s*<(.+)>\s*$/i);
  if (arrayMatch) {
    const innerType = arrayMatch[1].trim();
    const baseInner = innerType.split("(")[0].toUpperCase();
    if (!VALID_BQ_TYPES.has(baseInner)) {
      errors.push({
        message: `Invalid BigQuery array element type: "${innerType}"`,
      });
    }
    return errors;
  }

  // Handle STRUCT<...>
  if (/^STRUCT\s*(<.*>)?\s*$/i.test(typeStr)) {
    return errors; // STRUCT is valid with or without field definitions
  }

  // Handle base type with optional precision: NUMERIC(19,4)
  const baseType = typeStr.split("(")[0].toUpperCase().trim();
  if (!VALID_BQ_TYPES.has(baseType)) {
    errors.push({
      message: `Invalid BigQuery column type: "${typeStr}"`,
    });
  }

  return errors;
}

// ---------------------------------------------------------------------------
// PARTITION BY / CLUSTER BY validation
// ---------------------------------------------------------------------------

function validateClauses(
  remainder: string,
  columnsBlock: string
): ValidationError[] {
  const errors: ValidationError[] = [];

  // Remove trailing semicolon
  let rest = remainder.replace(/;\s*$/, "").trim();
  if (!rest) return errors;

  // Extract column names from columnsBlock for reference validation
  const columnNames = extractColumnNames(columnsBlock);

  // PARTITION BY
  const partitionMatch = rest.match(/PARTITION\s+BY\s+(`[^`]+`|[a-zA-Z_][a-zA-Z0-9_]*)/i);
  if (partitionMatch) {
    const partCol = partitionMatch[1].replace(/`/g, "");
    if (columnNames.length > 0 && !columnNames.includes(partCol)) {
      errors.push({
        message: `PARTITION BY references unknown column "${partCol}"`,
      });
    }
    rest = rest.replace(/PARTITION\s+BY\s+(`[^`]+`|[a-zA-Z_][a-zA-Z0-9_]*)/i, "").trim();
  }

  // CLUSTER BY
  const clusterMatch = rest.match(
    /CLUSTER\s+BY\s+((?:`[^`]+`|[a-zA-Z_][a-zA-Z0-9_]*)(?:\s*,\s*(?:`[^`]+`|[a-zA-Z_][a-zA-Z0-9_]*))*)/i
  );
  if (clusterMatch) {
    const clusterCols = clusterMatch[1]
      .split(",")
      .map((c) => c.trim().replace(/`/g, ""));
    for (const col of clusterCols) {
      if (columnNames.length > 0 && !columnNames.includes(col)) {
        errors.push({
          message: `CLUSTER BY references unknown column "${col}"`,
        });
      }
    }
    rest = rest
      .replace(
        /CLUSTER\s+BY\s+((?:`[^`]+`|[a-zA-Z_][a-zA-Z0-9_]*)(?:\s*,\s*(?:`[^`]+`|[a-zA-Z_][a-zA-Z0-9_]*))*)/i,
        ""
      )
      .trim();
  }

  // If anything left, it's unexpected
  if (rest) {
    errors.push({
      message: `Unexpected clause after column definitions: "${rest.substring(0, 60)}"`,
    });
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

function extractColumnNames(columnsBlock: string): string[] {
  const columns = splitTopLevel(columnsBlock, ",");
  const names: string[] = [];

  for (const rawCol of columns) {
    const col = rawCol
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .trim();

    if (!col) continue;

    const match = col.match(/^(`([^`]+)`|([a-zA-Z_][a-zA-Z0-9_]*))\s+/);
    if (match) {
      names.push(match[2] ?? match[3]);
    }
  }

  return names;
}

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

  if (current.trim()) {
    parts.push(current);
  }

  return parts;
}
