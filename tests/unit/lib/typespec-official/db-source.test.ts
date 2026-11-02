import { describe, it, expect } from "vitest";
import type { SuperSchemaField, SuperSchemaModel } from "@/types/super-schema-model";
import { buildDbTypeSpecSource, buildDbTypeSpecTarget, isDbTypeSpecTarget } from "@/lib/typespec-official/db-source";

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

  it("puts the field's description on its column as @doc for every dialect (the emitters write the comma before the comment)", () => {
    for (const { target } of DIALECTS) {
      const source = buildDbTypeSpecSource(model({ fields: described }), target);
      expect(source, target).toContain('@primaryKey @doc("Primary key") transactionId: string;');
      expect(source, target).toContain('@doc("Amount in minor units") amount: decimal;');
    }
  });

  it("puts no @doc on a column whose description is empty or only whitespace and line breaks", () => {
    const blank = [
      field({ name: "id", type: "string", isKey: true, sortOrder: 0, description: "" }),
      field({ name: "spaces", type: "string", sortOrder: 1, description: "  \t \r\n " }),
    ];
    for (const { target } of DIALECTS) {
      const source = buildDbTypeSpecSource(model({ fields: blank }), target);
      expect(source, target).not.toMatch(/@doc\("\s*"\)/);
      expect(source.match(/@doc\(/g), target).toHaveLength(1); // the table's own
    }
  });

  it("escapes a quote and a backslash for the TypeSpec string only: the BigQuery emitter escapes them for SQL itself", () => {
    const tricky = [field({ name: "id", type: "string", isKey: true, sortOrder: 0, description: "Customer's id, C:\\dir" })];
    // TypeSpec text `Customer's id, C:\\dir` (every backslash doubled once); no SQL escaping on top for any dialect
    for (const { target } of DIALECTS) {
      expect(buildDbTypeSpecSource(model({ fields: tricky }), target), target).toContain('@doc("Customer\'s id, C:\\\\dir")');
    }
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

describe("buildDbTypeSpecTarget: a type the app does not have", () => {
  // A row written before the writers refused a model or scalar name as a field type (`Price`): no column type exists for it.
  const legacy = (overrides: Partial<SuperSchemaField>) => field({ name: "price", type: "string", sortOrder: 3, ...overrides });

  it.each(DIALECTS)("is an error on $target, never a string column", ({ target }) => {
    const built = buildDbTypeSpecTarget(model({ fields: [...FIELDS, legacy({ type: "Price" as SuperSchemaField["type"] })] }), target);
    expect(built.source).toBe("");
    expect(built.errors).toEqual([`The field "price" is typed "Price", which is not a type of this app. Retype the field as one of the app's types.`]);
  });

  it("is an error for an array whose element type the app does not have", () => {
    const built = buildDbTypeSpecTarget(model({ fields: [...FIELDS, legacy({ type: "array", complexType: { arrayElementType: "Price" } as unknown as SuperSchemaField["complexType"] })] }), "postgresql");
    expect(built.source).toBe("");
    expect(built.errors).toEqual([expect.stringContaining('typed "Price"')]);
  });

  it("is not an error for the app's own types, a union, an enum, a reference or an array with no element type", () => {
    const own = [
      legacy({ name: "status", type: "enum" }),
      legacy({ name: "other", type: "union", sortOrder: 4 }),
      legacy({ name: "customer", type: "reference", sortOrder: 5 }),
      legacy({ name: "tags", type: "array", sortOrder: 6 }),
    ];
    for (const target of ["spanner", "postgresql", "bigquery"]) {
      const built = buildDbTypeSpecTarget(model({ fields: [...FIELDS, ...own] }), target);
      expect(built.errors, target).toEqual([]);
      expect(built.source, target).toContain("status");
    }
  });
});
