import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { applyPgliteMigrations } from "@/lib/pglite-migrate";

const NOW = "CURRENT_TIMESTAMP";
const MIGRATION = "prisma/migrations/20261017_schema_reference_ghost_edges/migration.sql";

/**
 * domain d1 / product p1 with entities eA (v-a1, v-a2) and eB (v-b1); eC lives at the tenant level (v-c1).
 * Edges: eA's versions reference eB / eC (FIELD), eB's version references eC, plus two edges that must never be
 * touched by an entity-version delete: a MESSAGE-sourced edge whose fromId equals an entity version id (kind filter)
 * and an edge sourced at an unrelated entity version.
 */
async function seed(db: PGlite) {
  await db.exec(`INSERT INTO "users" ("id","email","updatedAt") VALUES ('u1','u1@example.test',${NOW})`);
  await db.exec(`INSERT INTO "domains" ("id","tenantId","name","slug","updatedAt") VALUES ('d1','tenant_default','D','d',${NOW})`);
  await db.exec(`INSERT INTO "products" ("id","domainId","name","slug","updatedAt") VALUES ('p1','d1','P','p',${NOW})`);
  const productEntity = (id: string) =>
    db.exec(
      `INSERT INTO "entities" ("id","name","slug","tenantId","domainId","productId","ownerId","updatedAt")
       VALUES ('${id}','${id}','${id}','tenant_default','d1','p1','u1',${NOW})`
    );
  await productEntity("eA");
  await productEntity("eB");
  await db.exec(
    `INSERT INTO "entities" ("id","name","slug","tenantId","ownerId","updatedAt") VALUES ('eC','eC','ec','tenant_default','u1',${NOW})`
  );
  const version = (id: string, entityId: string, sequence: number) =>
    db.exec(
      `INSERT INTO "entity_versions" ("id","entityId","major","minor","sequence","resolvedSource","fieldSnapshot","changeKind","publishedById")
       VALUES ('${id}','${entityId}',${sequence},0,${sequence},'model M {}','[]','INITIAL','u1')`
    );
  await version("v-a1", "eA", 1);
  await version("v-a2", "eA", 2);
  await version("v-b1", "eB", 1);
  await version("v-c1", "eC", 1);
  await db.exec(
    `INSERT INTO "schema_references" ("id","fromKind","fromId","role","toKind","toId","isDraft") VALUES
       ('r-a1-b', 'ENTITY_VERSION', 'v-a1', 'FIELD',   'ENTITY_VERSION', 'v-b1', false),
       ('r-a2-b', 'ENTITY_VERSION', 'v-a2', 'FIELD',   'ENTITY_VERSION', 'v-b1', false),
       ('r-a2-c', 'ENTITY_VERSION', 'v-a2', 'FIELD',   'ENTITY_VERSION', 'v-c1', false),
       ('r-b1-c', 'ENTITY_VERSION', 'v-b1', 'FIELD',   'ENTITY_VERSION', 'v-c1', false),
       ('r-msg',  'MESSAGE',        'v-a1', 'PAYLOAD', 'ENTITY_VERSION', 'v-c1', true)`
  );
}

async function referenceIds(db: PGlite): Promise<string[]> {
  const rows = await db.query<{ id: string }>(`SELECT "id" FROM "schema_references" ORDER BY "id"`);
  return rows.rows.map((r) => r.id);
}

async function count(db: PGlite, table: string): Promise<number> {
  const rows = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}"`);
  return rows.rows[0].n;
}

describe("schema reference ghost edges migration on PGlite", () => {
  it("applies after the events no-delete migration", async () => {
    const db = new PGlite();
    try {
      const applied = await applyPgliteMigrations(db);
      expect(applied.indexOf("20261017_schema_reference_ghost_edges")).toBeGreaterThan(applied.indexOf("20261016_events_core_no_delete"));
    } finally {
      await db.close();
    }
  }, 60_000);

  it("removes the edges sourced at an entity's versions when the entity is deleted (and only those)", async () => {
    const db = new PGlite();
    try {
      await applyPgliteMigrations(db);
      await seed(db);

      // eA's versions go with it through the ON DELETE CASCADE the BEFORE DELETE guard allows.
      await db.exec(`DELETE FROM "entities" WHERE "id" = 'eA'`);
      expect(await count(db, "entity_versions")).toBe(2);
      // r-a1-b / r-a2-b / r-a2-c are gone; the MESSAGE edge that merely shares an id string, and the edge from the
      // surviving eB version, stay.
      expect(await referenceIds(db)).toEqual(["r-b1-c", "r-msg"]);

      await db.exec(`DELETE FROM "entities" WHERE "id" = 'eB'`);
      expect(await referenceIds(db)).toEqual(["r-msg"]);
    } finally {
      await db.close();
    }
  }, 60_000);

  it("keeps the immutability guard: a direct version delete is rejected and removes no edge", async () => {
    const db = new PGlite();
    try {
      await applyPgliteMigrations(db);
      await seed(db);

      await expect(db.exec(`DELETE FROM "entity_versions" WHERE "id" = 'v-a2'`)).rejects.toThrow(/Entity versions cannot be deleted directly/);
      expect(await count(db, "entity_versions")).toBe(4);
      expect(await referenceIds(db)).toEqual(["r-a1-b", "r-a2-b", "r-a2-c", "r-b1-c", "r-msg"]);
    } finally {
      await db.close();
    }
  }, 60_000);

  it("removes the edges of every version cascaded through a domain delete", async () => {
    const db = new PGlite();
    try {
      await applyPgliteMigrations(db);
      await seed(db);

      await db.exec(`DELETE FROM "domains" WHERE "id" = 'd1'`);
      // eA and eB (product level) are gone; tenant-level eC and its version survive.
      expect(await count(db, "entity_versions")).toBe(1);
      expect(await referenceIds(db)).toEqual(["r-msg"]);
    } finally {
      await db.close();
    }
  }, 60_000);

  it("cleans up ghost edges that already exist and is safe to re-run", async () => {
    const db = new PGlite();
    try {
      await applyPgliteMigrations(db);
      await seed(db);

      // Recreate the pre-migration state: no trigger, so an entity delete leaves its edges behind.
      await db.exec(`DROP TRIGGER "entity_versions_delete_references" ON "entity_versions"`);
      await db.exec(`DELETE FROM "entities" WHERE "id" = 'eA'`);
      expect(await referenceIds(db)).toEqual(["r-a1-b", "r-a2-b", "r-a2-c", "r-b1-c", "r-msg"]);

      const sql = readFileSync(MIGRATION, "utf8");
      await db.exec(sql);
      expect(await referenceIds(db)).toEqual(["r-b1-c", "r-msg"]);

      // Second run: idempotent, and the trigger is back.
      await db.exec(sql);
      expect(await referenceIds(db)).toEqual(["r-b1-c", "r-msg"]);
      await db.exec(`DELETE FROM "entities" WHERE "id" = 'eB'`);
      expect(await referenceIds(db)).toEqual(["r-msg"]);
    } finally {
      await db.close();
    }
  }, 60_000);
});
