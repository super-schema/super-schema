import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
      `INSERT INTO "entity_versions" ("id", "entityId", "major", "minor", "sequence", "resolvedSource", "fieldSnapshot", "changeKind", "publishedById", "releasedAt")
       VALUES ('v1', 'e1', 1, 0, 1, 'model E {}', '[]', 'INITIAL', 'u1', CURRENT_TIMESTAMP)`
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
      `INSERT INTO "entity_versions" ("id", "entityId", "major", "minor", "sequence", "resolvedSource", "fieldSnapshot", "changeKind", "publishedById", "releasedAt")
       VALUES ('v3', 'e3', 1, 0, 1, 'model E3 {}', '[]', 'INITIAL', 'u1', CURRENT_TIMESTAMP)`
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

const SNAPSHOT_MIGRATION = "20261102000000_snapshot_versioning";

/** The backfill block shipped in the snapshot migration (between its BEGIN/END backfill markers), re-run here against legacy-shaped rows. */
function snapshotBackfillSql(): string {
  const sql = readFileSync(join(process.cwd(), "prisma/migrations", SNAPSHOT_MIGRATION, "migration.sql"), "utf8");
  const block = /-- BEGIN backfill\n([\s\S]*?)-- END backfill/.exec(sql);
  if (!block) throw new Error("backfill markers not found in the snapshot migration");
  return block[1];
}

describe("snapshot versioning migration on PGlite", () => {
  let seq = 0;
  const NOW = "CURRENT_TIMESTAMP";

  beforeAll(async () => {
    await db.exec(`INSERT INTO "domains" ("id","tenantId","name","slug","updatedAt") VALUES ('sd1','tenant_default','SD','sd',${NOW})`);
    await db.exec(`INSERT INTO "products" ("id","domainId","name","slug","updatedAt") VALUES ('sp1','sd1','SP','sp',${NOW})`);
  });

  async function newEntity(): Promise<string> {
    const id = `se${++seq}`;
    await db.exec(
      `INSERT INTO "entities" ("id","name","slug","tenantId","ownerId","updatedAt") VALUES ('${id}','${id}','${id}','tenant_default','u1',${NOW})`
    );
    return id;
  }

  async function newEventSpec(): Promise<string> {
    const id = `ss${++seq}`;
    await db.exec(
      `INSERT INTO "event_specs" ("id","name","document","tenantId","domainId","productId","updatedAt")
       VALUES ('${id}','${id}','{}','tenant_default','sd1','sp1',${NOW})`
    );
    return id;
  }

  type Row = { id: string; major?: number; minor?: number; patch?: number; sequence?: number; stage?: "SNAPSHOT" | "RELEASED"; changeKind?: string };

  /** RELEASED rows carry releasedAt (CHECK); SNAPSHOT rows do not. */
  function insertEntityVersion(entityId: string, r: Row) {
    const stage = r.stage ?? "RELEASED";
    return db.exec(
      `INSERT INTO "entity_versions" ("id","entityId","major","minor","patch","sequence","stage","releasedAt","releasedById","resolvedSource","fieldSnapshot","changeKind","publishedById")
       VALUES ('${r.id}','${entityId}',${r.major ?? 1},${r.minor ?? 0},${r.patch ?? 0},${r.sequence ?? 1},'${stage}',
               ${stage === "RELEASED" ? NOW : "NULL"},${stage === "RELEASED" ? "'u1'" : "NULL"},'model X {}','[]','${r.changeKind ?? "INITIAL"}','u1')`
    );
  }

  function insertEventSpecVersion(eventSpecId: string, r: Row) {
    const stage = r.stage ?? "RELEASED";
    return db.exec(
      `INSERT INTO "event_spec_versions" ("id","eventSpecId","major","minor","patch","sequence","stage","releasedAt","releasedById","document","sourceDocument","frozenTraits","changeKind","publishedById")
       VALUES ('${r.id}','${eventSpecId}',${r.major ?? 1},${r.minor ?? 0},${r.patch ?? 0},${r.sequence ?? 1},'${stage}',
               ${stage === "RELEASED" ? NOW : "NULL"},${stage === "RELEASED" ? "'u1'" : "NULL"},'{}','{}','[]','${r.changeKind ?? "INITIAL"}','u1')`
    );
  }

  it("is applied", () => {
    expect(applied).toContain(SNAPSHOT_MIGRATION);
  });

  it("updates a SNAPSHOT row, including promoting it to RELEASED", async () => {
    const e = await newEntity();
    await insertEntityVersion(e, { id: `${e}-v1`, stage: "SNAPSHOT" });
    await db.exec(`UPDATE "entity_versions" SET "fieldSnapshot" = '[{"name":"id"}]' WHERE "id" = '${e}-v1'`);
    const row = await db.query<{ fieldSnapshot: unknown }>(`SELECT "fieldSnapshot" FROM "entity_versions" WHERE "id" = '${e}-v1'`);
    expect(row.rows[0].fieldSnapshot).toEqual([{ name: "id" }]);

    // Promotion is the last allowed UPDATE: afterwards the row is released and immutable.
    await db.exec(`UPDATE "entity_versions" SET "stage" = 'RELEASED', "releasedAt" = ${NOW}, "releasedById" = 'u1' WHERE "id" = '${e}-v1'`);
    await expect(db.exec(`UPDATE "entity_versions" SET "changeSummary" = 'x' WHERE "id" = '${e}-v1'`)).rejects.toThrow(
      /Released versions are immutable/
    );

    const s = await newEventSpec();
    await insertEventSpecVersion(s, { id: `${s}-v1`, stage: "SNAPSHOT" });
    await db.exec(`UPDATE "event_spec_versions" SET "document" = '{"a":1}' WHERE "id" = '${s}-v1'`);
    const doc = await db.query<{ document: unknown }>(`SELECT "document" FROM "event_spec_versions" WHERE "id" = '${s}-v1'`);
    expect(doc.rows[0].document).toEqual({ a: 1 });
  });

  it("rejects updating a RELEASED row", async () => {
    const e = await newEntity();
    await insertEntityVersion(e, { id: `${e}-v1` });
    await expect(db.exec(`UPDATE "entity_versions" SET "fieldSnapshot" = '[]' WHERE "id" = '${e}-v1'`)).rejects.toThrow(
      /Released versions are immutable; save a new snapshot instead/
    );
    // A released row cannot be turned back into a snapshot either.
    await expect(db.exec(`UPDATE "entity_versions" SET "stage" = 'SNAPSHOT' WHERE "id" = '${e}-v1'`)).rejects.toThrow(
      /Released versions are immutable/
    );

    const s = await newEventSpec();
    await insertEventSpecVersion(s, { id: `${s}-v1` });
    await expect(db.exec(`UPDATE "event_spec_versions" SET "document" = '{}' WHERE "id" = '${s}-v1'`)).rejects.toThrow(
      /Released versions are immutable; save a new snapshot instead/
    );
  });

  it("allows exactly one SNAPSHOT per entity and per event spec", async () => {
    const e = await newEntity();
    await insertEntityVersion(e, { id: `${e}-v1`, stage: "SNAPSHOT", sequence: 1 });
    await expect(insertEntityVersion(e, { id: `${e}-v2`, stage: "SNAPSHOT", minor: 1, sequence: 2 })).rejects.toThrow(
      /entity_versions_one_snapshot/
    );
    // Another entity may hold its own snapshot, and released rows do not count.
    const other = await newEntity();
    await insertEntityVersion(other, { id: `${other}-v1`, stage: "SNAPSHOT" });
    await insertEntityVersion(e, { id: `${e}-r1`, major: 2, sequence: 3, changeKind: "MAJOR" });

    const s = await newEventSpec();
    await insertEventSpecVersion(s, { id: `${s}-v1`, stage: "SNAPSHOT", sequence: 1 });
    await expect(insertEventSpecVersion(s, { id: `${s}-v2`, stage: "SNAPSHOT", minor: 1, sequence: 2 })).rejects.toThrow(
      /event_spec_versions_one_snapshot/
    );
  });

  it("defaults new rows to RELEASED x.y.0 and requires releasedAt on RELEASED rows", async () => {
    const e = await newEntity();
    await db.exec(
      `INSERT INTO "entity_versions" ("id","entityId","major","minor","sequence","releasedAt","resolvedSource","fieldSnapshot","changeKind","publishedById")
       VALUES ('${e}-v1','${e}',1,0,1,${NOW},'model X {}','[]','INITIAL','u1')`
    );
    const row = await db.query<{ patch: number; stage: string; updatedAt: Date | null }>(
      `SELECT "patch", "stage", "updatedAt" FROM "entity_versions" WHERE "id" = '${e}-v1'`
    );
    expect(row.rows[0]).toMatchObject({ patch: 0, stage: "RELEASED" });
    expect(row.rows[0].updatedAt).not.toBeNull();

    await expect(
      db.exec(
        `INSERT INTO "entity_versions" ("id","entityId","major","minor","sequence","resolvedSource","fieldSnapshot","changeKind","publishedById")
         VALUES ('${e}-v2','${e}',1,1,2,'model X {}','[]','MINOR','u1')`
      )
    ).rejects.toThrow(/entity_versions_released_check/);

    const s = await newEventSpec();
    await expect(
      db.exec(
        `INSERT INTO "event_spec_versions" ("id","eventSpecId","major","minor","sequence","document","sourceDocument","frozenTraits","changeKind","publishedById")
         VALUES ('${s}-v1','${s}',1,0,1,'{}','{}','[]','INITIAL','u1')`
      )
    ).rejects.toThrow(/event_spec_versions_released_check/);
  });

  it("stores PATCH change kinds and refuses a negative patch", async () => {
    const e = await newEntity();
    await insertEntityVersion(e, { id: `${e}-v1`, sequence: 1 });
    await insertEntityVersion(e, { id: `${e}-v2`, patch: 1, sequence: 2, changeKind: "PATCH" });
    await expect(insertEntityVersion(e, { id: `${e}-v3`, patch: -1, sequence: 3, changeKind: "PATCH" })).rejects.toThrow(
      /entity_versions_numbers_check/
    );
    const s = await newEventSpec();
    await expect(insertEventSpecVersion(s, { id: `${s}-v1`, patch: -1 })).rejects.toThrow(/event_spec_versions_numbers_check/);
  });

  it("backfills legacy rows as RELEASED x.y.0", async () => {
    // Every migration is already applied, so recreate the pre-migration shape: a row with no releasedAt / releasedById
    // (the CHECK is dropped for the duration), then run the migration's own backfill block. Rolled back afterwards.
    const e = await newEntity();
    const s = await newEventSpec();
    await db.transaction(async (tx) => {
      await tx.exec(`ALTER TABLE "entity_versions" DROP CONSTRAINT "entity_versions_released_check"`);
      await tx.exec(`ALTER TABLE "event_spec_versions" DROP CONSTRAINT "event_spec_versions_released_check"`);
      await tx.exec(
        `INSERT INTO "entity_versions" ("id","entityId","major","minor","sequence","resolvedSource","fieldSnapshot","changeKind","publishedById","publishedAt")
         VALUES ('${e}-legacy','${e}',2,3,1,'model X {}','[]','MINOR','u1','2025-01-02T03:04:05.678Z')`
      );
      await tx.exec(
        `INSERT INTO "event_spec_versions" ("id","eventSpecId","major","minor","sequence","document","sourceDocument","frozenTraits","changeKind","publishedById","publishedAt")
         VALUES ('${s}-legacy','${s}',4,1,1,'{}','{}','[]','MINOR','u1','2025-02-03T04:05:06.789Z')`
      );

      await tx.exec(snapshotBackfillSql());
      await tx.exec(snapshotBackfillSql()); // idempotent

      const ev = await tx.query<Record<string, unknown>>(
        `SELECT "major","minor","patch","stage","releasedAt","releasedById","publishedAt","updatedAt" FROM "entity_versions" WHERE "id" = '${e}-legacy'`
      );
      expect(ev.rows[0]).toMatchObject({ major: 2, minor: 3, patch: 0, stage: "RELEASED", releasedById: "u1" });
      expect(ev.rows[0].releasedAt).toEqual(ev.rows[0].publishedAt);
      expect(ev.rows[0].updatedAt).toEqual(ev.rows[0].publishedAt);

      const sv = await tx.query<Record<string, unknown>>(
        `SELECT "major","minor","patch","stage","releasedAt","releasedById","publishedAt" FROM "event_spec_versions" WHERE "id" = '${s}-legacy'`
      );
      expect(sv.rows[0]).toMatchObject({ major: 4, minor: 1, patch: 0, stage: "RELEASED", releasedById: "u1" });
      expect(sv.rows[0].releasedAt).toEqual(sv.rows[0].publishedAt);

      // The backfill re-enables immutability: the backfilled rows are frozen again.
      await expect(tx.exec(`UPDATE "entity_versions" SET "changeSummary" = 'x' WHERE "id" = '${e}-legacy'`)).rejects.toThrow(
        /Released versions are immutable/
      );
      await tx.rollback();
    });
  });

  it("rejects reusing a released number", async () => {
    const e = await newEntity();
    await insertEntityVersion(e, { id: `${e}-v1`, sequence: 1 });
    await expect(insertEntityVersion(e, { id: `${e}-v2`, stage: "SNAPSHOT", sequence: 2 })).rejects.toThrow(
      /entity_versions_entityId_major_minor_patch_key/
    );
    // Same major.minor with another patch is a different version.
    await insertEntityVersion(e, { id: `${e}-v3`, patch: 1, sequence: 3, changeKind: "PATCH" });

    const s = await newEventSpec();
    await insertEventSpecVersion(s, { id: `${s}-v1`, sequence: 1 });
    await expect(insertEventSpecVersion(s, { id: `${s}-v2`, stage: "SNAPSHOT", sequence: 2 })).rejects.toThrow(
      /event_spec_versions_eventSpecId_major_minor_patch_key/
    );
  });
});
