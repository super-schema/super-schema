/**
 * Column comments through the REAL Spanner, PostgreSQL and BigQuery emitters (built with the sibling write.ts patch:
 * the comment goes after the column's separator, `col TYPE, -- text`, and BigQuery escapes `\` and `'` itself).
 *
 * The DDL is asserted line by line: every column line ends with `,` BEFORE any comment (the last column too: the emitters
 * write a comma after every column, then the key / the closing parenthesis), so no comment can swallow a separator or the
 * next column. PostgreSQL runs on PGlite, a real engine. Spanner and BigQuery have no local engine: their text is asserted
 * and the argument is in the comments (a `--` comment runs to the end of its line, and we write no line break into it).
 */
import { describe, it, expect } from "vitest";
import type { PrismaEntityInput, PrismaFieldInput } from "@/lib/compiler/compiler.service";
import { emitOfficialTypeSpecTargetFromData } from "@/lib/typespec-official/emitter.service";
import { execDdl, withHint } from "../helpers/sibling-patch";

const TARGETS = [["spanner"], ["postgresql"], ["bigquery"]] as const;
type Target = (typeof TARGETS)[number][0];

/** Characters by code point (this file keeps invisible and control characters out of its source). */
const chars = (...codes: number[]): string => String.fromCharCode(...codes);

function entity(overrides: Partial<PrismaEntityInput> = {}): PrismaEntityInput {
  return { id: "e1", name: "Transaction", description: "", status: "active", version: 1, domainId: "d1", metadata: {}, domain: { id: "d1", name: "payments", slug: "payments" }, ...overrides };
}

function field(name: string, overrides: Partial<PrismaFieldInput> = {}): PrismaFieldInput {
  return { id: `f-${name}`, name, type: "string", precision: null, scale: null, nullable: true, isKey: false, fieldNumber: null, description: "", classification: null, aliases: [], decorators: {}, sortOrder: 1, ...overrides };
}

const KEY = field("transactionId", { isKey: true, nullable: false, sortOrder: 0 });

/** What the patched BigQuery emitter does to a description: backslash and quote escaped for a single-quoted string. */
const bigquerySqlString = (text: string): string => text.replace(/\\/g, "\\\\").replace(/'/g, "\\'");

/** The lines of the (only) table's column list: from the line after `CREATE TABLE ... (` up to the line that closes it. */
function columnLines(output: string): string[] {
  const lines = output.split("\n");
  const start = lines.findIndex((line) => line.startsWith("CREATE TABLE "));
  expect(start, `no CREATE TABLE in\n${output}`).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((line, i) => i > start && (line.startsWith(")") || line.startsWith("  PRIMARY KEY")));
  expect(end, `the column list is not closed in\n${output}`).toBeGreaterThan(start);
  return lines.slice(start + 1, end);
}

/** The comment a column line carries (null when none), asserting the line is `  <name> <type>[ NOT NULL],[ -- <comment>]`. */
function columnComment(target: Target, line: string, name: string): string | null {
  if (target === "bigquery") {
    const match = line.match(new RegExp(`^  ${name} [A-Z0-9_()<>]+(?: NOT NULL)?(?: OPTIONS\\(description='(.*)'\\))?,$`));
    expect(match, withHint(`not a BigQuery column line for ${name}: ${JSON.stringify(line)}`)).not.toBeNull();
    return match?.[1] === undefined ? null : match[1];
  }
  const match = line.match(new RegExp(`^  ${name} [A-Z0-9_()<>\\[\\] ]+?(?: NOT NULL)?,(?: -- (.*))?$`));
  expect(match, withHint(`not a column line for ${name} (the comma must come before any comment): ${JSON.stringify(line)}`)).not.toBeNull();
  return match?.[1] === undefined ? null : match[1];
}

// [what the user typed, what the DDL carries: line breaks one space, ends trimmed; null = no comment at all]
const TEXT_CASES: Array<[label: string, typed: string, carried: string | null]> = [
  ["double dash, semicolon and block-comment end", "a -- b; c */ d /* e", "a -- b; c */ d /* e"],
  ["quotes and backticks", "it's \"quoted\" `tick` 'x'", "it's \"quoted\" `tick` 'x'"],
  ["unicode", "Prix: 12€ — 日本語 😀 café", "Prix: 12€ — 日本語 😀 café"],
  ["a trailing backslash", "ends with a backslash \\", "ends with a backslash \\"],
  ["a backslash before a quote", "C:\\dir\\'s", "C:\\dir\\'s"],
  ["a template opener", "Total in ${currency}", "Total in ${currency}"],
  ["CRLF, CR, LF, LS and PS", "l1\r\nl2\rl3\nl4\u2028l5\u2029l6", "l1 l2 l3 l4 l5 l6"],
  ["leading and trailing line breaks", "\n\r  padded  \u2028", "padded"],
  ["only whitespace", "  \t \r\n ", null],
  // NUL, the other C0 controls (not tab), DEL and the bidirectional controls are taken out; a tab stays
  ["control characters", `a${chars(0)}b${chars(1, 8)}c${chars(0x1f, 0x7f)}d${chars(0x202a, 0x202e, 0x2066, 0x2069)}e\tf`, "abcde\tf"],
  ["only control characters", chars(0, 1, 0x7f, 0x202e, 0x2066), null],
  ["a very long text", `${"long ".repeat(1000)}end`, `${"long ".repeat(1000)}end`],
];

describe.each(TARGETS)("%s: a column description is a comment the DDL keeps whole", (target) => {
  it("keeps every adversarial description on its own column line, comma first, and no line breaks inside the comment", async () => {
    const columns = TEXT_CASES.map(([label, typed], i) => field(`col_${i}`, { sortOrder: i + 1, description: typed }));
    const result = await emitOfficialTypeSpecTargetFromData(entity(), [KEY, ...columns], target);

    expect(result.errors).toEqual([]);
    // the 1,024-character BigQuery limit is a warning of its own (the long case): the DDL is still produced as typed
    expect(result.validationStatus).not.toBe("INVALID");
    const lines = columnLines(result.output);
    expect(lines).toHaveLength(columns.length + 1);
    columnComment(target, lines[0], "transaction_id");
    TEXT_CASES.forEach(([label, , carried], i) => {
      const got = columnComment(target, lines[i + 1], `col_${i}`);
      const expected = carried === null ? null : target === "bigquery" ? bigquerySqlString(carried) : carried;
      expect(got, withHint(`${target}: ${label}`)).toBe(expected);
    });
  }, 60_000);

  it("a comment on the PRIMARY KEY column and on the LAST column leaves the key line and the closing line untouched", async () => {
    const result = await emitOfficialTypeSpecTargetFromData(
      entity(),
      [{ ...KEY, description: "the key; see -- below" }, field("middle", { sortOrder: 1 }), field("last_one", { sortOrder: 2, description: "last */ column" })],
      target,
    );

    expect(result.errors).toEqual([]);
    const lines = result.output.split("\n");
    const start = lines.findIndex((line) => line.startsWith("CREATE TABLE "));
    const table = lines.slice(start);
    if (target === "postgresql") {
      expect(table, withHint("postgresql table text")).toEqual([
        "CREATE TABLE payments.transaction (",
        "  transaction_id TEXT NOT NULL, -- the key; see -- below",
        "  middle TEXT,",
        "  last_one TEXT, -- last */ column",
        "  PRIMARY KEY (transaction_id)",
        ");",
        "",
      ]);
    } else if (target === "spanner") {
      expect(table, withHint("spanner table text")).toEqual([
        "CREATE TABLE transaction (",
        "  transaction_id STRING(MAX) NOT NULL, -- the key; see -- below",
        "  middle STRING(MAX),",
        "  last_one STRING(MAX), -- last */ column",
        ") PRIMARY KEY(transaction_id ASC);",
        "",
      ]);
    } else {
      expect(table, withHint("bigquery table text")).toEqual([
        "CREATE TABLE payments.transaction (",
        "  transaction_id STRING NOT NULL OPTIONS(description='the key; see -- below'),",
        "  middle STRING,",
        "  last_one STRING OPTIONS(description='last */ column'),",
        ")",
        "PRIMARY KEY (transaction_id) NOT ENFORCED;",
        "",
      ]);
    }
  }, 60_000);

  it("a table with no field description has no column comment at all", async () => {
    const result = await emitOfficialTypeSpecTargetFromData(entity(), [KEY, field("name")], target);

    expect(result.errors).toEqual([]);
    for (const line of columnLines(result.output)) {
      expect(line).not.toContain(" -- ");
      expect(line).not.toContain("description=");
    }
  }, 60_000);
});

describe("postgresql: the DDL with every adversarial column comment runs on a real engine (PGlite)", () => {
  it("creates one column per field, and the primary key", async () => {
    const { PGlite } = await import("@electric-sql/pglite");
    const columns = TEXT_CASES.map(([, typed], i) => field(`col_${i}`, { sortOrder: i + 1, description: typed }));
    const result = await emitOfficialTypeSpecTargetFromData(entity({ description: "Table with `--`, ';' and */" }), [{ ...KEY, description: "key; -- */" }, ...columns], "postgresql");
    expect(result.errors).toEqual([]);

    const db = new PGlite();
    try {
      await execDdl(db, result.output);
      const created = await db.query<{ column_name: string }>(
        "select column_name from information_schema.columns where table_schema = 'payments' and table_name = 'transaction' order by ordinal_position",
      );
      expect(created.rows.map((row) => row.column_name)).toEqual(["transaction_id", ...columns.map((_, i) => `col_${i}`)]);
      const key = await db.query<{ column_name: string }>(
        "select kcu.column_name from information_schema.table_constraints tc join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema where tc.constraint_type = 'PRIMARY KEY' and tc.table_schema = 'payments' and tc.table_name = 'transaction'",
      );
      expect(key.rows.map((row) => row.column_name)).toEqual(["transaction_id"]);
    } finally {
      await db.close();
    }
  }, 60_000);
});

describe("bigquery: a column description is escaped by the emitter, once", () => {
  it.each([
    ["C:\\dir\\", "description='C:\\\\dir\\\\'"],
    ['say "hi" and it\'s', "description='say \"hi\" and it\\'s'"],
    ["it's", "description='it\\'s'"],
    ["a -- b", "description='a -- b'"],
  ])("%j is written as %s", async (typed, literal) => {
    const result = await emitOfficialTypeSpecTargetFromData(entity(), [{ ...KEY, description: typed }], "bigquery");

    expect(result.errors).toEqual([]);
    expect(result.output, "needs @typespec/bigquery built with the write.ts escaping fix (docs/events/REVIEW.md, gap 15)").toContain(literal);
  }, 60_000);
});
