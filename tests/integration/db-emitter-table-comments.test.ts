/**
 * Table comments through the REAL Spanner, PostgreSQL and BigQuery emitters: the entity's description, then `Notes:` for
 * every column whose declared type the DDL cannot state (decimal precision and scale, a url or duration stored as text, ...).
 * All three emitters write the table's `@doc` as one `-- ` comment line before CREATE TABLE (the BigQuery emitter has no
 * table `OPTIONS(description=...)`), so the line is asserted whole. PostgreSQL runs on PGlite, a real engine.
 */
import { describe, it, expect } from "vitest";
import type { PrismaEntityInput, PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { emitOfficialTypeSpecTargetFromData, runTypeSpecEmitterWithWarnings } from "@/lib/typespec-official/emitter.service";
import { buildDbTypeSpecTarget } from "@/lib/typespec-official/db-source";
import { emittedColumnType } from "@/lib/typespec-official/db-column-types";
import type { LogicalType, SuperSchemaField, SuperSchemaModel } from "@/types/super-schema-model";

const TARGETS = [["spanner"], ["postgresql"], ["bigquery"]] as const;
type Target = (typeof TARGETS)[number][0];
const PACKAGE: Record<Target, string> = { spanner: "@typespec/spanner", postgresql: "@typespec/postgres", bigquery: "@typespec/bigquery" };
const DIALECT: Record<Target, "spanner" | "postgres" | "bigquery"> = { spanner: "spanner", postgresql: "postgres", bigquery: "bigquery" };
const LIMIT: Record<Target, number> = { spanner: 2000, postgresql: 2000, bigquery: 4000 };
const WHERE: Record<Target, string> = { spanner: "Cloud Spanner", postgresql: "PostgreSQL", bigquery: "BigQuery" };
const TEXT: Record<Target, string> = { spanner: "STRING(MAX)", postgresql: "TEXT", bigquery: "STRING" };

function entity(overrides: Partial<PrismaEntityInput> = {}): PrismaEntityInput {
  return { id: "e1", name: "Transaction", description: "", status: "active", version: 1, domainId: "d1", metadata: {}, domain: { id: "d1", name: "payments", slug: "payments" }, ...overrides };
}

function field(name: string, overrides: Partial<PrismaFieldInput> = {}): PrismaFieldInput {
  return { id: `f-${name}`, name, type: "string", precision: null, scale: null, nullable: true, isKey: false, fieldNumber: null, description: "", classification: null, aliases: [], decorators: {}, sortOrder: 1, ...overrides };
}

const KEY = field("transactionId", { isKey: true, nullable: false, sortOrder: 0 });

/** The comment lines directly above `CREATE TABLE` (the table's comment; empty when the line above is blank). */
function tableCommentLines(output: string): string[] {
  const lines = output.split("\n");
  const at = lines.findIndex((line) => line.startsWith("CREATE TABLE "));
  expect(at, `no CREATE TABLE in\n${output}`).toBeGreaterThan(0);
  const comment: string[] = [];
  for (let i = at - 1; i >= 0 && lines[i].startsWith("-- "); i--) comment.unshift(lines[i]);
  return comment;
}

const realistic = [
  KEY,
  field("amount", { type: "decimal", precision: 19, scale: 4, nullable: false, sortOrder: 1, description: "Amount in the account currency" }),
  field("currencyCode", { type: "string", nullable: false, sortOrder: 2, decorators: { typespec: { validation: { maxLength: 50 } } }, description: "ISO 4217" }),
  field("receiptUrl", { type: "url", sortOrder: 3 }),
  field("holdTime", { type: "duration", sortOrder: 4, description: "How long the funds are held" }),
];

describe.each(TARGETS)("%s: the table comment carries the notes", (target) => {
  const decimalNote =
    target === "postgresql"
      ? "amount: declared decimal(19,4); the DDL type is NUMERIC and does not enforce precision or scale"
      : `amount: declared decimal(19,4); the DDL type is NUMERIC, which ${WHERE[target]} fixes at precision 38 and scale 9`;

  it("a realistic entity: description first, then a note for the decimal, the url and the duration, none for the string that keeps its length", async () => {
    const result = await emitOfficialTypeSpecTargetFromData(entity({ description: "A payment transaction" }), realistic, target);

    expect(result.errors).toEqual([]);
    expect(result.validationStatus).toBe("VALID");
    expect(tableCommentLines(result.output)).toEqual([
      `-- A payment transaction Notes: ${decimalNote}; receipt_url (receiptUrl): declared url; stored as ${TEXT[target]}; hold_time (holdTime): declared duration; stored as ${TEXT[target]}.`,
    ]);
    // the string's length reaches the DDL type, so it is not a note
    expect(result.output).toContain(target === "postgresql" ? "currency_code VARCHAR(50) NOT NULL" : "currency_code STRING(50) NOT NULL");
    expect(result.output).not.toContain("currency_code: declared");
  }, 60_000);

  it("without a description the table comment is the notes alone", async () => {
    const result = await emitOfficialTypeSpecTargetFromData(entity(), realistic, target);

    expect(result.errors).toEqual([]);
    expect(tableCommentLines(result.output)[0]).toMatch(/^-- Notes: amount: declared decimal\(19,4\);/);
    expect(tableCommentLines(result.output)).toHaveLength(1);
  }, 60_000);

  it("a model of plain types with no description has no table comment at all (the line above CREATE TABLE is blank)", async () => {
    const plain = [KEY, field("name", { sortOrder: 1 }), field("count", { type: "int32", sortOrder: 2 }), field("price", { type: "decimal", sortOrder: 3 }), field("at", { type: "utcDateTime", sortOrder: 4 })];
    const result = await emitOfficialTypeSpecTargetFromData(entity(), plain, target);

    expect(result.errors).toEqual([]);
    expect(tableCommentLines(result.output)).toEqual([]);
    expect(result.output).not.toContain("Notes:");
  }, 60_000);

  it("a model of plain types keeps its description alone as the table comment", async () => {
    const result = await emitOfficialTypeSpecTargetFromData(entity({ description: "Just text" }), [KEY, field("name")], target);

    expect(tableCommentLines(result.output)).toEqual(["-- Just text"]);
  }, 60_000);

  it("a reserved word and a letter that was dropped keep their warnings, and the notes name the emitted columns", async () => {
    const fields = [
      KEY,
      field("Order", { type: "duration", sortOrder: 1 }),
      field("café", { type: "url", sortOrder: 2 }),
      field("orderTotal", { type: "decimal", precision: 12, scale: 2, sortOrder: 3 }),
    ];
    const result = await emitOfficialTypeSpecTargetFromData(entity(), fields, target);

    expect(result.errors).toEqual([]);
    expect(result.validationStatus).toBe("WARNING");
    expect(result.warnings.some((w) => w.startsWith('The column "order" is a reserved word'))).toBe(true);
    expect(result.warnings).toContain('The field "café" is written as the column "caf": letters outside a-z were dropped.');
    expect(result.warnings.filter((w) => w.includes("Notes"))).toEqual([]);
    const [comment] = tableCommentLines(result.output);
    expect(comment).toContain(`order (Order): declared duration; stored as ${TEXT[target]}`);
    expect(comment).toContain(`caf: declared url; stored as ${TEXT[target]}`);
    expect(comment).toContain("order_total (orderTotal): declared decimal(12,2);");
    expect(result.output).toMatch(/^ {2}caf /m);
    expect(result.output).toMatch(/^ {2}order_total /m);
  }, 60_000);

  it("300 lossy columns: the notes are cut under the limit, end `...and N more.`, and the DDL still has every column", async () => {
    const columns = Array.from({ length: 300 }, (_, i) => field(`c_${i}`, { type: "url", sortOrder: i + 1 }));
    const result = await emitOfficialTypeSpecTargetFromData(entity({ description: "Wide table" }), [KEY, ...columns], target);

    expect(result.errors).toEqual([]);
    expect(result.validationStatus).toBe("VALID");
    const comment = tableCommentLines(result.output);
    expect(comment).toHaveLength(1);
    const block = comment[0].slice("-- Wide table ".length);
    expect(block.length).toBeLessThanOrEqual(LIMIT[target]);
    const cut = block.match(/; \.\.\.and (\d+) more\.$/);
    expect(cut, block.slice(-80)).not.toBeNull();
    const shown = block.match(/c_\d+: declared url/g)?.length ?? 0;
    expect(shown + Number(cut?.[1])).toBe(300);
    expect(shown).toBeGreaterThan(0);
    // every column is still a column line, each with its comma before anything else
    const columnLines = result.output.split("\n").filter((line) => /^ {2}c_\d+ /.test(line));
    expect(columnLines).toHaveLength(300);
    for (const line of columnLines) expect(line).toMatch(/^ {2}c_\d+ [A-Z()]+,$/);
  }, 60_000);

  it("an adversarial entity description with notes is one comment line: quotes, ${x}, backslash, --, */ and line breaks cannot leave it", async () => {
    const description = "Quote \" and ' ${x} back\\slash -- dash */ end\nsecond line\r\nthird\u2028fourth \\";
    const result = await emitOfficialTypeSpecTargetFromData(entity({ description }), realistic, target);

    expect(result.errors).toEqual([]);
    expect(result.validationStatus).toBe("VALID");
    const comment = tableCommentLines(result.output);
    expect(comment).toHaveLength(1);
    expect(comment[0]).toContain("-- Quote \" and ' ${x} back\\slash -- dash */ end second line third fourth \\ Notes: amount: declared decimal(19,4);");
    // the line after the comment is the statement itself
    const lines = result.output.split("\n");
    expect(lines[lines.indexOf(comment[0]) + 1]).toMatch(/^CREATE TABLE /);
  }, 60_000);
});

describe("postgresql: the DDL with a table comment of notes runs on a real engine (PGlite)", () => {
  it("creates the table with an adversarial description and the notes, and with 300 lossy columns", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const hostile = "it's \"x\" ${y} \\ -- ; */ /* \nnext";
    const wide = Array.from({ length: 300 }, (_, i) => field(`c_${i}`, { type: i % 2 ? "duration" : "decimal", precision: i % 2 ? null : 10, scale: i % 2 ? null : 2, sortOrder: i + 1 }));
    for (const [name, fields, description] of [["realistic", realistic, hostile], ["wide", [KEY, ...wide], "Wide"]] as const) {
      const result = await emitOfficialTypeSpecTargetFromData(entity({ description }), [...fields], "postgresql");
      expect(result.errors, name).toEqual([]);

      const db = new PGlite();
      try {
        await db.exec(result.output);
        const count = await db.query<{ n: number }>("select count(*)::int as n from information_schema.columns where table_schema = 'payments' and table_name = 'transaction'");
        expect(count.rows[0].n, name).toBe(fields.length);
      } finally {
        await db.close();
      }
    }
  }, 120_000);
});

describe.each(TARGETS)("%s: the printed column type the notes rely on is the one the emitter really prints", (target) => {
  const SCALARS: LogicalType[] = [
    "string", "url", "integer", "int8", "int16", "int32", "int64", "safeint", "uint8", "uint16", "uint32", "uint64", "numeric",
    "float", "float32", "float64", "decimal", "decimal128", "boolean", "bytes", "plainDate", "plainTime", "utcDateTime",
    "offsetDateTime", "duration", "unixTimestamp32", "enum", "map", "object", "reference",
  ];

  it("emittedColumnType equals the DDL's column type for every logical type, scalar and array, and a string with a length", async () => {
    const base = { nullable: true, isKey: false, description: "", aliases: [], decorators: {} };
    const fields: SuperSchemaField[] = [
      { id: "k", name: "id", type: "string", nullable: false, isKey: true, sortOrder: 0, description: "", aliases: [], decorators: {} },
      ...SCALARS.map((type, i): SuperSchemaField => ({ ...base, id: `s${i}`, name: `s_${type}`, type, sortOrder: i + 1 })),
      ...SCALARS.map((type, i): SuperSchemaField => ({ ...base, id: `a${i}`, name: `a_${type}`, type: "array", complexType: { arrayElementType: type } as SuperSchemaField["complexType"], sortOrder: 100 + i })),
      { ...base, id: "u", name: "a_untyped", type: "array", sortOrder: 200 },
      { ...base, id: "l", name: "s_len", type: "string", sortOrder: 201, decorators: { typespec: { validation: { maxLength: 50 } } } },
    ];
    const model = { namespace: "", entity: { name: "Everything", description: "", domain: "sales", metadata: {} }, fields } as unknown as SuperSchemaModel;
    const built = buildDbTypeSpecTarget(model, target);
    expect(built.errors).toEqual([]);

    const run = await runTypeSpecEmitterWithWarnings(PACKAGE[target], built.source, { "naming-convention": "snake_case" });

    expect(run.success).toBe(true);
    if (!run.success) return;
    const ddl = run.data.files.map((file) => file.content).join("\n");
    for (const f of fields) {
      const column = f.name.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
      const line = ddl.split("\n").find((l) => l.startsWith(`  ${column} `));
      expect(line, `no column ${column}`).toBeDefined();
      const printed = (line ?? "").slice(`  ${column} `.length).replace(/,( -- .*)?$/, "").replace(/ NOT NULL$/, "");
      expect(printed, `${target}: ${f.name}`).toBe(emittedColumnType(DIALECT[target], f));
    }
  }, 60_000);
});
