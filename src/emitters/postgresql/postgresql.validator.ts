import type { ValidationError, ValidationResult } from "@/lib/compiler/types";

const VALID_BASE_TYPES = new Set([
  "smallint",
  "integer",
  "bigint",
  "serial",
  "bigserial",
  "numeric",
  "decimal",
  "real",
  "double precision",
  "money",
  "boolean",
  "char",
  "varchar",
  "text",
  "bytea",
  "date",
  "time",
  "timetz",
  "timestamp",
  "timestamptz",
  "interval",
  "uuid",
  "json",
  "jsonb",
  "xml",
  "inet",
  "cidr",
  "macaddr",
]);

export function validatePostgreSqlDDL(ddl: string): ValidationResult {
  const errors: ValidationError[] = [];

  if (!ddl || ddl.trim().length === 0) {
    return { valid: false, errors: [{ message: "DDL is empty" }] };
  }

  const trimmed = ddl
    .trim()
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .trim();

  if (!/^CREATE\s+TABLE\s+/i.test(trimmed)) {
    return {
      valid: false,
      errors: [{ message: "DDL must start with CREATE TABLE" }],
    };
  }

  if (!trimmed.endsWith(";")) {
    errors.push({ message: "DDL must end with a semicolon" });
  }

  const openIdx = trimmed.indexOf("(");
  const closeIdx = trimmed.lastIndexOf(")");
  if (openIdx === -1 || closeIdx === -1 || closeIdx <= openIdx) {
    errors.push({ message: "Missing column definition block" });
    return { valid: false, errors };
  }

  const columnsBlock = trimmed.slice(openIdx + 1, closeIdx).trim();
  const columns = splitTopLevel(columnsBlock, ",");

  for (const rawCol of columns) {
    const cleaned = rawCol
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .trim();

    if (!cleaned || /^PRIMARY\s+KEY/i.test(cleaned)) {
      continue;
    }

    const match = cleaned.match(/^([a-z_][a-z0-9_]*)\s+(.+)$/i);
    if (!match) {
      errors.push({ message: `Invalid column definition: "${cleaned}"` });
      continue;
    }

    const typePart = match[2].replace(/\bNOT\s+NULL\b/i, "").trim();
    const normalized = normalizeBaseType(typePart);

    if (!VALID_BASE_TYPES.has(normalized)) {
      errors.push({ message: `Invalid PostgreSQL column type: "${typePart}"` });
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

function normalizeBaseType(typePart: string): string {
  const arrayStripped = typePart.replace(/\[\]$/g, "").trim().toLowerCase();
  const withoutParams = arrayStripped.replace(/\(.+\)$/, "").trim();

  if (withoutParams.startsWith("double precision")) {
    return "double precision";
  }
  if (withoutParams.startsWith("character varying")) {
    return "varchar";
  }
  if (withoutParams.startsWith("character")) {
    return "char";
  }

  return withoutParams;
}

function splitTopLevel(str: string, delimiter: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";

  for (const ch of str) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;

    if (ch === delimiter && depth === 0) {
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
