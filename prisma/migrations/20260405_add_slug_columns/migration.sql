-- Add slug columns with defaults, then set values, then make unique

-- Domain: add slug column with default
ALTER TABLE "domains" ADD COLUMN "slug" TEXT NOT NULL DEFAULT '';

-- Populate slugs from names
UPDATE "domains" SET "slug" = LOWER(REGEXP_REPLACE(REGEXP_REPLACE("name", '[^a-zA-Z0-9\s-]', '', 'g'), '\s+', '-', 'g'));

-- Add unique constraint
ALTER TABLE "domains" ADD CONSTRAINT "domains_slug_key" UNIQUE ("slug");

-- Entity: add slug column with default
ALTER TABLE "entities" ADD COLUMN "slug" TEXT NOT NULL DEFAULT '';

-- Populate slugs from names
UPDATE "entities" SET "slug" = LOWER(REGEXP_REPLACE(REGEXP_REPLACE("name", '[^a-zA-Z0-9\s-]', '', 'g'), '\s+', '-', 'g'));

-- Add unique constraint (per domain)
ALTER TABLE "entities" ADD CONSTRAINT "entities_slug_domainId_key" UNIQUE ("slug", "domainId");
