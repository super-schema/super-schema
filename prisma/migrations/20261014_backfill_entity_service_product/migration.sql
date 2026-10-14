-- Entity-scoped APIs live at their entity's product scope (spec §4.2): the
-- server derives the placement from the owning entity. Services created before
-- 20261013_add_asset_levels were left with a NULL productId (that migration only
-- added the column), so they surfaced as domain-level APIs. Move them to the
-- product of the entity they belong to. Idempotent: only touches rows that are
-- still unplaced, so a re-run is a no-op.
UPDATE "service_definitions" s
   SET "productId" = e."productId"
  FROM "entities" e
 WHERE s."entityId" = e."id"
   AND s."scope" = 'ENTITY'
   AND s."productId" IS NULL
   AND e."productId" IS NOT NULL;
