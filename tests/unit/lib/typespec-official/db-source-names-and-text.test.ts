import { describe, it, expect } from "vitest";
import type { LogicalType, SuperSchemaField, SuperSchemaModel } from "@/types/super-schema-model";
import { buildDbTypeSpecSource, buildDbTypeSpecTarget } from "@/lib/typespec-official/db-source";
import { POSTGRES_RESERVED_WORDS, BIGQUERY_RESERVED_WORDS, SPANNER_RESERVED_WORDS, isReservedWord } from "@/lib/typespec-official/sql-reserved-words";

/**
 * The builder's answers for text and names (fix round 1): description text is escaped for a TypeSpec string AND
 * flattened to one line; a name with no usable spelling or two names that end up as one column are ERRORS naming the
 * field / entity / domain; a hard-keyword field name is kept (quoted); every logical type becomes a column; an identifier
 * the emitters write unquoted but SQL needs quoted (reserved word, leading digit) is a WARNING.
 */

function field(overrides: Partial<SuperSchemaField> & { name: string; type: LogicalType }): SuperSchemaField {
  return { id: `f-${overrides.name}`, nullable: false, isKey: false, sortOrder: 0, ...overrides } as SuperSchemaField;
}

function model(overrides: { fields: SuperSchemaField[]; entity?: Record<string, unknown>; domain?: string }): SuperSchemaModel {
  return {
    namespace: "",
    entity: { name: "Transaction", description: "", domain: overrides.domain ?? "payments", metadata: {}, ...overrides.entity },
    fields: overrides.fields,
  } as unknown as SuperSchemaModel;
}

const KEY = field({ name: "transactionId", type: "string", isKey: true, sortOrder: 0 });
const ALL = ["spanner", "postgresql", "bigquery"] as const;

describe("description text", () => {
  const entityDoc = (description: string, target = "postgresql") => buildDbTypeSpecSource(model({ fields: [KEY], entity: { description } }), target);

  it("escapes ${ so a description is not read as a string template", () => {
    for (const target of ALL) expect(entityDoc("Total in ${currency}", target)).toContain('@doc("Total in \\${currency}")');
  });

  it("turns a lone CR, CRLF and LF into a space (the DDL puts it in a one-line comment or quoted string)", () => {
    expect(entityDoc("a\rb\r\nc\nd")).toContain('@doc("a b c d")');
  });

  it("escapes a tab, a backslash (also a trailing one) and double quotes", () => {
    expect(entityDoc("a\tb")).toContain('@doc("a\\tb")');
    expect(entityDoc("C:\\dir\\")).toContain('@doc("C:\\\\dir\\\\")');
    expect(entityDoc('say "hi"')).toContain('@doc("say \\"hi\\"")');
  });

  it("escapes a column description for a TypeSpec string exactly once, on every dialect (the BigQuery emitter does the SQL escaping)", () => {
    const f = field({ name: "id", type: "string", isKey: true, description: "it's ${x} C:\\dir\\ \"q\"\tz" });
    // TypeSpec text:  it's \${x} C:\\dir\\ \"q\"\tz
    for (const target of ALL) {
      expect(buildDbTypeSpecSource(model({ fields: [f] }), target), target).toContain('@doc("it\'s \\${x} C:\\\\dir\\\\ \\"q\\"\\tz")');
    }
  });

  it("also turns VT, FF, NEL, LS and PS into a space: tools that split on them would end a `--` comment early", () => {
    for (const target of ALL) {
      expect(entityDoc("a\vb\fc\u0085d\u2028e\u2029f", target), target).toContain('@doc("a b c d e f")');
    }
  });

  it("trims the ends, and gives a description that is only whitespace no @doc at all", () => {
    expect(entityDoc("  padded \n")).toContain('@doc("padded")\nmodel');
    expect(entityDoc(" \t\r\n ")).not.toContain("@doc");
  });
});

describe("names the dialects cannot spell", () => {
  it("names a field that has no letter or digit, instead of emitting a nameless column", () => {
    const target = buildDbTypeSpecTarget(model({ fields: [KEY, field({ name: "客户", type: "string", sortOrder: 1 })] }), "postgresql");
    expect(target.source).toBe("");
    expect(target.errors).toEqual(['The field "客户" cannot be turned into a column name: it has no letters or digits that the database dialects accept. Rename it.']);
  });

  it("names an entity and a domain that have no letter or digit", () => {
    const entity = buildDbTypeSpecTarget(model({ fields: [KEY], entity: { name: "客户" } }), "spanner");
    expect(entity.errors).toEqual(['The entity "客户" cannot be turned into a table name: it has no letters or digits that the database dialects accept. Rename it.']);
    const domain = buildDbTypeSpecTarget(model({ fields: [KEY], domain: "销售" }), "bigquery");
    expect(domain.errors).toEqual(['The domain "销售" cannot be turned into a schema name: it has no letters or digits that the database dialects accept. Rename it.']);
  });

  it("reports every unnameable name at once", () => {
    const target = buildDbTypeSpecTarget(model({ fields: [KEY, field({ name: "客户", type: "string", sortOrder: 1 }), field({ name: "_", type: "string", sortOrder: 2 })], entity: { name: "订单" } }), "postgresql");
    expect(target.errors).toHaveLength(3);
  });

  it("names two fields that would become the same column", () => {
    const idPair = buildDbTypeSpecTarget(model({ fields: [field({ name: "id", type: "string", isKey: true }), field({ name: "_id", type: "string", sortOrder: 1 })] }), "postgresql");
    expect(idPair.errors).toEqual(['The fields "id" and "_id" would both become the column "id". Rename one of them.']);
    const camelPair = buildDbTypeSpecTarget(model({ fields: [KEY, field({ name: "aB", type: "string", sortOrder: 1 }), field({ name: "a_b", type: "string", sortOrder: 2 })] }), "spanner");
    expect(camelPair.errors).toEqual(['The fields "aB" and "a_b" would both become the column "a_b". Rename one of them.']);
    const triple = buildDbTypeSpecTarget(model({ fields: [KEY, field({ name: "x-y", type: "string", sortOrder: 1 }), field({ name: "x y", type: "string", sortOrder: 2 }), field({ name: "xY", type: "string", sortOrder: 3 })] }), "bigquery");
    expect(triple.errors).toEqual(['The fields "x-y", "x y" and "xY" would all become the column "x_y". Rename all but one of them.']);
  });

  it("keeps a hard-keyword field name as the column name, quoted in the source", () => {
    const names = ["model", "namespace", "op", "import", "is", "using", "true"];
    const source = buildDbTypeSpecSource(model({ fields: [KEY, ...names.map((name, i) => field({ name, type: "string", sortOrder: i + 1 }))] }), "bigquery");
    for (const name of names) expect(source).toContain(`  \`${name}\`: string;`);
  });

  it("gives a digit-leading entity, domain and field a leading underscore", () => {
    const source = buildDbTypeSpecSource(model({ fields: [KEY, field({ name: "2024 total", type: "string", sortOrder: 1 })], entity: { name: "2024 Orders" }, domain: "2024 sales" }), "postgresql");
    expect(source).toContain('@schema("_2024_sales")\nnamespace _2024Sales;');
    expect(source).toContain("model _2024Orders {");
    expect(source).toContain("  _2024_total: string;");
  });
});

describe("every logical type becomes a column", () => {
  const SCALARS: LogicalType[] = [
    "string", "url", "integer", "int8", "int16", "int32", "int64", "safeint", "uint8", "uint16", "uint32", "uint64", "numeric",
    "float", "float32", "float64", "decimal", "decimal128", "boolean", "bytes", "plainDate", "plainTime", "utcDateTime",
    "offsetDateTime", "duration", "unixTimestamp32", "enum", "map", "object", "reference",
  ];
  // The scalars the three emitters have a column type for. Anything else is skipped by them with an `unsupported-type` warning.
  const EMITTER_SCALARS = new Set(["string", "int8", "int16", "int32", "int64", "safeint", "uint8", "uint16", "uint32", "uint64", "decimal", "decimal128", "float32", "float64", "boolean", "bytes", "plainDate", "utcDateTime", "offsetDateTime"]);

  it("maps each of the 30 non-array types and each array element type to a scalar the emitters have a column for", () => {
    const fields = [
      KEY,
      ...SCALARS.map((type, i) => field({ name: `f_${type}`, type, sortOrder: i + 1 })),
      ...SCALARS.map((type, i) => field({ name: `a_${type}`, type: "array", sortOrder: 100 + i, complexType: { arrayElementType: type } as SuperSchemaField["complexType"] })),
      field({ name: "a_untyped", type: "array", sortOrder: 200 }),
    ];
    const source = buildDbTypeSpecSource(model({ fields }), "postgresql");
    const types = [...source.matchAll(/^ {2}(?:@\S+(?:\([^)]*\))? )*`?\w+`?\??: ([\w]+)(\[\])?;$/gm)].map((m) => m[1]);

    expect(types).toHaveLength(fields.length);
    for (const scalar of types) expect(EMITTER_SCALARS.has(scalar), `${scalar} has no column type in the emitters`).toBe(true);
    expect(source).toContain("f_url: string;");
    expect(source).toContain("f_plainTime: string;");
    expect(source).toContain("f_duration: string;");
    expect(source).toContain("a_duration: string[];");
  });
});

describe("reserved words and other names SQL needs quoted: warnings, never silent renames", () => {
  const withColumn = (name: string, target: string) => buildDbTypeSpecTarget(model({ fields: [KEY, field({ name, type: "string", sortOrder: 1 })] }), target);

  it("warns once per reserved column on each dialect where it is reserved, naming the dialect, the column and the remedy", () => {
    expect(withColumn("order", "postgresql").warnings).toEqual([
      'The column "order" is a reserved word in PostgreSQL and the generated DDL does not quote it, so it will not run as is. Rename the field, or quote the name in the DDL by hand.',
    ]);
    expect(withColumn("order", "bigquery").warnings).toEqual([
      'The column "order" is a reserved word in BigQuery and the generated DDL does not quote it, so it will not run as is. Rename the field, or quote the name in the DDL by hand.',
    ]);
    expect(withColumn("Order", "spanner").warnings).toEqual([
      'The column "order" is a reserved word in Cloud Spanner and the generated DDL does not quote it, so it will not run as is. Rename the field, or quote the name in the DDL by hand.',
    ]);
  });

  it("does not warn about a name that only contains a reserved word, or about a column that is not reserved", () => {
    for (const target of ALL) {
      expect(withColumn("order_id", target).warnings).toEqual([]);
      expect(withColumn("orderBy", target).warnings).toEqual([]);
    }
  });

  it("checks each dialect's own list: user is reserved in PostgreSQL only, qualify in BigQuery only", () => {
    expect(withColumn("user", "postgresql").warnings).toHaveLength(1);
    expect(withColumn("user", "bigquery").warnings).toEqual([]);
    expect(withColumn("user", "spanner").warnings).toEqual([]);
    expect(withColumn("qualify", "bigquery").warnings).toHaveLength(1);
    expect(withColumn("qualify", "spanner").warnings).toEqual([]);
  });

  it("checks the table for Spanner and BigQuery, and the schema where the DDL names it", () => {
    const sentence = (kind: string, name: string, where: string, remedy: string) =>
      `The ${kind} "${name}" is a reserved word in ${where} and the generated DDL does not quote it, so it will not run as is. ${remedy}, or quote the name in the DDL by hand.`;
    expect(buildDbTypeSpecTarget(model({ fields: [KEY], entity: { name: "Order" } }), "spanner").warnings).toEqual([sentence("table", "order", "Cloud Spanner", "Rename the entity")]);
    expect(buildDbTypeSpecTarget(model({ fields: [KEY], entity: { name: "Order" } }), "bigquery").warnings).toEqual([sentence("table", "order", "BigQuery", "Rename the entity")]);
    const schema = buildDbTypeSpecTarget(model({ fields: [KEY], domain: "group" }), "bigquery");
    expect(schema.warnings).toEqual([sentence("schema", "group", "BigQuery", "Rename the domain")]);
    // Spanner's DDL carries no schema name, so a domain called `group` is harmless there
    expect(buildDbTypeSpecTarget(model({ fields: [KEY], domain: "group" }), "spanner").warnings).toEqual([]);
  });

  it("does not warn about a reserved TABLE name on PostgreSQL: its emitter always writes schema.table, and that runs", () => {
    expect(buildDbTypeSpecTarget(model({ fields: [KEY], entity: { name: "Order" } }), "postgresql").warnings).toEqual([]);
    // the schema name is another matter: `CREATE SCHEMA group` does not run
    expect(buildDbTypeSpecTarget(model({ fields: [KEY], domain: "group" }), "postgresql").warnings).toHaveLength(1);
  });

  it("warns about a table or column that starts with a digit (the emitters drop the leading underscore)", () => {
    const target = buildDbTypeSpecTarget(model({ fields: [KEY, field({ name: "2024 total", type: "string", sortOrder: 1 })], entity: { name: "2024 Orders" } }), "postgresql");
    expect(target.warnings).toEqual([
      'The table "2024orders" starts with a digit, which PostgreSQL does not allow in an unquoted name, and the generated DDL does not quote it, so it will not run as is. Rename the entity, or quote the name in the DDL by hand.',
      'The column "2024_total" starts with a digit, which PostgreSQL does not allow in an unquoted name, and the generated DDL does not quote it, so it will not run as is. Rename the field, or quote the name in the DDL by hand.',
    ]);
  });

  it("keeps compact, lower-case word lists that agree with the documentation's well-known entries", () => {
    for (const set of [POSTGRES_RESERVED_WORDS, BIGQUERY_RESERVED_WORDS, SPANNER_RESERVED_WORDS]) {
      for (const word of set) expect(word).toBe(word.toLowerCase());
      for (const word of ["select", "order", "group", "from", "where", "null"]) expect(set.has(word)).toBe(true);
    }
    expect(isReservedWord("postgres", "ORDER")).toBe(true);
    expect(isReservedWord("postgres", "name")).toBe(false);
  });
});

describe("names the dialect cannot hold, or holds as something else", () => {
  const withColumn = (name: string, target: string, over: Partial<SuperSchemaField> = {}) =>
    buildDbTypeSpecTarget(model({ fields: [KEY, field({ name, type: "string", sortOrder: 1, ...over })] }), target);

  it("a PostgreSQL system column name (xmin, xmax, cmin, cmax, ctid, tableoid) is a warning there, and only there", () => {
    for (const name of ["xmin", "xmax", "cmin", "cmax", "ctid", "tableoid", "XMIN"]) {
      expect(withColumn(name, "postgresql").warnings).toEqual([`The column "${name.toLowerCase()}" has the name of a PostgreSQL system column, so the table cannot be created. Rename the field.`]);
    }
    expect(withColumn("xmin", "spanner").warnings).toEqual([]);
    expect(withColumn("xmin", "bigquery").warnings).toEqual([]);
    expect(withColumn("xmin_value", "postgresql").warnings).toEqual([]);
  });

  it("a column name over the dialect's limit (PostgreSQL 63 bytes, Spanner 128, BigQuery 300) is a warning, at the limit it is not", () => {
    expect(withColumn("c".repeat(63), "postgresql").warnings).toEqual([]);
    expect(withColumn("c".repeat(64), "postgresql").warnings).toEqual([`The column "${"c".repeat(64)}" is longer than PostgreSQL's limit of 63 bytes and will be truncated or rejected.`]);
    expect(withColumn("c".repeat(128), "spanner").warnings).toEqual([]);
    expect(withColumn("c".repeat(129), "spanner").warnings).toEqual([`The column "${"c".repeat(129)}" is longer than Cloud Spanner's limit of 128 characters and will be truncated or rejected.`]);
    expect(withColumn("c".repeat(300), "bigquery").warnings).toEqual([]);
    expect(withColumn("c".repeat(301), "bigquery").warnings).toEqual([`The column "${"c".repeat(301)}" is longer than BigQuery's limit of 300 characters and will be truncated or rejected.`]);
    // 100 characters are fine on Spanner and BigQuery, too long on PostgreSQL
    expect(withColumn("c".repeat(100), "spanner").warnings).toEqual([]);
    expect(withColumn("c".repeat(100), "postgresql").warnings).toHaveLength(1);
  });

  it("a table name over the limit is a warning too", () => {
    const target = buildDbTypeSpecTarget(model({ fields: [KEY], entity: { name: "T".repeat(70) } }), "postgresql");
    expect(target.warnings).toEqual([`The table "${"t".repeat(70)}" is longer than PostgreSQL's limit of 63 bytes and will be truncated or rejected.`]);
  });

  it("two PostgreSQL columns that share their first 63 bytes are named as one column PostgreSQL would see", () => {
    const stem = "s".repeat(63);
    const target = buildDbTypeSpecTarget(model({ fields: [KEY, field({ name: `${stem}a`, type: "string", sortOrder: 1 }), field({ name: `${stem}b`, type: "string", sortOrder: 2 })] }), "postgresql");

    expect(target.errors).toEqual([]);
    expect(target.warnings).toContain(`The columns "${stem}a" and "${stem}b" share their first 63 bytes, which PostgreSQL truncates names to, so they would become one column. Rename one of them.`);
    // the same two names on BigQuery are two columns
    expect(buildDbTypeSpecTarget(model({ fields: [KEY, field({ name: `${stem}a`, type: "string", sortOrder: 1 }), field({ name: `${stem}b`, type: "string", sortOrder: 2 })] }), "bigquery").warnings).toEqual([]);
  });

  it("a BigQuery column description over 1,024 characters is a warning (BigQuery rejects it; nothing is cut)", () => {
    const long = "d".repeat(1025);
    const target = withColumn("note", "bigquery", { description: long });

    expect(target.warnings).toEqual(['The description of the field "note" is longer than BigQuery\'s limit of 1,024 characters, so BigQuery will reject the DDL as is. Shorten it.']);
    expect(target.source).toContain(`@doc("${long}")`);
    expect(withColumn("note", "bigquery", { description: "d".repeat(1024) }).warnings).toEqual([]);
    // only BigQuery has a limit on a column description; Spanner and PostgreSQL carry it as a comment of any length
    expect(withColumn("note", "spanner", { description: long }).warnings).toEqual([]);
    expect(withColumn("note", "postgresql", { description: long }).warnings).toEqual([]);
  });

  it("a field whose letters were dropped (accents, non-Latin) says so: café -> caf, prénom -> pr_nom", () => {
    expect(withColumn("café", "postgresql").warnings).toEqual(['The field "café" is written as the column "caf": letters outside a-z were dropped.']);
    expect(withColumn("prénom", "bigquery").warnings).toEqual(['The field "prénom" is written as the column "pr_nom": letters outside a-z were dropped.']);
    expect(withColumn("客户ID", "spanner").warnings).toEqual(['The field "客户ID" is written as the column "id": letters outside a-z were dropped.']);
  });

  it("plain case and separator normalisation is NOT warned about (aB, a-b, a.b, a b, HTTPServer)", () => {
    for (const name of ["aB", "a-b", "a.b", "a b", "HTTPServer", "order_Id"]) {
      for (const target of ALL) expect(withColumn(name, target).warnings, `${name} on ${target}`).toEqual([]);
    }
  });
});
