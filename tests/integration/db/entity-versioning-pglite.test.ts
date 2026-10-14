import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { applyPgliteMigrations } from "@/lib/pglite-migrate";
import {
  MARK_DRAFT_CHANGED_SQL,
  CLEAR_SOURCE_STALE_SQL,
  WRITE_BACK_SOURCE_SQL,
} from "@/lib/entity-versioning/draft-state";

let db: PGlite;
let applied: string[];

beforeAll(async () => {
  db = new PGlite();
  applied = await applyPgliteMigrations(db);
  await db.exec(`INSERT INTO "users" ("id", "email", "updatedAt") VALUES ('u1', 'u1@example.test', CURRENT_TIMESTAMP)`);
}, 60_000);
afterAll(async () => db.close());

async function metadataOf(id: string): Promise<unknown> {
  const res = await db.query<{ metadata: unknown }>(`SELECT "metadata" FROM "entities" WHERE "id" = $1`, [id]);
  return res.rows[0].metadata;
}

describe("entity versioning migrations on PGlite", () => {
  it("apply from scratch, enforce immutability and cascade versions with their entity", async () => {
    expect(applied).toContain("20261015_entity_versioning");
    expect(applied).toContain("20261015_entity_versioning_backfill");

    const cols = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'entities' AND column_name IN ('latestVersionId', 'hasUnpublishedChanges')`
    );
    expect(cols.rows.map((r) => r.column_name).sort()).toEqual(["hasUnpublishedChanges", "latestVersionId"]);
    const refs = await db.query(`SELECT 1 FROM information_schema.tables WHERE table_name = 'schema_references'`);
    expect(refs.rows).toHaveLength(1);

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
  });

  it("refuses a direct DELETE of a version but still cascades with its entity", async () => {
    expect(applied).toContain("20261015_entity_versions_no_delete");

    await db.exec(
      `INSERT INTO "entities" ("id", "name", "slug", "tenantId", "ownerId", "updatedAt")
       VALUES ('e3', 'E3', 'e3', 'tenant_default', 'u1', CURRENT_TIMESTAMP)`
    );
    await db.exec(
      `INSERT INTO "entity_versions" ("id", "entityId", "major", "minor", "sequence", "resolvedSource", "fieldSnapshot", "changeKind", "publishedById")
       VALUES ('v3', 'e3', 1, 0, 1, 'model E3 {}', '[]', 'INITIAL', 'u1')`
    );
    await db.exec(`UPDATE "entities" SET "latestVersionId" = 'v3', "hasUnpublishedChanges" = false WHERE "id" = 'e3'`);

    await expect(db.exec(`DELETE FROM "entity_versions" WHERE "id" = 'v3'`)).rejects.toThrow(/cannot be deleted/);
    expect((await db.query(`SELECT 1 FROM "entity_versions" WHERE "id" = 'v3'`)).rows).toHaveLength(1);

    await db.exec(`DELETE FROM "entities" WHERE "id" = 'e3'`);
    expect((await db.query(`SELECT 1 FROM "entity_versions" WHERE "id" = 'v3'`)).rows).toHaveLength(0);
  });

  it("runs the stale-source statements (R42) with the same SQL text as PostgreSQL", async () => {
    await db.exec(
      `INSERT INTO "entities" ("id", "name", "slug", "tenantId", "ownerId", "updatedAt", "hasUnpublishedChanges")
       VALUES ('e2', 'E2', 'e2', 'tenant_default', 'u1', CURRENT_TIMESTAMP, false)`
    );

    // NULL metadata -> { sourceStale: true }, draft flag set.
    await db.query(MARK_DRAFT_CHANGED_SQL, ["e2"]);
    expect(await metadataOf("e2")).toEqual({ sourceStale: true });
    const flag = await db.query<{ hasUnpublishedChanges: boolean }>(
      `SELECT "hasUnpublishedChanges" FROM "entities" WHERE "id" = 'e2'`
    );
    expect(flag.rows[0].hasUnpublishedChanges).toBe(true);

    // Other metadata keys survive the mark and the clear.
    await db.exec(`UPDATE "entities" SET "metadata" = '{"tags":["a"],"schemaVersions":{"avro":[]}}'::jsonb WHERE "id" = 'e2'`);
    await db.query(MARK_DRAFT_CHANGED_SQL, ["e2"]);
    expect(await metadataOf("e2")).toEqual({ tags: ["a"], schemaVersions: { avro: [] }, sourceStale: true });
    await db.query(CLEAR_SOURCE_STALE_SQL, ["e2"]);
    expect(await metadataOf("e2")).toEqual({ tags: ["a"], schemaVersions: { avro: [] } });

    // Write-back stores the source and drops sourceStale and the 12.7 flag.
    await db.exec(
      `UPDATE "entities" SET "metadata" = '{"tags":["a"],"sourceStale":true,"typespecMigration":{"status":"FLAGGED"}}'::jsonb WHERE "id" = 'e2'`
    );
    await db.query(WRITE_BACK_SOURCE_SQL, ["e2", "model E2 {}"]);
    expect(await metadataOf("e2")).toEqual({ tags: ["a"] });
    const src = await db.query<{ typespecSource: string }>(`SELECT "typespecSource" FROM "entities" WHERE "id" = 'e2'`);
    expect(src.rows[0].typespecSource).toBe("model E2 {}");

    // A JSON-null / NULL metadata clear is a no-op.
    await db.exec(`UPDATE "entities" SET "metadata" = NULL WHERE "id" = 'e2'`);
    await db.query(CLEAR_SOURCE_STALE_SQL, ["e2"]);
    expect(await metadataOf("e2")).toBeNull();
  });
});
