import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { applyPgliteMigrations } from "@/lib/pglite-migrate";

describe("entity versioning migrations on PGlite", () => {
  it("apply from scratch, enforce immutability and cascade versions with their entity", async () => {
    const db = new PGlite();
    try {
      const applied = await applyPgliteMigrations(db);
      expect(applied).toContain("20261015_entity_versioning");
      expect(applied).toContain("20261015_entity_versioning_backfill");

      const cols = await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'entities' AND column_name IN ('latestVersionId', 'hasUnpublishedChanges')`
      );
      expect(cols.rows.map((r) => r.column_name).sort()).toEqual(["hasUnpublishedChanges", "latestVersionId"]);
      const refs = await db.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'schema_references'`);
      expect(refs.rows).toHaveLength(1);

      await db.exec(`INSERT INTO "users" ("id", "email", "updatedAt") VALUES ('u1', 'u1@example.test', CURRENT_TIMESTAMP)`);
      await db.exec(
        `INSERT INTO "entities" ("id", "name", "slug", "tenantId", "ownerId", "updatedAt")
         VALUES ('e1', 'E', 'e', 'tenant_default', 'u1', CURRENT_TIMESTAMP)`
      );
      await db.exec(
        `INSERT INTO "entity_versions" ("id", "entityId", "major", "minor", "sequence", "resolvedSource", "fieldSnapshot", "changeKind", "publishedById")
         VALUES ('v1', 'e1', 1, 0, 1, 'model E {}', '[]', 'INITIAL', 'u1')`
      );
      await db.exec(`UPDATE "entities" SET "latestVersionId" = 'v1', "hasUnpublishedChanges" = false WHERE "id" = 'e1'`);

      await expect(db.exec(`UPDATE "entity_versions" SET "minor" = 1 WHERE "id" = 'v1'`)).rejects.toThrow(/immutable/);

      await db.exec(`DELETE FROM "entities" WHERE "id" = 'e1'`);
      const left = await db.query(`SELECT 1 FROM "entity_versions" WHERE "id" = 'v1'`);
      expect(left.rows).toHaveLength(0);
    } finally {
      await db.close();
    }
  }, 60_000);
});
