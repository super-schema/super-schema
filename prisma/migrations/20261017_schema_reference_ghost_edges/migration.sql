-- Ghost schema_references edges from deleted entity versions (hardening H1).
--
-- 20261016_events_core_no_delete added AFTER DELETE triggers that remove the edges *from* a deleted message /
-- message version / event spec / event spec version / trait, but not from an entity version: an entity version
-- only disappears together with its entity (20261015_entity_versions_no_delete allows the delete exactly when the
-- parent entity is already gone — entity delete, or a domain / product delete cascading through it), and the
-- ENTITY_VERSION -> ENTITY_VERSION "FIELD" edges written at publish (src/services/entity-version.service.ts)
-- stayed behind. They made "Who uses X?" and delete guards list referrers that no longer exist.
--
--   1. AFTER DELETE trigger on "entity_versions" removing the edges whose source is the deleted version.
--      It is a separate AFTER trigger: the BEFORE DELETE guard (entity_versions_no_delete) still decides whether
--      the delete may happen at all, and a rejected delete rolls the whole statement back, edges included.
--   2. One-time cleanup of the ghost edges already left behind by earlier entity / domain / product deletes.
--
-- Idempotent so a partial apply can be re-run. Plain PL/pgSQL (applied in-process on PGlite by
-- src/lib/pglite-migrate.ts, which wraps the file in a transaction — no BEGIN / COMMIT here).

-- ── 1. edges follow their source entity version ──────────────────────────────
CREATE OR REPLACE FUNCTION delete_entity_version_references()
RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM "schema_references"
   WHERE "fromKind" = 'ENTITY_VERSION'::"SchemaReferenceFromKind" AND "fromId" = OLD."id";
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS entity_versions_delete_references ON "entity_versions";
CREATE TRIGGER entity_versions_delete_references
  AFTER DELETE ON "entity_versions"
  FOR EACH ROW
  EXECUTE FUNCTION delete_entity_version_references();

-- ── 2. one-time cleanup of existing ghost edges ──────────────────────────────
DELETE FROM "schema_references" sr
 WHERE sr."fromKind" = 'ENTITY_VERSION'::"SchemaReferenceFromKind"
   AND NOT EXISTS (SELECT 1 FROM "entity_versions" ev WHERE ev."id" = sr."fromId");
