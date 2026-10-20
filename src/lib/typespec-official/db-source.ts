/**
 * db-source.ts — builds TypeSpec (.tsp) source for the database emitter
 * packages (@typespec/spanner, @typespec/postgres, @typespec/bigquery) from a
 * SuperSchemaModel.
 *
 * These emitters read the logical shape from TypeSpec models + THEIR OWN
 * decorators (`@schema`, `@primaryKey`, ...), then emit dialect DDL. Each package
 * is self-contained: it declares those decorators itself and its emitter reads
 * the state of its own decorators only. A decorator of another library (the shared
 * @typespec/db has the same names) compiles but is invisible to the emitter, which
 * then writes no file (`@schema` from the wrong library = no schema namespace = no
 * table). So the source below imports and uses exactly one library: the dialect's.
 * This builder is the bridge from our IR to that authoring surface.
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
  /** The dialect's emitter package: the only library the generated source imports. */
  library: string;
  /** Its TypeSpec namespace (`using`): it carries the decorators the emitter reads. */
  namespace: string;
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
  spanner: { library: "@typespec/spanner", namespace: "TypeSpec.Spanner", columnDoc: null },
  postgres: { library: "@typespec/postgres", namespace: "TypeSpec.Postgres", columnDoc: null },
  bigquery: { library: "@typespec/bigquery", namespace: "TypeSpec.BigQuery", columnDoc: escapeSqlString },
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
  lines.push(`import "${cfg.library}";`, "", `using ${cfg.namespace};`, "");
  lines.push(`@schema("${escapeStr(schemaName)}")`);
  lines.push(`namespace ${ns};`, "");

  if (model.entity.description) {
    lines.push(`@doc("${escapeStr(model.entity.description)}")`);
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

    const desc = f.decorators?.semantics?.description || f.description;
    if (desc && cfg.columnDoc) {
      decs.push(`@doc("${escapeStr(cfg.columnDoc(desc))}")`);
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
