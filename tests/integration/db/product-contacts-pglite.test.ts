import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { applyPgliteMigrations } from "@/lib/pglite-migrate";

const NOW = "CURRENT_TIMESTAMP";
const MIGRATION = "20261019_product_contacts";
const MIGRATION_SQL = () => readFileSync(`prisma/migrations/${MIGRATION}/migration.sql`, "utf8");

async function seedDomain(db: PGlite) {
  await db.exec(`INSERT INTO "domains" ("id","tenantId","name","slug","updatedAt") VALUES ('d1','tenant_default','D','d',${NOW})`);
}

async function insertProduct(db: PGlite, id: string) {
  await db.exec(`INSERT INTO "products" ("id","domainId","name","slug","updatedAt") VALUES ('${id}','d1','P ${id}','p-${id}',${NOW})`);
}

interface ContactRow {
  engineeringLead: string | null;
  manager: string | null;
  teamEmails: string[] | null;
}

async function contacts(db: PGlite, id: string): Promise<ContactRow> {
  const result = await db.query<ContactRow>(`SELECT "engineeringLead","manager","teamEmails" FROM "products" WHERE "id" = $1`, [id]);
  return result.rows[0];
}

describe("product contacts migration on PGlite", () => {
  it("applies after the event document v2 migrations", async () => {
    const db = new PGlite();
    try {
      const applied = await applyPgliteMigrations(db);
      const columns = applied.indexOf("20261018_event_document_v2_columns");
      expect(columns).toBeGreaterThanOrEqual(0);
      expect(applied.indexOf(MIGRATION)).toBeGreaterThan(columns);
    } finally {
      await db.close();
    }
  }, 60_000);

  it("adds engineeringLead and manager as nullable text and teamEmails as a text array", async () => {
    const db = new PGlite();
    try {
      await applyPgliteMigrations(db);
      const cols = await db.query<{ column_name: string; data_type: string; udt_name: string; is_nullable: string }>(
        `select column_name, data_type, udt_name, is_nullable from information_schema.columns
         where table_name = 'products' and column_name in ('engineeringLead','manager','teamEmails') order by column_name`
      );
      expect(cols.rows).toEqual([
        { column_name: "engineeringLead", data_type: "text", udt_name: "text", is_nullable: "YES" },
        { column_name: "manager", data_type: "text", udt_name: "text", is_nullable: "YES" },
        { column_name: "teamEmails", data_type: "ARRAY", udt_name: "_text", is_nullable: "YES" },
      ]);
    } finally {
      await db.close();
    }
  }, 60_000);

  it("defaults teamEmails to the empty array (`{}`) and the two mailboxes to NULL for a product written without contacts", async () => {
    const db = new PGlite();
    try {
      await applyPgliteMigrations(db);
      await seedDomain(db);
      await insertProduct(db, "p1");

      expect(await contacts(db, "p1")).toEqual({ engineeringLead: null, manager: null, teamEmails: [] });
      const text = await db.query<{ raw: string }>(`SELECT "teamEmails"::text AS raw FROM "products" WHERE "id" = 'p1'`);
      expect(text.rows[0].raw).toBe("{}");
    } finally {
      await db.close();
    }
  }, 60_000);

  it("backfills products that existed before the migration with an empty teamEmails and no mailboxes", async () => {
    const db = new PGlite();
    try {
      await applyPgliteMigrations(db);
      await seedDomain(db);
      await insertProduct(db, "old");
      // Put the table back in its pre-migration shape, then re-run the migration over the existing row.
      await db.exec(`ALTER TABLE "products" DROP COLUMN "engineeringLead", DROP COLUMN "manager", DROP COLUMN "teamEmails"`);
      await db.exec(MIGRATION_SQL());

      expect(await contacts(db, "old")).toEqual({ engineeringLead: null, manager: null, teamEmails: [] });
    } finally {
      await db.close();
    }
  }, 60_000);

  it("stores and returns canonical mailbox text exactly, including a quoted name with a comma", async () => {
    const db = new PGlite();
    try {
      await applyPgliteMigrations(db);
      await seedDomain(db);
      await insertProduct(db, "p1");
      const team = ['"Doe, Jane" <j@x.com>', "Platform Team <platform@acme.com>", "oncall@acme.com"];

      await db.query(`UPDATE "products" SET "engineeringLead" = $1, "manager" = $2, "teamEmails" = $3::text[] WHERE "id" = 'p1'`, [
        '"Doe, Jane" <j@x.com>',
        "Mo Manager <mo@acme.com>",
        team,
      ]);

      expect(await contacts(db, "p1")).toEqual({
        engineeringLead: '"Doe, Jane" <j@x.com>',
        manager: "Mo Manager <mo@acme.com>",
        teamEmails: team,
      });
    } finally {
      await db.close();
    }
  }, 60_000);

  it("is safe to re-run (idempotent partial-apply recovery) and keeps the values already stored", async () => {
    const db = new PGlite();
    try {
      await applyPgliteMigrations(db);
      await seedDomain(db);
      await insertProduct(db, "p1");
      await db.query(`UPDATE "products" SET "engineeringLead" = 'Jane <jane@acme.com>', "teamEmails" = ARRAY['a@acme.com']::text[] WHERE "id" = 'p1'`);

      await db.exec(MIGRATION_SQL());
      await db.exec(MIGRATION_SQL());

      expect(await contacts(db, "p1")).toEqual({
        engineeringLead: "Jane <jane@acme.com>",
        manager: null,
        teamEmails: ["a@acme.com"],
      });
    } finally {
      await db.close();
    }
  }, 60_000);

  it("only touches the products table (additive: no drops, no rewrites of other tables)", () => {
    const sql = MIGRATION_SQL();
    const statements = sql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements).toHaveLength(3);
    for (const statement of statements) {
      expect(statement).toMatch(/^ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "(engineeringLead|manager|teamEmails)" /);
    }
    expect(sql).not.toMatch(/\bDROP\b|\bDELETE\b|\bTRUNCATE\b/i);
  });
});
