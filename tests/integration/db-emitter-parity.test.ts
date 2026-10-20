import { describe, it, expect } from "vitest";
import type {
  PrismaEntityInput,
  PrismaFieldInput,
} from "@/lib/compiler/compiler.service";
import { emitOfficialTypeSpecTargetFromData } from "@/lib/typespec-official/emitter.service";

// Regression coverage for the migrated database DDL emitters. The custom
// Super Schema emitters (src/emitters/{spanner,postgresql,bigquery}) were
// replaced by standalone TypeSpec packages (@typespec/{spanner,postgres,
// bigquery}); this test drives the real `tsp compile` shell-out end to end.

const entity: PrismaEntityInput = {
  id: "e1",
  name: "Transaction",
  description: "A payment transaction",
  status: "active",
  version: 1,
  domainId: "d1",
  metadata: {},
  domain: { id: "d1", name: "payments", slug: "payments" },
};

const fields: PrismaFieldInput[] = [
  { id: "f1", name: "transactionId", type: "string", precision: null, scale: null, nullable: false, isKey: true, fieldNumber: null, description: "PK", classification: null, aliases: [], decorators: {}, sortOrder: 0 },
  { id: "f2", name: "amount", type: "decimal", precision: 19, scale: 4, nullable: false, isKey: false, fieldNumber: null, description: "amount", classification: null, aliases: [], decorators: {}, sortOrder: 1 },
  { id: "f3", name: "currencyCode", type: "string", precision: null, scale: null, nullable: false, isKey: false, fieldNumber: null, description: "ISO 4217", classification: null, aliases: [], decorators: { typespec: { validation: { maxLength: 3 } } }, sortOrder: 2 },
  { id: "f4", name: "riskScore", type: "decimal", precision: 5, scale: 4, nullable: true, isKey: false, fieldNumber: null, description: "risk", classification: null, aliases: [], decorators: {}, sortOrder: 3 },
  { id: "f5", name: "createdAt", type: "utcDateTime", precision: null, scale: null, nullable: false, isKey: false, fieldNumber: null, description: "created", classification: null, aliases: [], decorators: {}, sortOrder: 4 },
  { id: "f6", name: "isFlagged", type: "boolean", precision: null, scale: null, nullable: true, isKey: false, fieldNumber: null, description: "flag", classification: null, aliases: [], decorators: {}, sortOrder: 5 },
];

const EXPECTED_COLUMNS = [
  "transaction_id",
  "amount",
  "currency_code",
  "risk_score",
  "created_at",
  "is_flagged",
];

describe.each([["spanner"], ["postgresql"], ["bigquery"]])(
  "DB TypeSpec emitter: %s",
  (targetKey) => {
    it("compiles to valid DDL with all columns", async () => {
      const result = await emitOfficialTypeSpecTargetFromData(entity, fields, targetKey);

      expect(
        result.validationStatus,
        `emit failed: ${JSON.stringify(result.errors)}`
      ).toBe("VALID");

      const ddl = result.output.toLowerCase();
      for (const col of EXPECTED_COLUMNS) {
        expect(ddl, `${targetKey} DDL missing column ${col}`).toContain(col);
      }
    }, 60000);

    it("never lets a `--` comment swallow a column's separator (every field here has a description)", async () => {
      const result = await emitOfficialTypeSpecTargetFromData(entity, fields, targetKey);
      expect(result.validationStatus, JSON.stringify(result.errors)).toBe("VALID");

      // The Spanner and PostgreSQL emitters write `<column> -- <doc>,`: the comma is part of the comment and the
      // statement is no longer valid. The source builder gives those two no column docs; a comment on its own line is fine.
      const swallowed = result.output.split("\n").filter((line) => !line.trimStart().startsWith("--") && line.includes(" -- "));
      expect(swallowed, `${targetKey} DDL has a trailing comment on a column line`).toEqual([]);
    }, 60000);
  }
);

it("postgresql DDL is accepted by a real PostgreSQL engine (PGlite) and creates every column", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const result = await emitOfficialTypeSpecTargetFromData(entity, fields, "postgresql");
  expect(result.validationStatus, JSON.stringify(result.errors)).toBe("VALID");

  const db = new PGlite();
  try {
    await db.exec(result.output);
    const columns = await db.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_schema = 'payments' and table_name = 'transaction' order by ordinal_position"
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual(EXPECTED_COLUMNS);
  } finally {
    await db.close();
  }
}, 60000);

it("spanner emits ROW DELETION POLICY for age-based retention", async () => {
  const withRetention: PrismaEntityInput = {
    ...entity,
    metadata: {
      retentionPolicy: {
        strategy: "age-based",
        period: 90,
        periodUnit: "days",
        referenceField: "createdAt",
        action: "delete",
      },
    },
  };
  const result = await emitOfficialTypeSpecTargetFromData(withRetention, fields, "spanner");
  expect(result.validationStatus, JSON.stringify(result.errors)).toBe("VALID");
  expect(result.output.toUpperCase()).toContain("ROW DELETION POLICY");
}, 60000);
