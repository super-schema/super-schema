import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { applyPgliteMigrations } from "@/lib/pglite-migrate";

const NOW = "CURRENT_TIMESTAMP";
const MIGRATIONS = ["20261018_event_document_v2_enums", "20261018_event_document_v2_columns"];

/** An event spec with one published version, so there is a real `event_spec_versions` row to point at. */
async function seedPublishedEventSpecVersion(db: PGlite) {
  await db.exec(`INSERT INTO "users" ("id","email","updatedAt") VALUES ('u1','u1@example.test',${NOW})`);
  await db.exec(`INSERT INTO "domains" ("id","tenantId","name","slug","updatedAt") VALUES ('d1','tenant_default','D','d',${NOW})`);
  await db.exec(`INSERT INTO "products" ("id","domainId","name","slug","updatedAt") VALUES ('p1','d1','P','p',${NOW})`);
  await db.exec(
    `INSERT INTO "event_specs" ("id","name","document","tenantId","domainId","productId","updatedAt")
     VALUES ('s1','checkout','{}','tenant_default','d1','p1',${NOW})`
  );
  await db.exec(
    `INSERT INTO "event_spec_versions"
       ("id","eventSpecId","major","minor","sequence","document","sourceDocument","frozenChannels","frozenTraits","changeKind","publishedById")
     VALUES ('sv1','s1',1,0,1,'{}','{}','[]','[]','INITIAL','u1')`
  );
}

describe("event document v2 migrations on PGlite", () => {
  it("applies both migrations, after the schema-reference ghost-edge migration (they are independent of each other)", async () => {
    const db = new PGlite();
    try {
      const applied = await applyPgliteMigrations(db);
      const ghostEdges = applied.indexOf("20261017_schema_reference_ghost_edges");
      expect(ghostEdges).toBeGreaterThanOrEqual(0);
      expect(applied.indexOf("20261018_event_document_v2_enums")).toBeGreaterThan(ghostEdges);
      expect(applied.indexOf("20261018_event_document_v2_columns")).toBeGreaterThan(ghostEdges);
    } finally {
      await db.close();
    }
  }, 60_000);

  it("accepts schema_references rows pointing at an EVENT_SPEC_VERSION", async () => {
    const db = new PGlite();
    try {
      await applyPgliteMigrations(db);
      await db.exec(
        `INSERT INTO "schema_references" ("id","fromKind","fromId","role","toKind","toId","isDraft")
         VALUES ('r1','EVENT_SPEC','x','MESSAGE','EVENT_SPEC_VERSION','y',true)`
      );
      const rows = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "schema_references" WHERE "toKind" = 'EVENT_SPEC_VERSION'`
      );
      expect(rows.rows[0].n).toBe(1);
    } finally {
      await db.close();
    }
  }, 60_000);

  it("event_spec_versions has a nullable JSONB resolvedSpec column", async () => {
    const db = new PGlite();
    try {
      await applyPgliteMigrations(db);
      const cols = await db.query(
        `select data_type, is_nullable from information_schema.columns where table_name = 'event_spec_versions' and column_name = 'resolvedSpec'`
      );
      expect(cols.rows).toEqual([{ data_type: "jsonb", is_nullable: "YES" }]);
    } finally {
      await db.close();
    }
  }, 60_000);

  it("stores a resolvedSpec on insert and leaves it NULL for rows written without one (legacy / pre-v2 versions)", async () => {
    const db = new PGlite();
    try {
      await applyPgliteMigrations(db);
      await seedPublishedEventSpecVersion(db);

      const legacy = await db.query<{ resolvedSpec: unknown }>(`SELECT "resolvedSpec" FROM "event_spec_versions" WHERE "id" = 'sv1'`);
      expect(legacy.rows[0].resolvedSpec).toBeNull();

      await db.exec(
        `INSERT INTO "event_spec_versions"
           ("id","eventSpecId","major","minor","sequence","document","sourceDocument","frozenChannels","frozenTraits","changeKind","publishedById","resolvedSpec")
         VALUES ('sv2','s1',1,1,2,'{}','{}','[]','[]','MINOR','u1','{"documentVersion":2}')`
      );
      const stored = await db.query<{ resolvedSpec: unknown }>(`SELECT "resolvedSpec" FROM "event_spec_versions" WHERE "id" = 'sv2'`);
      expect(stored.rows[0].resolvedSpec).toEqual({ documentVersion: 2 });
    } finally {
      await db.close();
    }
  }, 60_000);

  it("is safe to re-run both migration files (idempotent partial-apply recovery)", async () => {
    const db = new PGlite();
    try {
      await applyPgliteMigrations(db);
      for (const name of MIGRATIONS) {
        await db.exec(readFileSync(`prisma/migrations/${name}/migration.sql`, "utf8"));
      }
      const values = await db.query<{ enumlabel: string }>(
        `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'SchemaReferenceToKind' ORDER BY e.enumsortorder`
      );
      expect(values.rows.map((r) => r.enumlabel)).toEqual(["ENTITY_VERSION", "MESSAGE_VERSION", "EVENT_SPEC_VERSION"]);
    } finally {
      await db.close();
    }
  }, 60_000);

  it("keeps event_spec_versions immutable: an UPDATE of resolvedSpec is still rejected", async () => {
    const db = new PGlite();
    try {
      await applyPgliteMigrations(db);
      await seedPublishedEventSpecVersion(db);
      await expect(db.exec(`UPDATE "event_spec_versions" SET "resolvedSpec" = '{}' WHERE "id" = 'sv1'`)).rejects.toThrow(
        /Published versions are immutable/
      );
    } finally {
      await db.close();
    }
  }, 60_000);
});
