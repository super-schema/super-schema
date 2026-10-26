import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { applyPgliteMigrations } from "@/lib/pglite-migrate";

const NOW = "CURRENT_TIMESTAMP";
const MIGRATION = "20261026000000_webhook_endpoint_creator_optional";
const endpoint = (id: string, createdBy: string | null) =>
  `INSERT INTO "webhook_endpoints" ("id","url","events","secret","createdBy","updatedAt") VALUES ('${id}','https://example.invalid/h',ARRAY['emission.completed'],'s',${createdBy === null ? "NULL" : `'${createdBy}'`},${NOW})`;

describe("webhook endpoint creator optional (KD-024) on PGlite", () => {
  it("applies, and an endpoint may have no creator (the REST API key is no user row)", async () => {
    const db = new PGlite();
    try {
      const applied = await applyPgliteMigrations(db);
      expect(applied).toContain(MIGRATION);
      const column = await db.query<{ is_nullable: string }>(`select is_nullable from information_schema.columns where table_name = 'webhook_endpoints' and column_name = 'createdBy'`);
      expect(column.rows).toEqual([{ is_nullable: "YES" }]);
      await db.exec(endpoint("w-none", null));
      expect((await db.query(`SELECT "createdBy" FROM "webhook_endpoints" WHERE id = 'w-none'`)).rows).toEqual([{ createdBy: null }]);
    } finally {
      await db.close();
    }
  }, 60_000);

  it("a creator, when there is one, is still a real user, and that user cannot be deleted while an endpoint names them", async () => {
    const db = new PGlite();
    try {
      await applyPgliteMigrations(db);
      await db.exec(`INSERT INTO "users" ("id","email","updatedAt") VALUES ('u1','u1@example.test',${NOW})`);
      await db.exec(endpoint("w-user", "u1"));
      await expect(db.exec(endpoint("w-ghost", "nobody"))).rejects.toThrow(/foreign key|violates/i);
      await expect(db.exec(`DELETE FROM "users" WHERE id = 'u1'`)).rejects.toThrow(/foreign key|violates/i);
    } finally {
      await db.close();
    }
  }, 60_000);
});
