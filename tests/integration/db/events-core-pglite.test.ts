import { describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { applyPgliteMigrations } from "@/lib/pglite-migrate";

const NOW = "CURRENT_TIMESTAMP";

describe("events core migration on PGlite", () => {
  it("applies, enforces placement + immutability, blocks deleting pinned entities, cascades with the domain", async () => {
    const db = new PGlite();
    try {
      const applied = await applyPgliteMigrations(db);
      expect(applied).toContain("20261016_events_core");

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

      // Channels are product-only (spec §4.1).
      await expect(
        db.exec(`INSERT INTO "channels" ("id","name","protocol","format","tenantId","updatedAt") VALUES ('c0','orders','kafka','avro','tenant_default',${NOW})`)
      ).rejects.toThrow(/channels_level_check/);
      // A dialect only makes sense for JSON Schema.
      await expect(
        db.exec(
          `INSERT INTO "channels" ("id","name","protocol","format","formatDialect","tenantId","domainId","productId","updatedAt")
           VALUES ('c9','orders','kafka','avro','draft-07','tenant_default','d1','p1',${NOW})`
        )
      ).rejects.toThrow(/channels_format_check/);
      await db.exec(
        `INSERT INTO "channels" ("id","name","address","protocol","format","tenantId","domainId","productId","updatedAt")
         VALUES ('c1','orders','payments.orders.v1','kafka','avro','tenant_default','d1','p1',${NOW})`
      );

      // Traits may live at tenant level; only MESSAGE traits carry headers.
      await expect(
        db.exec(
          `INSERT INTO "traits" ("id","kind","name","tenantId","headersEntityId","updatedAt")
           VALUES ('t0','OPERATION','Bad','tenant_default','e1',${NOW})`
        )
      ).rejects.toThrow(/traits_headers_check/);
      await db.exec(
        `INSERT INTO "traits" ("id","kind","name","tenantId","headersEntityId","headersEntityVersionId","updatedAt")
         VALUES ('t1','MESSAGE','CloudEvents','tenant_default','e1','v1',${NOW})`
      );

      await db.exec(
        `INSERT INTO "messages" ("id","name","payloadEntityId","payloadEntityVersionId","tenantId","domainId","productId","updatedAt")
         VALUES ('m1','OrderCreated','e1','v1','tenant_default','d1','p1',${NOW})`
      );
      await db.exec(`INSERT INTO "channel_messages" ("channelId","messageId") VALUES ('c1','m1')`);
      await db.exec(
        `INSERT INTO "message_versions" ("id","messageId","major","minor","sequence","resolvedSpec","payloadEntityVersionId","changeKind","publishedById")
         VALUES ('mv1','m1',1,0,1,'{}','v1','INITIAL','u1')`
      );
      await db.exec(`UPDATE "messages" SET "latestVersionId" = 'mv1', "hasUnpublishedChanges" = false WHERE "id" = 'm1'`);
      await db.exec(
        `INSERT INTO "event_specs" ("id","name","document","tenantId","domainId","productId","updatedAt")
         VALUES ('s1','checkout-service','{"info":{"title":"checkout-service"},"servers":[],"operations":[]}','tenant_default','d1','p1',${NOW})`
      );
      const spec = await db.query<{ specType: string }>(`SELECT "specType" FROM "event_specs" WHERE "id" = 's1'`);
      expect(spec.rows[0].specType).toBe("asyncapi@3.0");
      await db.exec(
        `INSERT INTO "event_spec_versions" ("id","eventSpecId","major","minor","sequence","document","sourceDocument","frozenChannels","frozenTraits","messageVersionIds","changeKind","publishedById")
         VALUES ('sv1','s1',1,0,1,'{}','{}','[]','[]',ARRAY['mv1'],'INITIAL','u1')`
      );

      await expect(db.exec(`UPDATE "message_versions" SET "minor" = 1 WHERE "id" = 'mv1'`)).rejects.toThrow(/immutable/);
      await expect(db.exec(`UPDATE "event_spec_versions" SET "minor" = 1 WHERE "id" = 'sv1'`)).rejects.toThrow(/immutable/);

      // D3: a pinned entity cannot be deleted on its own …
      await expect(db.exec(`DELETE FROM "entities" WHERE "id" = 'e1'`)).rejects.toThrow(/foreign key/);

      // … but the tenant-level trait (outside the domain) is the only thing that would survive the cascade.
      await db.exec(`DELETE FROM "traits" WHERE "id" = 't1'`);
      await db.exec(`DELETE FROM "domains" WHERE "id" = 'd1'`);
      for (const table of ["channels", "channel_messages", "messages", "message_versions", "event_specs", "event_spec_versions", "entities"]) {
        const left = await db.query(`SELECT 1 FROM "${table}"`);
        expect(left.rows, table).toHaveLength(0);
      }
    } finally {
      await db.close();
    }
  }, 60_000);
});
