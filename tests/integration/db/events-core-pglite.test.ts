import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { applyPgliteMigrations } from "@/lib/pglite-migrate";

const NOW = "CURRENT_TIMESTAMP";

describe("events core schema on PGlite (after every migration, the legacy catalog dropped)", () => {
  it("applies, enforces placement + immutability, blocks deleting pinned entities, cascades with the domain", async () => {
    const db = new PGlite();
    try {
      const applied = await applyPgliteMigrations(db);
      expect(applied).toContain("20261016_events_core");
      expect(applied).toContain("20261020_drop_legacy_event_catalog");

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

      // Traits live at tenant or domain level only; only MESSAGE traits carry headers.
      await expect(
        db.exec(
          `INSERT INTO "traits" ("id","kind","name","tenantId","headersEntityId","updatedAt")
           VALUES ('t0','OPERATION','Bad','tenant_default','e1',${NOW})`
        )
      ).rejects.toThrow(/traits_headers_check/);
      await expect(
        db.exec(
          `INSERT INTO "traits" ("id","kind","name","tenantId","domainId","productId","updatedAt")
           VALUES ('t9','MESSAGE','ProductLevel','tenant_default','d1','p1',${NOW})`
        )
      ).rejects.toThrow(/traits_no_product_check/);
      await db.exec(
        `INSERT INTO "traits" ("id","kind","name","tenantId","headersEntityId","headersEntityVersionId","updatedAt")
         VALUES ('t1','MESSAGE','CloudEvents','tenant_default','e1','v1',${NOW})`
      );

      // Events are product-only (spec §4.1).
      await expect(
        db.exec(`INSERT INTO "event_specs" ("id","name","document","tenantId","updatedAt") VALUES ('s0','x','{}','tenant_default',${NOW})`)
      ).rejects.toThrow(/event_specs_level_check/);
      await db.exec(
        `INSERT INTO "event_specs" ("id","name","document","tenantId","domainId","productId","updatedAt")
         VALUES ('s1','checkout-service','{"documentVersion":2,"info":{"title":"checkout-service"}}','tenant_default','d1','p1',${NOW})`
      );
      const spec = await db.query<{ specType: string }>(`SELECT "specType" FROM "event_specs" WHERE "id" = 's1'`);
      expect(spec.rows[0].specType).toBe("asyncapi@3.0");
      await db.exec(
        `INSERT INTO "event_spec_versions" ("id","eventSpecId","major","minor","sequence","document","sourceDocument","frozenTraits","resolvedSpec","changeKind","publishedById")
         VALUES ('sv1','s1',1,0,1,'{}','{}','[]','{"documentVersion":2}','INITIAL','u1')`
      );
      await expect(
        db.exec(
          `INSERT INTO "event_spec_versions" ("id","eventSpecId","major","minor","sequence","document","sourceDocument","frozenTraits","changeKind","publishedById")
           VALUES ('sv0','s1',0,0,2,'{}','{}','[]','INITIAL','u1')`
        )
      ).rejects.toThrow(/event_spec_versions_numbers_check/);

      // Published versions are immutable.
      await expect(db.exec(`UPDATE "event_spec_versions" SET "minor" = 1 WHERE "id" = 'sv1'`)).rejects.toThrow(/immutable/);

      // D3: an entity pinned by a library trait cannot be deleted on its own …
      await expect(db.exec(`DELETE FROM "entities" WHERE "id" = 'e1'`)).rejects.toThrow(/foreign key/);

      // … but the tenant-level trait (outside the domain) is the only thing that would survive the cascade.
      await db.exec(`DELETE FROM "traits" WHERE "id" = 't1'`);
      await db.exec(`DELETE FROM "domains" WHERE "id" = 'd1'`);
      for (const table of ["event_specs", "event_spec_versions", "entities", "entity_versions"]) {
        const left = await db.query(`SELECT 1 FROM "${table}"`);
        expect(left.rows, table).toHaveLength(0);
      }
    } finally {
      await db.close();
    }
  }, 60_000);

  it("has no table, column or function of the legacy catalog", async () => {
    const db = new PGlite();
    try {
      await applyPgliteMigrations(db);
      const tables = await db.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('messages','message_versions','channels','channel_messages')`
      );
      expect(tables.rows).toEqual([]);
      const columns = await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'event_spec_versions' AND column_name IN ('frozenChannels','messageVersionIds')`
      );
      expect(columns.rows).toEqual([]);
    } finally {
      await db.close();
    }
  }, 60_000);
});
