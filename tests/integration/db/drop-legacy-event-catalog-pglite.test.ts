import { describe, it, expect } from "vitest";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { applyPgliteMigrations } from "@/lib/pglite-migrate";

const NAME = "20261020_drop_legacy_event_catalog";
const FILE = `prisma/migrations/${NAME}/migration.sql`;
const NOW = "CURRENT_TIMESTAMP";

/** A copy of prisma/migrations without the migration under test: the schema as it was before the legacy catalog was dropped. */
function migrationsBefore(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "migrations-before-drop-"));
  for (const entry of readdirSync("prisma/migrations", { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== NAME) cpSync(join("prisma/migrations", entry.name), join(dir, entry.name), { recursive: true });
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Run `body` on a fresh PGlite that has every migration except the one under test. */
async function onLegacySchema(body: (db: PGlite) => Promise<void>): Promise<void> {
  const before = migrationsBefore();
  const db = new PGlite();
  try {
    await applyPgliteMigrations(db, before.dir);
    await body(db);
  } finally {
    await db.close();
    before.cleanup();
  }
}

async function scalar<T>(db: PGlite, sql: string): Promise<T> {
  const res = await db.query<{ v: T }>(sql);
  return res.rows[0].v;
}
const count = (db: PGlite, table: string) => scalar<number>(db, `SELECT count(*)::int AS v FROM "${table}"`);
const tableExists = async (db: PGlite, table: string) => (await scalar<string | null>(db, `SELECT to_regclass('public."${table}"')::text AS v`)) !== null;
const migrationRecorded = async (db: PGlite) => (await scalar<number>(db, `SELECT count(*)::int AS v FROM "_pglite_migrations" WHERE name = '${NAME}'`)) === 1;

/** domain d1 / product p1 / entity e1 with a published version v1: the common ground of every scenario. */
async function seedBase(db: PGlite) {
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
}

const channel = (id = "c1") =>
  `INSERT INTO "channels" ("id","name","protocol","format","tenantId","domainId","productId","updatedAt")
   VALUES ('${id}','orders','kafka','avro','tenant_default','d1','p1',${NOW})`;
const message = (id = "m1") =>
  `INSERT INTO "messages" ("id","name","payloadEntityId","payloadEntityVersionId","tenantId","domainId","productId","updatedAt")
   VALUES ('${id}','OrderCreated','e1','v1','tenant_default','d1','p1',${NOW})`;
const messageVersion = `INSERT INTO "message_versions" ("id","messageId","major","minor","sequence","resolvedSpec","payloadEntityVersionId","changeKind","publishedById")
   VALUES ('mv1','m1',1,0,1,'{}','v1','INITIAL','u1')`;
const v2Spec = (id = "s2") =>
  `INSERT INTO "event_specs" ("id","name","document","tenantId","domainId","productId","updatedAt")
   VALUES ('${id}','checkout','{"documentVersion":2,"info":{"title":"checkout"}}','tenant_default','d1','p1',${NOW})`;

/** The migration must refuse (and leave no trace); `needle` is the line of the error that names the offending data. */
async function expectRefused(db: PGlite, needle: RegExp) {
  const before = {
    messages: await tableExists(db, "messages"),
    columns: await scalar<number>(
      db,
      `SELECT count(*)::int AS v FROM information_schema.columns WHERE table_name = 'event_spec_versions' AND column_name IN ('frozenChannels','messageVersionIds')`
    ),
    edges: await count(db, "schema_references"),
  };
  await expect(applyPgliteMigrations(db)).rejects.toThrow(/Cannot drop the legacy event catalog/);
  await expect(applyPgliteMigrations(db)).rejects.toThrow(needle);
  // Atomic: nothing was dropped, no edge was deleted, the migration is not recorded.
  expect(await tableExists(db, "messages")).toBe(before.messages);
  expect(
    await scalar<number>(db, `SELECT count(*)::int AS v FROM information_schema.columns WHERE table_name = 'event_spec_versions' AND column_name IN ('frozenChannels','messageVersionIds')`)
  ).toBe(before.columns);
  expect(await count(db, "schema_references")).toBe(before.edges);
  expect(await migrationRecorded(db)).toBe(false);
}

describe("drop legacy event catalog migration (guard)", () => {
  it.each([
    ["a channel", [channel()], /1 row\(s\) in "channels"/],
    ["a message", [message()], /1 row\(s\) in "messages"/],
    ["a message version", [message(), messageVersion], /1 row\(s\) in "message_versions"/],
    ["a channel_messages link", [channel(), message(), `INSERT INTO "channel_messages" ("channelId","messageId") VALUES ('c1','m1')`], /1 row\(s\) in "channel_messages"/],
  ])("refuses while %s exists", async (_label, statements, needle) => {
    await onLegacySchema(async (db) => {
      await seedBase(db);
      for (const sql of statements) await db.exec(sql);
      await expectRefused(db, needle);
    });
  }, 120_000);

  it("refuses a version-1 event spec (document without documentVersion 2) and names it", async () => {
    await onLegacySchema(async (db) => {
      await seedBase(db);
      await db.exec(
        `INSERT INTO "event_specs" ("id","name","document","tenantId","domainId","productId","updatedAt")
         VALUES ('s1','legacy','{"info":{"title":"legacy"},"servers":[],"operations":[]}','tenant_default','d1','p1',${NOW})`
      );
      await expectRefused(db, /1 legacy \(documentVersion is not 2\) row\(s\) in "event_specs"/);
    });
  }, 120_000);

  it("refuses an event_spec_versions row without a resolvedSpec, even when its event is a v2 document", async () => {
    await onLegacySchema(async (db) => {
      await seedBase(db);
      await db.exec(v2Spec());
      await db.exec(
        `INSERT INTO "event_spec_versions" ("id","eventSpecId","major","minor","sequence","document","sourceDocument","frozenChannels","frozenTraits","changeKind","publishedById")
         VALUES ('sv1','s2',1,0,1,'{}','{}','[]','[]','INITIAL','u1')`
      );
      await expectRefused(db, /1 legacy row\(s\) in "event_spec_versions"/);
    });
  }, 120_000);

  it("refuses a product-level trait instead of deleting it", async () => {
    await onLegacySchema(async (db) => {
      await seedBase(db);
      await db.exec(
        `INSERT INTO "traits" ("id","kind","name","tenantId","domainId","productId","updatedAt")
         VALUES ('t1','MESSAGE','Audit','tenant_default','d1','p1',${NOW})`
      );
      await expectRefused(db, /1 product-level row\(s\) in "traits"/);
      expect(await count(db, "traits")).toBe(1);
    });
  }, 120_000);

  it("lists every kind of legacy data in one message", async () => {
    await onLegacySchema(async (db) => {
      await seedBase(db);
      await db.exec(channel());
      await db.exec(message());
      await db.exec(messageVersion);
      await db.exec(`INSERT INTO "event_specs" ("id","name","document","tenantId","domainId","productId","updatedAt") VALUES ('s1','legacy','{}','tenant_default','d1','p1',${NOW})`);
      let text = "";
      try {
        await applyPgliteMigrations(db);
      } catch (e) {
        text = String(e instanceof Error ? e.message : e);
      }
      for (const part of ['"channels"', '"messages"', '"message_versions"', '"event_specs"']) expect(text, part).toContain(part);
      expect(text).toContain(NAME);
    });
  }, 120_000);

  it("never deletes legacy rows: after a refusal they are all still there", async () => {
    await onLegacySchema(async (db) => {
      await seedBase(db);
      await db.exec(channel());
      await db.exec(message());
      await db.exec(messageVersion);
      await expect(applyPgliteMigrations(db)).rejects.toThrow(/legacy/);
      expect(await count(db, "channels")).toBe(1);
      expect(await count(db, "messages")).toBe(1);
      expect(await count(db, "message_versions")).toBe(1);
    });
  }, 120_000);
});

describe("drop legacy event catalog migration (clean database)", () => {
  it("applies through every migration on a fresh database and leaves no dropped object behind", async () => {
    const db = new PGlite();
    try {
      const applied = await applyPgliteMigrations(db);
      expect(applied).toContain(NAME);

      for (const table of ["messages", "message_versions", "channels", "channel_messages"]) expect(await tableExists(db, table), table).toBe(false);
      for (const table of ["event_specs", "event_spec_versions", "traits", "schema_references", "entities", "entity_versions"]) {
        expect(await tableExists(db, table), table).toBe(true);
      }

      const columns = await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'event_spec_versions'`
      );
      const names = columns.rows.map((c) => c.column_name);
      expect(names).not.toContain("frozenChannels");
      expect(names).not.toContain("messageVersionIds");
      for (const kept of ["frozenTraits", "resolvedSpec", "sourceDocument", "document"]) expect(names, kept).toContain(kept);

      const fns = await db.query<{ proname: string }>(`SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname LIKE '%message%'`);
      expect(fns.rows).toEqual([]);
      // the shared trigger functions are still used by event_specs / event_spec_versions / traits
      for (const fn of ["delete_schema_references_from", "prevent_published_version_update", "prevent_event_spec_version_delete"]) {
        expect(await scalar<number>(db, `SELECT count(*)::int AS v FROM pg_proc WHERE proname = '${fn}'`), fn).toBe(1);
      }

      const triggers = await db.query<{ tgname: string }>(
        `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND (tgname LIKE 'message%' OR tgname LIKE 'channel%')`
      );
      expect(triggers.rows).toEqual([]);

      // no leftover constraint / index mentions a dropped table
      const leftovers = await db.query<{ conname: string }>(`SELECT conname FROM pg_constraint WHERE conname ~ '^(messages|message_versions|channels|channel_messages)_'`);
      expect(leftovers.rows).toEqual([]);
      const idx = await db.query<{ indexname: string }>(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname ~ '^(messages|message_versions|channels|channel_messages)_'`);
      expect(idx.rows).toEqual([]);

      // the enum values stay (Postgres cannot drop them)
      const from = await db.query<{ enumlabel: string }>(
        `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'SchemaReferenceFromKind' ORDER BY e.enumsortorder`
      );
      expect(from.rows.map((r) => r.enumlabel)).toEqual(expect.arrayContaining(["MESSAGE", "MESSAGE_VERSION", "EVENT_SPEC", "EVENT_SPEC_VERSION", "TRAIT"]));
    } finally {
      await db.close();
    }
  }, 120_000);

  it("keeps v2 data and non-legacy edges, removes the legacy edges, then enforces the trait CHECK", async () => {
    await onLegacySchema(async (db) => {
      await seedBase(db);
      await db.exec(v2Spec());
      await db.exec(
        `INSERT INTO "event_spec_versions" ("id","eventSpecId","major","minor","sequence","document","sourceDocument","frozenChannels","frozenTraits","changeKind","publishedById","resolvedSpec")
         VALUES ('sv2','s2',1,0,1,'{"asyncapi":"3.0.0"}','{"documentVersion":2}','[]','[]','INITIAL','u1','{"documentVersion":2}')`
      );
      await db.exec(
        `INSERT INTO "traits" ("id","kind","name","tenantId","domainId","updatedAt") VALUES ('t-domain','MESSAGE','DomainProps','tenant_default','d1',${NOW})`
      );
      await db.exec(`INSERT INTO "traits" ("id","kind","name","tenantId","updatedAt") VALUES ('t-tenant','OPERATION','TenantProps','tenant_default',${NOW})`);
      await db.exec(
        `INSERT INTO "schema_references" ("id","fromKind","fromId","role","toKind","toId","isDraft") VALUES
           ('keep-draft',   'EVENT_SPEC',         's2',  'PAYLOAD', 'ENTITY_VERSION',     'v1',  true),
           ('keep-pub',     'EVENT_SPEC_VERSION', 'sv2', 'PAYLOAD', 'ENTITY_VERSION',     'v1',  false),
           ('keep-ext',     'EVENT_SPEC',         's2',  'MESSAGE', 'EVENT_SPEC_VERSION', 'sv2', true),
           ('keep-trait',   'TRAIT',              't-domain', 'HEADERS', 'ENTITY_VERSION', 'v1', false),
           ('keep-entity',  'ENTITY_VERSION',     'v1',  'FIELD',   'ENTITY_VERSION',     'v1',  false),
           ('gone-msg',     'MESSAGE',            'ghost-m',  'PAYLOAD', 'ENTITY_VERSION', 'v1', true),
           ('gone-mv',      'MESSAGE_VERSION',    'ghost-mv', 'PAYLOAD', 'ENTITY_VERSION', 'v1', false),
           ('gone-to-mv-1', 'EVENT_SPEC',         's2',  'MESSAGE', 'MESSAGE_VERSION',    'ghost-mv', true),
           ('gone-to-mv-2', 'EVENT_SPEC_VERSION', 'sv2', 'MESSAGE', 'MESSAGE_VERSION',    'ghost-mv', false)`
      );

      expect(await applyPgliteMigrations(db)).toEqual([NAME]);

      const ids = await db.query<{ id: string }>(`SELECT "id" FROM "schema_references" ORDER BY "id"`);
      expect(ids.rows.map((r) => r.id)).toEqual(["keep-draft", "keep-entity", "keep-ext", "keep-pub", "keep-trait"]);
      expect(await count(db, "event_specs")).toBe(1);
      expect(await count(db, "event_spec_versions")).toBe(1);
      expect(await count(db, "traits")).toBe(2);
      expect(await count(db, "entities")).toBe(1);

      await expect(
        db.exec(`INSERT INTO "traits" ("id","kind","name","tenantId","domainId","productId","updatedAt") VALUES ('t-bad','MESSAGE','Bad','tenant_default','d1','p1',${NOW})`)
      ).rejects.toThrow(/traits_no_product_check/);
      // domain- and tenant-level traits are untouched by the CHECK
      await db.exec(`INSERT INTO "traits" ("id","kind","name","tenantId","domainId","updatedAt") VALUES ('t-ok','MESSAGE','Ok','tenant_default','d1',${NOW})`);
    });
  }, 120_000);

  it("is safe to re-run the migration file (idempotent partial-apply recovery)", async () => {
    const db = new PGlite();
    try {
      await applyPgliteMigrations(db);
      await db.exec(readFileSync(FILE, "utf8"));
      await db.exec(readFileSync(FILE, "utf8"));
      expect(await tableExists(db, "messages")).toBe(false);
      expect(
        await scalar<number>(db, `SELECT count(*)::int AS v FROM pg_constraint WHERE conname = 'traits_no_product_check'`)
      ).toBe(1);
    } finally {
      await db.close();
    }
  }, 120_000);

  it("still cascades a domain delete through events and drops no event data", async () => {
    const db = new PGlite();
    try {
      await applyPgliteMigrations(db);
      await seedBase(db);
      await db.exec(v2Spec());
      await db.exec(
        `INSERT INTO "event_spec_versions" ("id","eventSpecId","major","minor","sequence","document","sourceDocument","frozenTraits","changeKind","publishedById","resolvedSpec")
         VALUES ('sv2','s2',1,0,1,'{}','{}','[]','INITIAL','u1','{"documentVersion":2}')`
      );
      await db.exec(`INSERT INTO "schema_references" ("id","fromKind","fromId","role","toKind","toId","isDraft") VALUES ('r1','EVENT_SPEC_VERSION','sv2','PAYLOAD','ENTITY_VERSION','v1',false)`);
      await db.exec(`DELETE FROM "domains" WHERE "id" = 'd1'`);
      expect(await count(db, "event_specs")).toBe(0);
      expect(await count(db, "event_spec_versions")).toBe(0);
      expect(await count(db, "schema_references")).toBe(0);
    } finally {
      await db.close();
    }
  }, 120_000);
});
