import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { applyPgliteMigrations } from "@/lib/pglite-migrate";

const MIGRATION = "20261030000000_ai_config";

describe("ai_config (Admin > AI settings) on PGlite", () => {
  it("applies, and holds one platform row whose fields may all be empty (the environment then decides)", async () => {
    const db = new PGlite();
    try {
      const applied = await applyPgliteMigrations(db);
      expect(applied).toContain(MIGRATION);

      const columns = await db.query<{ column_name: string }>(`select column_name from information_schema.columns where table_name = 'ai_config' order by column_name`);
      expect(columns.rows.map((c) => c.column_name)).toEqual(["baseUrl", "id", "model", "provider", "updatedAt", "updatedBy"]);

      await db.exec(`INSERT INTO "ai_config" ("id","updatedAt") VALUES ('default', CURRENT_TIMESTAMP)`);
      expect((await db.query(`SELECT "provider", "baseUrl", "model", "updatedBy" FROM "ai_config" WHERE "id" = 'default'`)).rows).toEqual([
        { provider: null, baseUrl: null, model: null, updatedBy: null },
      ]);
    } finally {
      await db.close();
    }
  }, 60_000);

  it("has no second row for the override: the id is the key", async () => {
    const db = new PGlite();
    try {
      await applyPgliteMigrations(db);
      await db.exec(`INSERT INTO "ai_config" ("id","updatedAt") VALUES ('default', CURRENT_TIMESTAMP)`);
      await expect(db.exec(`INSERT INTO "ai_config" ("id","updatedAt") VALUES ('default', CURRENT_TIMESTAMP)`)).rejects.toThrow(/duplicate key|unique/i);
    } finally {
      await db.close();
    }
  }, 60_000);
});
