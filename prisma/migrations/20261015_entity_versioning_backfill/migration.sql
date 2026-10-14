-- Phase 2a backfill (spec §5.4, Story 14.7): every ACTIVE entity that already
-- has canonical TypeSpec source gets an INITIAL 1.0 version frozen from its
-- current state; DRAFT entities (and ACTIVE ones without source) stay
-- unpublished. sequence mirrors the existing Entity.version so Int consumers
-- (EmissionTargetStatus, DeploymentRecord) keep their numbers. Legacy
-- metadata.versionHistory is left untouched. One statement guarded by
-- NOT EXISTS, so a re-run is a no-op. fields.aliases is a nullable TEXT[] with
-- no default (NULL on legacy rows), so it is coalesced to [] to match what
-- toFieldSnapshot freezes.
WITH inserted AS (
  INSERT INTO "entity_versions"
    ("id", "entityId", "major", "minor", "sequence", "resolvedSource", "fieldSnapshot",
     "changeKind", "compatReport", "changeSummary", "publishedById", "publishedAt")
  SELECT
    'ev_' || md5(e."id" || ':initial'),
    e."id",
    1,
    0,
    GREATEST(e."version", 1),
    e."typespecSource",
    COALESCE(
      (SELECT jsonb_agg(
                jsonb_build_object(
                  'id', f."id", 'name', f."name", 'type', f."type",
                  'precision', f."precision", 'scale', f."scale",
                  'nullable', f."nullable", 'isKey', f."isKey", 'fieldNumber', f."fieldNumber",
                  'description', f."description", 'classification', f."classification",
                  'aliases', COALESCE(to_jsonb(f."aliases"), '[]'::jsonb), 'decorators', COALESCE(f."decorators", '{}'::jsonb),
                  'sortOrder', f."sortOrder")
                ORDER BY f."sortOrder")
         FROM "fields" f
        WHERE f."entityId" = e."id"),
      '[]'::jsonb),
    'INITIAL'::"EntityVersionChangeKind",
    '{}'::jsonb,
    'Initial version (backfilled from ACTIVE entity)',
    e."ownerId",
    e."updatedAt"
  FROM "entities" e
  WHERE e."status" = 'ACTIVE'
    AND e."typespecSource" IS NOT NULL
    AND e."latestVersionId" IS NULL
    AND NOT EXISTS (SELECT 1 FROM "entity_versions" v WHERE v."entityId" = e."id")
  ON CONFLICT DO NOTHING
  RETURNING "id", "entityId", "sequence"
)
UPDATE "entities" e
   SET "latestVersionId" = i."id",
       "hasUnpublishedChanges" = false,
       "version" = i."sequence"
  FROM inserted i
 WHERE e."id" = i."entityId";
