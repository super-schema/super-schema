import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { applyPgliteMigrations } from "@/lib/pglite-migrate";
import { FLAGGED_WRITE_SQL, MIGRATED_WRITE_SQL } from "@/lib/entity-versioning/draft-state";

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await applyPgliteMigrations(db);
  await db.exec(`INSERT INTO "users" ("id", "email", "updatedAt") VALUES ('u1', 'u1@example.test', CURRENT_TIMESTAMP)`);
}, 60_000);
afterAll(async () => db.close());

async function entity(id: string, metadata: string | null) {
  await db.query(
    `INSERT INTO "entities" ("id", "name", "slug", "tenantId", "ownerId", "metadata", "updatedAt")
     VALUES ($1, $1, $1, 'tenant_default', 'u1', $2::jsonb, CURRENT_TIMESTAMP)`,
    [id, metadata],
  );
}

async function row(id: string) {
  const res = await db.query<{ metadata: unknown; typespecSource: string | null }>(
    `SELECT "metadata", "typespecSource" FROM "entities" WHERE "id" = $1`,
    [id],
  );
  return res.rows[0];
}

const flagged = (diagnostics: unknown[] = []) => JSON.stringify({ status: "FLAGGED", at: "2026-11-01T00:00:00.000Z", diagnostics });

describe("typespec source migration statements", () => {
  it("FLAGGED sets typespecMigration and keeps every other metadata key the row holds", async () => {
    await entity("mg1", JSON.stringify({ tags: ["t"], schemaVersions: { avro: [{ label: "1.0" }] }, extends: "Base" }));
    const res = await db.query(FLAGGED_WRITE_SQL, ["mg1", flagged([{ code: "x" }])]);
    expect(res.affectedRows).toBe(1);
    const after = await row("mg1");
    expect(after.metadata).toEqual({
      tags: ["t"],
      schemaVersions: { avro: [{ label: "1.0" }] },
      extends: "Base",
      typespecMigration: { status: "FLAGGED", at: "2026-11-01T00:00:00.000Z", diagnostics: [{ code: "x" }] },
    });
    expect(after.typespecSource).toBeNull();
  });

  it("MIGRATED stores the source and removes only the typespecMigration marker", async () => {
    await entity("mg2", JSON.stringify({ tags: ["t"], typespecMigration: { status: "FLAGGED" }, sourceFormat: "avro" }));
    const res = await db.query(MIGRATED_WRITE_SQL, ["mg2", "model Order {}"]);
    expect(res.affectedRows).toBe(1);
    const after = await row("mg2");
    expect(after.typespecSource).toBe("model Order {}");
    expect(after.metadata).toEqual({ tags: ["t"], sourceFormat: "avro" });
  });

  it("a NULL or scalar metadata reads as an empty object, and the marker is the only key written", async () => {
    await entity("mg3", null);
    await db.query(FLAGGED_WRITE_SQL, ["mg3", flagged()]);
    expect(Object.keys((await row("mg3")).metadata as object)).toEqual(["typespecMigration"]);

    await entity("mg4", null);
    await db.query(MIGRATED_WRITE_SQL, ["mg4", "model Y {}"]);
    expect(await row("mg4")).toEqual({ metadata: {}, typespecSource: "model Y {}" });
  });

  it("both writes are guarded on typespecSource IS NULL: nothing matches once source is stored", async () => {
    await entity("mg5", JSON.stringify({ tags: ["keep"] }));
    expect((await db.query(MIGRATED_WRITE_SQL, ["mg5", "model Z {}"])).affectedRows).toBe(1);

    // A later FLAGGED write (or a second MIGRATED write) must not touch the stored source or its metadata.
    expect((await db.query(FLAGGED_WRITE_SQL, ["mg5", flagged()])).affectedRows).toBe(0);
    expect((await db.query(MIGRATED_WRITE_SQL, ["mg5", "model Other {}"])).affectedRows).toBe(0);
    expect(await row("mg5")).toEqual({ metadata: { tags: ["keep"] }, typespecSource: "model Z {}" });
  });
});
