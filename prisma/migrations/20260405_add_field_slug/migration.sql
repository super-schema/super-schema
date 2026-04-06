-- Add slug column to fields table
ALTER TABLE "fields" ADD COLUMN "slug" TEXT NOT NULL DEFAULT '';

-- Populate slug from name: lowercase, strip non-alphanum except spaces/hyphens, replace spaces with hyphens
UPDATE "fields" SET "slug" = LOWER(REGEXP_REPLACE(REGEXP_REPLACE("name", '[^a-zA-Z0-9\s_-]', '', 'g'), '[\s]+', '-', 'g'));

-- For fields where name is already snake_case, replace underscores with hyphens in slug
UPDATE "fields" SET "slug" = REPLACE("slug", '_', '-') WHERE "slug" LIKE '%\_%';

-- Add unique constraint on (entityId, slug)
ALTER TABLE "fields" ADD CONSTRAINT "fields_entityId_slug_key" UNIQUE ("entityId", "slug");
