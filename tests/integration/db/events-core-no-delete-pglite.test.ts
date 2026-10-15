import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { applyPgliteMigrations } from "@/lib/pglite-migrate";

const NOW = "CURRENT_TIMESTAMP";

/** domain d1 / product p1 / published entity e1@v1, with a trait, a message (+version), an event spec (+version) and their edges. */
async function seed(db: PGlite) {
  await db.exec(`INSERT INTO "users" ("id","email","updatedAt") VALUES ('u1','u1@example.test',${NOW})`);
  await db.exec(`INSERT INTO "domains" ("id","tenantId","name","slug","updatedAt") VALUES ('d1','tenant_default','D','d',${NOW})`);
  await db.exec(`INSERT INTO "products" ("id","domainId","name","slug","updatedAt") VALUES ('p1','d1','P','p',${NOW})`);
  await db.exec(
    `INSERT INTO "entities" ("id","name","slug","tenantId","domainId","productId","ownerId","updatedAt")
     VALUES ('e1','Order','order','tenant_default','d1','p1','u1',${NOW})`
  );
  await db.exec(
    `INSERT INTO "entity_versions" ("id","entityId","major","minor","sequence","resolvedSource","fieldSnapshot","changeKind","publishedById")
     VALUES ('v1','e1',1,0,1,'model Order {}','[]','INITIAL','u1')`
  );
  await db.exec(
    `INSERT INTO "traits" ("id","kind","name","tenantId","headersEntityId","headersEntityVersionId","updatedAt")
     VALUES ('t1','MESSAGE','CloudEvents','tenant_default','e1','v1',${NOW})`
  );
  await db.exec(
    `INSERT INTO "messages" ("id","name","payloadEntityId","payloadEntityVersionId","tenantId","domainId","productId","updatedAt")
     VALUES ('m1','OrderCreated','e1','v1','tenant_default','d1','p1',${NOW})`
  );
  await db.exec(
    `INSERT INTO "message_versions" ("id","messageId","major","minor","sequence","resolvedSpec","payloadEntityVersionId","changeKind","publishedById")
     VALUES ('mv1','m1',1,0,1,'{}','v1','INITIAL','u1')`
  );
  await db.exec(`UPDATE "messages" SET "latestVersionId" = 'mv1', "hasUnpublishedChanges" = false WHERE "id" = 'm1'`);
  await db.exec(
    `INSERT INTO "event_specs" ("id","name","document","tenantId","domainId","productId","updatedAt")
     VALUES ('s1','checkout-service','{}','tenant_default','d1','p1',${NOW})`
  );
  await db.exec(
    `INSERT INTO "event_spec_versions" ("id","eventSpecId","major","minor","sequence","document","sourceDocument","frozenChannels","frozenTraits","messageVersionIds","changeKind","publishedById")
     VALUES ('sv1','s1',1,0,1,'{}','{}','[]','[]',ARRAY['mv1'],'INITIAL','u1')`
  );
  await db.exec(
    `INSERT INTO "schema_references" ("id","fromKind","fromId","role","toKind","toId","isDraft") VALUES
       ('r-m',  'MESSAGE',            'm1',  'PAYLOAD', 'ENTITY_VERSION',  'v1',  true),
       ('r-mv', 'MESSAGE_VERSION',    'mv1', 'PAYLOAD', 'ENTITY_VERSION',  'v1',  false),
       ('r-s',  'EVENT_SPEC',         's1',  'MESSAGE', 'MESSAGE_VERSION', 'mv1', true),
       ('r-sv', 'EVENT_SPEC_VERSION', 'sv1', 'MESSAGE', 'MESSAGE_VERSION', 'mv1', false),
       ('r-t',  'TRAIT',              't1',  'HEADERS', 'ENTITY_VERSION',  'v1',  false),
       ('r-other', 'MESSAGE',         'm-other', 'PAYLOAD', 'ENTITY_VERSION', 'v1', true)`
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

describe("events core no-delete migration on PGlite", () => {
  it("applies after events_core and rejects direct deletes of published versions", async () => {
    const db = new PGlite();
    try {
      const applied = await applyPgliteMigrations(db);
      expect(applied.indexOf("20261016_events_core_no_delete")).toBeGreaterThan(applied.indexOf("20261016_events_core"));
      await seed(db);

      await expect(db.exec(`DELETE FROM "message_versions" WHERE "id" = 'mv1'`)).rejects.toThrow(/Message versions cannot be deleted directly/);
      await expect(db.exec(`DELETE FROM "event_spec_versions" WHERE "id" = 'sv1'`)).rejects.toThrow(/Event spec versions cannot be deleted directly/);
      expect(await count(db, "message_versions")).toBe(1);
      expect(await count(db, "event_spec_versions")).toBe(1);
      // A rejected delete must not have removed any edge either.
      expect(await referenceIds(db)).toEqual(["r-m", "r-mv", "r-other", "r-s", "r-sv", "r-t"]);

      // Deleting the parent is allowed and takes its versions (and their edges) with it.
      await db.exec(`DELETE FROM "event_specs" WHERE "id" = 's1'`);
      expect(await count(db, "event_spec_versions")).toBe(0);
      expect(await referenceIds(db)).toEqual(["r-m", "r-mv", "r-other", "r-t"]);
      await db.exec(`DELETE FROM "messages" WHERE "id" = 'm1'`);
      expect(await count(db, "message_versions")).toBe(0);
      expect(await referenceIds(db)).toEqual(["r-other", "r-t"]);
    } finally {
      await db.close();
    }
  }, 60_000);

  it("keeps cascading with the domain and leaves no ghost schema_references behind", async () => {
    const db = new PGlite();
    try {
      await applyPgliteMigrations(db);
      await seed(db);

      // Deleting a trait removes its edge only.
      await db.exec(`DELETE FROM "traits" WHERE "id" = 't1'`);
      expect(await referenceIds(db)).toEqual(["r-m", "r-mv", "r-other", "r-s", "r-sv"]);

      await db.exec(`DELETE FROM "domains" WHERE "id" = 'd1'`);
      for (const table of ["messages", "message_versions", "event_specs", "event_spec_versions", "entities", "entity_versions"]) {
        expect(await count(db, table), table).toBe(0);
      }
      // Edges from the cascaded message / message version / event spec / event spec version are gone;
      // an edge from an unrelated record is untouched.
      expect(await referenceIds(db)).toEqual(["r-other"]);
    } finally {
      await db.close();
    }
  }, 60_000);

  it("indexes every pin foreign-key column", async () => {
    const db = new PGlite();
    try {
      await applyPgliteMigrations(db);
      const rows = await db.query<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public'`);
      const defs = rows.rows.map((r) => r.indexdef);
      const indexed = (table: string, column: string) => defs.some((d) => d.includes(`ON public.${table} USING btree ("${column}")`));
      for (const column of ["payloadEntityId", "payloadEntityVersionId", "headersEntityId", "headersEntityVersionId", "keyEntityId", "keyEntityVersionId"]) {
        expect(indexed("messages", column), `messages.${column}`).toBe(true);
      }
      for (const column of ["headersEntityId", "headersEntityVersionId"]) expect(indexed("traits", column), `traits.${column}`).toBe(true);
      for (const column of ["payloadEntityVersionId", "headersEntityVersionId", "keyEntityVersionId"]) {
        expect(indexed("message_versions", column), `message_versions.${column}`).toBe(true);
      }
    } finally {
      await db.close();
    }
  }, 60_000);
});
