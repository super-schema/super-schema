-- Events core hardening (follow-up to 20261016_events_core, which is already applied and untouched):
--   1. Published Message / Event Spec versions cannot be deleted directly (UPDATE was already blocked).
--      Same pattern as 20261015_entity_versions_no_delete: Postgres runs ON DELETE CASCADE after the
--      parent row is already gone, so "parent no longer exists" is exactly the cascade case (message /
--      event spec delete, or a domain / product delete cascading through it).
--   2. AFTER DELETE triggers remove the schema_references edges *from* a deleted message / message version /
--      event spec / event spec version / trait, so cascades never leave ghost "Who uses X?" rows.
--   3. Indexes on every pin foreign-key column that lacked one (the NO ACTION FKs scan these when an
--      entity or entity version is deleted).
-- Idempotent so a partial apply can be re-run.

-- ── 1. no direct deletes of published versions ───────────────────────────────
CREATE OR REPLACE FUNCTION prevent_message_version_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "messages" WHERE "id" = OLD."messageId") THEN
    RAISE EXCEPTION 'Message versions cannot be deleted directly; they are removed only with their message';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS message_versions_no_delete ON "message_versions";
CREATE TRIGGER message_versions_no_delete
  BEFORE DELETE ON "message_versions"
  FOR EACH ROW
  EXECUTE FUNCTION prevent_message_version_delete();

CREATE OR REPLACE FUNCTION prevent_event_spec_version_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "event_specs" WHERE "id" = OLD."eventSpecId") THEN
    RAISE EXCEPTION 'Event spec versions cannot be deleted directly; they are removed only with their event spec';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS event_spec_versions_no_delete ON "event_spec_versions";
CREATE TRIGGER event_spec_versions_no_delete
  BEFORE DELETE ON "event_spec_versions"
  FOR EACH ROW
  EXECUTE FUNCTION prevent_event_spec_version_delete();

-- ── 2. schema_references edges follow their source record ────────────────────
-- TG_ARGV[0] is the SchemaReferenceFromKind of the table the trigger is attached to.
CREATE OR REPLACE FUNCTION delete_schema_references_from()
RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM "schema_references"
   WHERE "fromKind" = TG_ARGV[0]::"SchemaReferenceFromKind" AND "fromId" = OLD."id";
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS messages_delete_references ON "messages";
CREATE TRIGGER messages_delete_references
  AFTER DELETE ON "messages"
  FOR EACH ROW
  EXECUTE FUNCTION delete_schema_references_from('MESSAGE');

DROP TRIGGER IF EXISTS message_versions_delete_references ON "message_versions";
CREATE TRIGGER message_versions_delete_references
  AFTER DELETE ON "message_versions"
  FOR EACH ROW
  EXECUTE FUNCTION delete_schema_references_from('MESSAGE_VERSION');

DROP TRIGGER IF EXISTS event_specs_delete_references ON "event_specs";
CREATE TRIGGER event_specs_delete_references
  AFTER DELETE ON "event_specs"
  FOR EACH ROW
  EXECUTE FUNCTION delete_schema_references_from('EVENT_SPEC');

DROP TRIGGER IF EXISTS event_spec_versions_delete_references ON "event_spec_versions";
CREATE TRIGGER event_spec_versions_delete_references
  AFTER DELETE ON "event_spec_versions"
  FOR EACH ROW
  EXECUTE FUNCTION delete_schema_references_from('EVENT_SPEC_VERSION');

DROP TRIGGER IF EXISTS traits_delete_references ON "traits";
CREATE TRIGGER traits_delete_references
  AFTER DELETE ON "traits"
  FOR EACH ROW
  EXECUTE FUNCTION delete_schema_references_from('TRAIT');

-- ── 3. pin foreign-key indexes ───────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "messages_payloadEntityVersionId_idx" ON "messages"("payloadEntityVersionId");
CREATE INDEX IF NOT EXISTS "messages_headersEntityId_idx"        ON "messages"("headersEntityId");
CREATE INDEX IF NOT EXISTS "messages_headersEntityVersionId_idx" ON "messages"("headersEntityVersionId");
CREATE INDEX IF NOT EXISTS "messages_keyEntityId_idx"            ON "messages"("keyEntityId");
CREATE INDEX IF NOT EXISTS "messages_keyEntityVersionId_idx"     ON "messages"("keyEntityVersionId");
CREATE INDEX IF NOT EXISTS "traits_headersEntityId_idx"          ON "traits"("headersEntityId");
CREATE INDEX IF NOT EXISTS "traits_headersEntityVersionId_idx"   ON "traits"("headersEntityVersionId");
CREATE INDEX IF NOT EXISTS "message_versions_headersEntityVersionId_idx" ON "message_versions"("headersEntityVersionId");
CREATE INDEX IF NOT EXISTS "message_versions_keyEntityVersionId_idx"     ON "message_versions"("keyEntityVersionId");
