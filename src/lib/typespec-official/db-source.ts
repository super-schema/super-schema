/**
 * db-source.ts — builds TypeSpec (.tsp) source for the database emitter
 * packages (@typespec/spanner, @typespec/postgres, @typespec/bigquery) from a
 * SuperSchemaModel.
 *
 * These emitters read the logical shape from TypeSpec models + the @typespec/db
 * (and dialect-specific) decorators, then emit dialect DDL. This builder is the
 * bridge from our IR to that authoring surface.
 *
 * Pure function — no side effects, no I/O.
 */

import type {
  SuperSchemaModel,
  SuperSchemaField,
  LogicalType,
} from "@/types/super-schema-model";

type DbDialect = "spanner" | "postgres" | "bigquery";

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
  imports: string[];
  usings: string[];
  /** Decorator to emit for decimal precision, or null if unsupported. */
  decimalDecorator: string | null;
  /** Dialect requires an explicit @table decorator (spanner). */
  emitTableDecorator: boolean;
}

const DIALECTS: Record<DbDialect, DialectConfig> = {
  spanner: {
    imports: ['import "@typespec/db";', 'import "@typespec/spanner";'],
    usings: ["using TypeSpec.DB;", "using TypeSpec.Spanner;"],
    decimalDecorator: "@decimalPrecision",
    emitTableDecorator: true,
  },
  bigquery: {
    // Reconciled to @typespec/db — shared decorators, no namespace collision.
    imports: ['import "@typespec/db";', 'import "@typespec/bigquery";'],
    usings: ["using TypeSpec.DB;"],
    decimalDecorator: "@decimalPrecision",
    emitTableDecorator: false, // models in a @schema namespace are auto-tables
  },
  postgres: {
    // Reconciled to @typespec/db — now supports @decimalPrecision too.
    imports: ['import "@typespec/db";', 'import "@typespec/postgres";'],
    usings: ["using TypeSpec.DB;"],
    decimalDecorator: "@decimalPrecision",
    emitTableDecorator: false,
  },
};

/** Logical IR type → TypeSpec built-in scalar the emitters understand. */
const TYPE_MAP: Partial<Record<LogicalType, string>> = {
  string: "string",
  url: "url",
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
  plainTime: "plainTime",
  utcDateTime: "utcDateTime",
  offsetDateTime: "offsetDateTime",
  duration: "duration",
  unixTimestamp32: "int32",
};

const DECIMAL_TYPES = new Set<LogicalType>(["decimal", "decimal128", "numeric"]);

function sanitizeIdent(name: string): string {
  let s = name.replace(/[^a-zA-Z0-9_]/g, "_");
  if (/^[0-9]/.test(s)) s = `_${s}`;
  return s || "_";
}

function pascal(name: string): string {
  const parts = name.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  const joined = parts
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
  return joined || "Model";
}

function escapeStr(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ");
}

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

/**
 * Build a .tsp document for the given DB target from the SuperSchemaModel.
 * @param targetKey one of "spanner" | "postgresql" | "bigquery"
 */
export function buildDbTypeSpecSource(model: SuperSchemaModel, targetKey: string): string {
  const dialect = TARGET_TO_DIALECT[targetKey];
  if (!dialect) {
    throw new Error(`buildDbTypeSpecSource: not a DB target "${targetKey}"`);
  }
  const cfg = DIALECTS[dialect];

  const schemaName = sanitizeIdent(
    model.entity.domain || model.namespace || "public"
  ).toLowerCase();
  const ns = pascal(model.entity.domain || model.namespace || model.entity.name);
  const modelName = pascal(model.entity.name);

  const keyFields = model.fields
    .filter((f) => f.isKey)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const multiKey = keyFields.length > 1;

  const lines: string[] = [];
  lines.push(...cfg.imports, "", ...cfg.usings, "");
  lines.push(`@schema("${escapeStr(schemaName)}")`);
  lines.push(`namespace ${ns};`, "");

  if (model.entity.description) {
    lines.push(`@doc("${escapeStr(model.entity.description)}")`);
  }
  if (cfg.emitTableDecorator) {
    lines.push("@table");
  }
  // Spanner age-based retention → real ROW DELETION POLICY (D6 escalation).
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
      lines.push(`@rowDeletionPolicy("${sanitizeIdent(rp.referenceField)}", ${days})`);
    }
  }
  lines.push(`model ${modelName} {`);

  const sorted = [...model.fields].sort((a, b) => a.sortOrder - b.sortOrder);
  for (const f of sorted) {
    const decs: string[] = [];

    if (f.isKey) {
      decs.push(multiKey ? `@primaryKey(${keyFields.indexOf(f) + 1})` : "@primaryKey");
    }

    const maxLen = f.decorators?.typespec?.validation?.maxLength;
    if (f.type === "string" && typeof maxLen === "number" && maxLen > 0) {
      decs.push(`@maxLength(${maxLen})`);
    }

    if (cfg.decimalDecorator && DECIMAL_TYPES.has(f.type) && typeof f.precision === "number") {
      decs.push(
        typeof f.scale === "number"
          ? `${cfg.decimalDecorator}(${f.precision}, ${f.scale})`
          : `${cfg.decimalDecorator}(${f.precision})`
      );
    }

    const desc = f.decorators?.semantics?.description || f.description;
    if (desc) {
      decs.push(`@doc("${escapeStr(desc)}")`);
    }

    // Primary keys are never nullable.
    const optional = f.nullable && !f.isKey ? "?" : "";
    const tsType = mapType(f);
    const prefix = decs.length ? `${decs.join(" ")} ` : "";
    lines.push(`  ${prefix}${sanitizeIdent(f.name)}${optional}: ${tsType};`);
  }

  lines.push("}", "");
  return lines.join("\n");
}
