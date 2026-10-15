-- Entity versions are immutable (20261015_entity_versioning blocks UPDATE); this also blocks
-- direct DELETE. A version may only disappear together with its entity: Postgres runs the
-- ON DELETE CASCADE after the parent row is already gone, so "parent no longer exists" is
-- exactly the cascade case (entity delete, or domain/product delete cascading through it).
-- Idempotent so a partial apply can be re-run.

CREATE OR REPLACE FUNCTION prevent_entity_version_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "entities" WHERE "id" = OLD."entityId") THEN
    RAISE EXCEPTION 'Entity versions cannot be deleted directly; they are removed only with their entity';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS entity_versions_no_delete ON "entity_versions";
CREATE TRIGGER entity_versions_no_delete
  BEFORE DELETE ON "entity_versions"
  FOR EACH ROW
  EXECUTE FUNCTION prevent_entity_version_delete();
