-- Drop the legacy event catalog (events cleanup, WP-C1b).
--
-- The independent Message / Message version / Channel catalog and the version-1 Event Spec document that referenced it by id
-- were replaced by the self-contained event document (documentVersion 2): messages, channels, traits (as local property sets)
-- and operations live INSIDE the event. The legacy UI and services are gone; this migration removes their tables.
--
-- THIS MIGRATION REFUSES TO RUN ON A DATABASE THAT STILL HOLDS LEGACY DATA. It never deletes user rows. Before deploying to an
-- environment other than the development database (which has none), export or delete the rows the error message names:
--   * rows in "messages", "message_versions", "channels" or "channel_messages";
--   * "event_specs" rows whose document is not documentVersion 2;
--   * "event_spec_versions" rows without a "resolvedSpec" (published before document v2);
--   * product-level "traits" (productId set) — traits are tenant or domain level only.
-- Re-run `npm run db:deploy` afterwards. The guard runs first and the whole file is one transaction (Prisma migrate and
-- src/lib/pglite-migrate.ts both run a file atomically), so a refusal changes nothing.
--
-- What it does after the guard:
--   1. deletes the schema_references edges that belong to the legacy kinds (they only point at / come from the dropped rows);
--   2. drops channel_messages, channels, message_versions, messages (the circular messages <-> message_versions foreign key is
--      broken first) and the now-dead function prevent_message_version_delete();
--   3. drops event_spec_versions."frozenChannels" and "messageVersionIds" (they only described legacy catalog channels / messages);
--   4. adds CHECK traits_no_product_check: a trait never has a productId. The column stays on purpose (renaming or dropping it
--      would touch the trait service and every trait query for no gain) — the CHECK is the invariant.
-- The enum values MESSAGE / MESSAGE_VERSION stay (Postgres cannot drop enum values); nothing writes them any more.
-- delete_schema_references_from() and prevent_published_version_update() stay: event_specs, event_spec_versions and traits
-- still use them.
-- Idempotent so a partial apply can be re-run. Plain PL/pgSQL, no BEGIN / COMMIT.

-- ── 0. guard: refuse to drop anything that holds data ────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  tbl text;
  n bigint;
  found text := '';
BEGIN
  FOREACH tbl IN ARRAY ARRAY['messages', 'message_versions', 'channels', 'channel_messages'] LOOP
    IF to_regclass('public.' || quote_ident(tbl)) IS NOT NULL THEN
      EXECUTE format('SELECT count(*) FROM %I', tbl) INTO n;
      IF n > 0 THEN
        found := found || format(E'\n  - %s row(s) in "%s"', n, tbl);
      END IF;
    END IF;
  END LOOP;

  SELECT count(*) INTO n FROM "event_specs" WHERE ("document" ->> 'documentVersion') IS DISTINCT FROM '2';
  IF n > 0 THEN
    found := found || format(E'\n  - %s legacy (documentVersion is not 2) row(s) in "event_specs"', n);
  END IF;

  SELECT count(*) INTO n FROM "event_spec_versions" WHERE "resolvedSpec" IS NULL;
  IF n > 0 THEN
    found := found || format(E'\n  - %s legacy row(s) in "event_spec_versions" (no "resolvedSpec": published before document v2)', n);
  END IF;

  SELECT count(*) INTO n FROM "traits" WHERE "productId" IS NOT NULL;
  IF n > 0 THEN
    found := found || format(E'\n  - %s product-level row(s) in "traits" (traits are tenant or domain level only)', n);
  END IF;

  IF found <> '' THEN
    RAISE EXCEPTION E'Cannot drop the legacy event catalog: the database still holds legacy data:%\nExport or delete these rows first (see the comment at the top of prisma/migrations/20261020_drop_legacy_event_catalog/migration.sql); this migration never deletes user data.', found
      USING ERRCODE = 'P0001';
  END IF;
END $$;

-- ── 1. edges of the legacy kinds ─────────────────────────────────────────────────────────────────────────────────────────
-- With no legacy rows left (guard above) these only reference rows that no longer exist.
DELETE FROM "schema_references"
 WHERE "fromKind" IN ('MESSAGE'::"SchemaReferenceFromKind", 'MESSAGE_VERSION'::"SchemaReferenceFromKind")
    OR "toKind" = 'MESSAGE_VERSION'::"SchemaReferenceToKind";

-- ── 2. tables ────────────────────────────────────────────────────────────────────────────────────────────────────────────
-- messages.latestVersionId -> message_versions and message_versions.messageId -> messages form a cycle: break it first.
-- DROP TABLE fires no row triggers (message_versions_no_delete, *_delete_references go with their tables).
ALTER TABLE IF EXISTS "messages" DROP CONSTRAINT IF EXISTS "messages_latestVersionId_fkey";
DROP TABLE IF EXISTS "channel_messages";
DROP TABLE IF EXISTS "channels";
DROP TABLE IF EXISTS "message_versions";
DROP TABLE IF EXISTS "messages";
DROP FUNCTION IF EXISTS prevent_message_version_delete();

-- ── 3. event_spec_versions columns that described legacy catalog channels / messages ─────────────────────────────────────
ALTER TABLE "event_spec_versions" DROP COLUMN IF EXISTS "frozenChannels";
ALTER TABLE "event_spec_versions" DROP COLUMN IF EXISTS "messageVersionIds";

-- ── 4. traits are never product level ────────────────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  ALTER TABLE "traits" ADD CONSTRAINT "traits_no_product_check" CHECK ("productId" IS NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
