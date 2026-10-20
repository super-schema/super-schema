import { describe, it, expect } from "vitest";
import type { SuperSchemaField, SuperSchemaModel } from "@/types/super-schema-model";
import { buildDbTypeSpecSource, isDbTypeSpecTarget } from "@/lib/typespec-official/db-source";

/**
 * The DB DDL emitter packages (@typespec/spanner|postgres|bigquery) are self-contained: each declares its OWN
 * `@schema` / `@primaryKey` / ... and its emitter reads the state of ITS decorators only. A decorator from another
 * library (a shared one with the same names, such as the former @typespec/db) compiles fine but is invisible to the emitter, which then writes no file. The
 * generated source must therefore use only the decorators of the dialect package it emits through.
 */

function field(overrides: Partial<SuperSchemaField> & { name: string; type: SuperSchemaField["type"] }): SuperSchemaField {
  return {
    id: `f-${overrides.name}`,
    nullable: false,
    isKey: false,
    sortOrder: 0,
    ...overrides,
  } as SuperSchemaField;
}

function model(overrides: { fields: SuperSchemaField[]; metadata?: Record<string, unknown> }): SuperSchemaModel {
  return {
    namespace: "payments",
    entity: { name: "Transaction", description: "A payment transaction", domain: "payments", metadata: overrides.metadata ?? {} },
    fields: overrides.fields,
  } as unknown as SuperSchemaModel;
}

const FIELDS = [
  field({ name: "transactionId", type: "string", isKey: true, sortOrder: 0 }),
  field({ name: "amount", type: "decimal", precision: 19, scale: 4, sortOrder: 1 }),
  field({ name: "createdAt", type: "utcDateTime", sortOrder: 2 }),
];

const RETENTION = { retentionPolicy: { strategy: "age-based", period: 90, periodUnit: "days", referenceField: "createdAt", action: "delete" } };

const DIALECTS = [
  { target: "spanner", library: "@typespec/spanner", namespace: "TypeSpec.Spanner" },
  { target: "postgresql", library: "@typespec/postgres", namespace: "TypeSpec.Postgres" },
  { target: "bigquery", library: "@typespec/bigquery", namespace: "TypeSpec.BigQuery" },
] as const;

describe("isDbTypeSpecTarget", () => {
  it("routes exactly the three DB DDL targets", () => {
    expect(["spanner", "postgresql", "bigquery", "avro", "openapi3"].map(isDbTypeSpecTarget)).toEqual([true, true, true, false, false]);
  });
});

describe.each(DIALECTS)("buildDbTypeSpecSource: $target", ({ target, library, namespace }) => {
  const source = buildDbTypeSpecSource(model({ fields: FIELDS }), target);

  it("imports only the dialect's own package and uses only its namespace", () => {
    const imports = source.split("\n").filter((line) => line.startsWith("import "));
    expect(imports).toEqual([`import "${library}";`]);
    expect(source.split("\n").filter((line) => line.startsWith("using "))).toEqual([`using ${namespace};`]);
  });

  it("uses no decorator of the shared @typespec/db library (the dialect emitters cannot read it)", () => {
    expect(source).not.toContain("@typespec/db");
    expect(source).not.toContain("TypeSpec.DB");
    expect(source).not.toMatch(/@table\b/);
    expect(source).not.toMatch(/@decimalPrecision\b/);
  });

  it("declares the schema namespace, the model and its primary key with the dialect's decorators", () => {
    expect(source).toContain('@schema("payments")\nnamespace Payments;');
    expect(source).toContain("model Transaction {");
    expect(source).toContain("@primaryKey transactionId: string;");
  });
});

describe("buildDbTypeSpecSource: documentation", () => {
  const described = [
    field({ name: "transactionId", type: "string", isKey: true, sortOrder: 0, description: "Primary key" }),
    field({ name: "amount", type: "decimal", sortOrder: 1, description: "Amount in minor units" }),
  ];

  it("keeps the table's @doc for every dialect (a comment line of its own in the DDL)", () => {
    for (const { target } of DIALECTS) {
      expect(buildDbTypeSpecSource(model({ fields: described }), target)).toContain('@doc("A payment transaction")\nmodel Transaction {');
    }
  });

  it("puts no @doc on a column for spanner and postgres: their emitters write it as ` -- text` and then the column's comma, which the comment swallows", () => {
    for (const target of ["spanner", "postgresql"]) {
      const source = buildDbTypeSpecSource(model({ fields: described }), target);
      expect(source).not.toContain("Primary key");
      expect(source).not.toContain("Amount in minor units");
    }
  });

  it("keeps a column's @doc for bigquery (written as OPTIONS(description=...), which is valid DDL)", () => {
    const source = buildDbTypeSpecSource(model({ fields: described }), "bigquery");
    expect(source).toContain('@primaryKey @doc("Primary key") transactionId: string;');
    expect(source).toContain('@doc("Amount in minor units") amount: decimal;');
  });

  it("escapes a quote and a backslash in a bigquery column description for the single-quoted SQL string the emitter writes it into", () => {
    const tricky = [field({ name: "id", type: "string", isKey: true, sortOrder: 0, description: "Customer's id, C:\\dir" })];
    // SQL text `Customer\'s id, C:\\dir`, then written as a TypeSpec string literal (every backslash doubled again)
    expect(buildDbTypeSpecSource(model({ fields: tricky }), "bigquery")).toContain('@doc("Customer\\\\\'s id, C:\\\\\\\\dir")');
  });
});

describe("buildDbTypeSpecSource: retention and keys", () => {
  it("spanner turns an age-based retention policy into @rowDeletionPolicy (column, days)", () => {
    const source = buildDbTypeSpecSource(model({ fields: FIELDS, metadata: RETENTION }), "spanner");
    expect(source).toContain('@rowDeletionPolicy("createdAt", 90)\nmodel Transaction {');
  });

  it("spanner converts months and years to days", () => {
    const months = buildDbTypeSpecSource(model({ fields: FIELDS, metadata: { retentionPolicy: { ...RETENTION.retentionPolicy, period: 2, periodUnit: "months" } } }), "spanner");
    const years = buildDbTypeSpecSource(model({ fields: FIELDS, metadata: { retentionPolicy: { ...RETENTION.retentionPolicy, period: 1, periodUnit: "years" } } }), "spanner");
    expect(months).toContain('@rowDeletionPolicy("createdAt", 60)');
    expect(years).toContain('@rowDeletionPolicy("createdAt", 365)');
  });

  it("postgres and bigquery have no row deletion policy decorator, so they never emit it", () => {
    for (const target of ["postgresql", "bigquery"]) {
      expect(buildDbTypeSpecSource(model({ fields: FIELDS, metadata: RETENTION }), target)).not.toContain("rowDeletionPolicy");
    }
  });

  it("numbers the columns of a composite primary key by position", () => {
    const keyed = [
      field({ name: "a", type: "string", isKey: true, sortOrder: 0 }),
      field({ name: "b", type: "string", isKey: true, sortOrder: 1 }),
    ];
    const source = buildDbTypeSpecSource(model({ fields: keyed }), "postgresql");
    expect(source).toContain("@primaryKey(1)");
    expect(source).toContain("@primaryKey(2)");
  });

  it("rejects a target that is not a DB target", () => {
    expect(() => buildDbTypeSpecSource(model({ fields: FIELDS }), "avro")).toThrow(/not a DB target/);
  });
});
