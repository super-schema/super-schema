/**
 * The DB targets through the REAL emitters (the parity-test pattern) for the inputs that never ran before: description text
 * with `${`, CR, tab and backslashes; names that are TypeSpec keywords, start with a digit, have no Latin letter or collide;
 * every logical type; SQL reserved words.
 */
import { describe, it, expect } from "vitest";
import type { PrismaEntityInput, PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { emitOfficialTypeSpecTargetFromData, runTypeSpecEmitterWithWarnings } from "@/lib/typespec-official/emitter.service";
import { buildDbTypeSpecTarget } from "@/lib/typespec-official/db-source";
import type { LogicalType, SuperSchemaField, SuperSchemaModel } from "@/types/super-schema-model";

const TARGETS = [["spanner"], ["postgresql"], ["bigquery"]] as const;
const PACKAGE: Record<string, string> = { spanner: "@typespec/spanner", postgresql: "@typespec/postgres", bigquery: "@typespec/bigquery" };

function entity(overrides: Partial<PrismaEntityInput> = {}): PrismaEntityInput {
  return { id: "e1", name: "Transaction", description: "", status: "active", version: 1, domainId: "d1", metadata: {}, domain: { id: "d1", name: "payments", slug: "payments" }, ...overrides };
}

function field(name: string, overrides: Partial<PrismaFieldInput> = {}): PrismaFieldInput {
  return { id: `f-${name}`, name, type: "string", precision: null, scale: null, nullable: true, isKey: false, fieldNumber: null, description: "", classification: null, aliases: [], decorators: {}, sortOrder: 1, ...overrides };
}

const KEY = field("transactionId", { isKey: true, nullable: false, sortOrder: 0 });

describe.each(TARGETS)("%s: description text the emitters must carry", (target) => {
  // [what the user typed, what the DDL carries once line breaks are one space]
  const CASES: Array<[string, string]> = [
    ["Total in ${currency}", "Total in ${currency}"],
    ["line1\rline2", "line1 line2"],
    ["line1\r\nline2\nline3", "line1 line2 line3"],
    ["a\tb", "a\tb"],
    ["C:\\dir\\", "C:\\dir\\"],
    ['say "hi" and it\'s', 'say "hi" and it\'s'],
  ];

  it.each(CASES)("an entity description %j is VALID and the table comment keeps its text", async (typed, carried) => {
    const result = await emitOfficialTypeSpecTargetFromData(entity({ description: typed }), [KEY], target);

    expect(result.errors).toEqual([]);
    expect(result.validationStatus).toBe("VALID");
    expect(result.output).toContain(`-- ${carried}\n`);
  }, 60_000);
});

describe("bigquery: a field description is a single-quoted SQL string", () => {
  // [typed, the SQL string literal the DDL must contain]
  const CASES: Array<[string, string]> = [
    ["Total in ${currency}", "description='Total in ${currency}'"],
    ["line1\rline2", "description='line1 line2'"],
    ["a\tb", "description='a\tb'"],
    ["C:\\dir\\", "description='C:\\\\dir\\\\'"],
    ['say "hi" and it\'s', "description='say \"hi\" and it\\'s'"],
  ];

  it.each(CASES)("%j is VALID and written as %s", async (typed, literal) => {
    const result = await emitOfficialTypeSpecTargetFromData(entity(), [{ ...KEY, description: typed }], "bigquery");

    expect(result.errors).toEqual([]);
    expect(result.validationStatus).toBe("VALID");
    expect(result.output).toContain(literal);
  }, 60_000);
});

describe.each(TARGETS)("%s: field and entity names", (target) => {
  it("a hard TypeSpec keyword as a field name (model, namespace, op, import, is, using, true) compiles and is a column", async () => {
    const names = ["model", "namespace", "op", "import", "is", "using", "true"];
    const result = await emitOfficialTypeSpecTargetFromData(entity(), [KEY, ...names.map((name, i) => field(name, { sortOrder: i + 1 }))], target);

    expect(result.errors).toEqual([]);
    expect(result.validationStatus).not.toBe("INVALID");
    for (const name of names) expect(result.output, `no column ${name}`).toMatch(new RegExp(`^\\s+${name} `, "m"));
  }, 60_000);

  it("a digit-leading entity and domain compile; the digit-leading table gets a warning, because the DDL cannot run unquoted", async () => {
    const result = await emitOfficialTypeSpecTargetFromData(entity({ name: "2024 Orders", domain: { id: "d1", name: "2024 sales", slug: "2024-sales" } }), [KEY], target);

    expect(result.errors).toEqual([]);
    expect(result.validationStatus).toBe("WARNING");
    expect(result.output).toContain("CREATE TABLE");
    expect(result.warnings.some((w) => w.startsWith('The table "2024orders" starts with a digit'))).toBe(true);
  }, 60_000);

  it("a digit-leading field compiles and warns", async () => {
    const result = await emitOfficialTypeSpecTargetFromData(entity(), [KEY, field("2024 total")], target);

    expect(result.errors).toEqual([]);
    expect(result.warnings.some((w) => w.startsWith('The column "2024_total" starts with a digit'))).toBe(true);
  }, 60_000);

  it("a domain with no Latin letter or digit is INVALID and names the domain (not a cryptic ambiguous-symbol)", async () => {
    const result = await emitOfficialTypeSpecTargetFromData(entity({ domain: { id: "d1", name: "销售", slug: "xiao-shou" } }), [KEY], target);

    expect(result.validationStatus).toBe("INVALID");
    expect(result.errors).toEqual([{ message: 'The domain "销售" cannot be turned into a schema name: it has no letters or digits that the database dialects accept. Rename it.' }]);
  }, 60_000);

  it("an entity with no Latin letter or digit is INVALID and names the entity (not a table silently called `model`)", async () => {
    const result = await emitOfficialTypeSpecTargetFromData(entity({ name: "客户" }), [KEY], target);

    expect(result.validationStatus).toBe("INVALID");
    expect(result.errors).toEqual([{ message: 'The entity "客户" cannot be turned into a table name: it has no letters or digits that the database dialects accept. Rename it.' }]);
  }, 60_000);

  it("a non-Latin field name is INVALID and names the field (not a nameless column reported VALID)", async () => {
    const result = await emitOfficialTypeSpecTargetFromData(entity(), [KEY, field("客户")], target);

    expect(result.validationStatus).toBe("INVALID");
    expect(result.errors).toEqual([{ message: 'The field "客户" cannot be turned into a column name: it has no letters or digits that the database dialects accept. Rename it.' }]);
  }, 60_000);

  it.each([
    [["id", "_id"], 'The fields "id" and "_id" would both become the column "id". Rename one of them.'],
    [["aB", "a_b"], 'The fields "aB" and "a_b" would both become the column "a_b". Rename one of them.'],
  ])("fields %j that collapse into one column are INVALID and named", async (names, message) => {
    const fields = names.map((name, i) => field(name, { sortOrder: i, isKey: i === 0, nullable: i !== 0 }));
    const result = await emitOfficialTypeSpecTargetFromData(entity(), fields, target);

    expect(result.validationStatus).toBe("INVALID");
    expect(result.errors).toEqual([{ message }]);
  }, 60_000);
});

describe.each(TARGETS)("%s: every logical type", (target) => {
  const SCALARS: LogicalType[] = [
    "string", "url", "integer", "int8", "int16", "int32", "int64", "safeint", "uint8", "uint16", "uint32", "uint64", "numeric",
    "float", "float32", "float64", "decimal", "decimal128", "boolean", "bytes", "plainDate", "plainTime", "utcDateTime",
    "offsetDateTime", "duration", "unixTimestamp32", "enum", "map", "object", "reference",
  ];

  it("produces a column for every field, scalar or array of any element type, with no emitter warning", async () => {
    const fields: SuperSchemaField[] = [
      { id: "k", name: "id", type: "string", nullable: false, isKey: true, sortOrder: 0, description: "", aliases: [], decorators: {} },
      ...SCALARS.map((type, i): SuperSchemaField => ({ id: `s${i}`, name: `s_${type}`, type, nullable: true, isKey: false, sortOrder: i + 1, description: "", aliases: [], decorators: {} })),
      ...SCALARS.map((type, i): SuperSchemaField => ({ id: `a${i}`, name: `a_${type}`, type: "array", complexType: { arrayElementType: type } as SuperSchemaField["complexType"], nullable: true, isKey: false, sortOrder: 100 + i, description: "", aliases: [], decorators: {} })),
    ];
    const model = { namespace: "", entity: { name: "Everything", description: "", domain: "sales", metadata: {} }, fields } as unknown as SuperSchemaModel;
    const built = buildDbTypeSpecTarget(model, target);
    expect(built.errors).toEqual([]);

    const run = await runTypeSpecEmitterWithWarnings(PACKAGE[target], built.source, { "naming-convention": "snake_case" });

    expect(run.success).toBe(true);
    if (!run.success) return;
    expect(run.data.warnings).toEqual([]);
    const ddl = run.data.files.map((file) => file.content).join("\n");
    for (const f of fields) {
      const column = f.name.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
      expect(ddl, `no column ${column}`).toMatch(new RegExp(`^\\s+${column} `, "m"));
    }
  }, 60_000);

  it.each([["url"], ["plainTime"], ["duration"]])("a %s field arrives through the whole service as a column, status VALID", async (type) => {
    const result = await emitOfficialTypeSpecTargetFromData(entity(), [KEY, field("extra", { type })], target);

    expect(result.errors).toEqual([]);
    expect(result.validationStatus).toBe("VALID");
    expect(result.output).toMatch(/^\s+extra /m);
  }, 60_000);
});

describe.each(TARGETS)("%s: SQL reserved words", (target) => {
  const dialect = { spanner: "Cloud Spanner", postgresql: "PostgreSQL", bigquery: "BigQuery" }[target];

  it("a reserved column name is WARNING (the DDL is still produced) with the message naming the dialect, the column and the remedy", async () => {
    const result = await emitOfficialTypeSpecTargetFromData(entity(), [KEY, field("order")], target);

    expect(result.errors).toEqual([]);
    expect(result.validationStatus).toBe("WARNING");
    expect(result.warnings).toEqual([`The column "order" is a reserved word in ${dialect} and the generated DDL does not quote it, so it will not run as is. Rename the field, or quote the name in the DDL by hand.`]);
    expect(result.output).toMatch(/^\s+order /m);
  }, 60_000);

  it("order_id is VALID with no warning", async () => {
    const result = await emitOfficialTypeSpecTargetFromData(entity(), [KEY, field("order_id")], target);

    expect(result.validationStatus).toBe("VALID");
    expect(result.warnings).toEqual([]);
  }, 60_000);

  it("a reserved entity name warns about the table", async () => {
    const result = await emitOfficialTypeSpecTargetFromData(entity({ name: "Order" }), [KEY], target);

    expect(result.validationStatus).toBe("WARNING");
    expect(result.warnings).toEqual([`The table "order" is a reserved word in ${dialect} and the generated DDL does not quote it, so it will not run as is. Rename the entity, or quote the name in the DDL by hand.`]);
  }, 60_000);
});

it("the reserved-word warning is true: a real PostgreSQL engine (PGlite) rejects the DDL with a column called order, and runs it with order_id", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const reserved = await emitOfficialTypeSpecTargetFromData(entity(), [KEY, field("order")], "postgresql");
  const fine = await emitOfficialTypeSpecTargetFromData(entity(), [KEY, field("order_id")], "postgresql");
  const db = new PGlite();
  try {
    await expect(db.exec(reserved.output)).rejects.toThrow(/syntax error/i);
    await expect(db.exec(fine.output)).resolves.toBeDefined();
  } finally {
    await db.close();
  }
}, 60_000);
