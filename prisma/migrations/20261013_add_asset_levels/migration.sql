-- Asset levels (spec §4.2): Tenant / Domain / Product placement for Data Types,
-- Entities and APIs. Level is derived: productId → PRODUCT, else domainId →
-- DOMAIN, else TENANT. Idempotent so a partial apply can be re-run.

-- ── tenantId columns + backfill from the parent domain ──────────────────────
ALTER TABLE "entities"            ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "shared_enums"        ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "custom_scalars"      ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "union_types"         ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "service_definitions" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;

UPDATE "entities" t            SET "tenantId" = d."tenantId" FROM "domains" d WHERE t."domainId" = d."id" AND t."tenantId" IS NULL;
UPDATE "shared_enums" t        SET "tenantId" = d."tenantId" FROM "domains" d WHERE t."domainId" = d."id" AND t."tenantId" IS NULL;
UPDATE "custom_scalars" t      SET "tenantId" = d."tenantId" FROM "domains" d WHERE t."domainId" = d."id" AND t."tenantId" IS NULL;
UPDATE "union_types" t         SET "tenantId" = d."tenantId" FROM "domains" d WHERE t."domainId" = d."id" AND t."tenantId" IS NULL;
UPDATE "service_definitions" t SET "tenantId" = d."tenantId" FROM "domains" d WHERE t."domainId" = d."id" AND t."tenantId" IS NULL;

ALTER TABLE "entities"            ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "shared_enums"        ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "custom_scalars"      ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "union_types"         ALTER COLUMN "tenantId" SET NOT NULL;
ALTER TABLE "service_definitions" ALTER COLUMN "tenantId" SET NOT NULL;

-- ── productId on data types + APIs ───────────────────────────────────────────
ALTER TABLE "shared_enums"        ADD COLUMN IF NOT EXISTS "productId" TEXT;
ALTER TABLE "custom_scalars"      ADD COLUMN IF NOT EXISTS "productId" TEXT;
ALTER TABLE "union_types"         ADD COLUMN IF NOT EXISTS "productId" TEXT;
ALTER TABLE "service_definitions" ADD COLUMN IF NOT EXISTS "productId" TEXT;

-- ── nullable domain/product for tenant-level rows ────────────────────────────
ALTER TABLE "entities"       ALTER COLUMN "domainId"  DROP NOT NULL;
ALTER TABLE "entities"       ALTER COLUMN "productId" DROP NOT NULL;
ALTER TABLE "shared_enums"   ALTER COLUMN "domainId"  DROP NOT NULL;
ALTER TABLE "custom_scalars" ALTER COLUMN "domainId"  DROP NOT NULL;
ALTER TABLE "union_types"    ALTER COLUMN "domainId"  DROP NOT NULL;

-- ── foreign keys ─────────────────────────────────────────────────────────────
DO $$ BEGIN
  ALTER TABLE "entities" ADD CONSTRAINT "entities_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "shared_enums" ADD CONSTRAINT "shared_enums_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "shared_enums" ADD CONSTRAINT "shared_enums_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "custom_scalars" ADD CONSTRAINT "custom_scalars_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "custom_scalars" ADD CONSTRAINT "custom_scalars_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "union_types" ADD CONSTRAINT "union_types_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "union_types" ADD CONSTRAINT "union_types_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "service_definitions" ADD CONSTRAINT "service_definitions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "service_definitions" ADD CONSTRAINT "service_definitions_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── placement CHECK constraints (spec §4.1) ──────────────────────────────────
DO $$ BEGIN
  ALTER TABLE "entities" ADD CONSTRAINT "entities_level_check"
    CHECK (("productId" IS NULL AND "domainId" IS NULL) OR ("productId" IS NOT NULL AND "domainId" IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "shared_enums" ADD CONSTRAINT "shared_enums_level_check" CHECK ("productId" IS NULL OR "domainId" IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "custom_scalars" ADD CONSTRAINT "custom_scalars_level_check" CHECK ("productId" IS NULL OR "domainId" IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "union_types" ADD CONSTRAINT "union_types_level_check" CHECK ("productId" IS NULL OR "domainId" IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
-- service_definitions: domainId already NOT NULL → domain or product only.

-- ── uniqueness moves to the name registry (line uniqueness, spec §4.3) ───────
DROP INDEX IF EXISTS "shared_enums_name_domainId_key";
DROP INDEX IF EXISTS "custom_scalars_name_domainId_key";
DROP INDEX IF EXISTS "union_types_name_domainId_key";
DROP INDEX IF EXISTS "service_definitions_name_domainId_key";

CREATE INDEX IF NOT EXISTS "entities_tenantId_idx"             ON "entities"("tenantId");
CREATE INDEX IF NOT EXISTS "shared_enums_tenantId_idx"         ON "shared_enums"("tenantId");
CREATE INDEX IF NOT EXISTS "shared_enums_domainId_idx"         ON "shared_enums"("domainId");
CREATE INDEX IF NOT EXISTS "shared_enums_productId_idx"        ON "shared_enums"("productId");
CREATE INDEX IF NOT EXISTS "custom_scalars_tenantId_idx"       ON "custom_scalars"("tenantId");
CREATE INDEX IF NOT EXISTS "custom_scalars_domainId_idx"       ON "custom_scalars"("domainId");
CREATE INDEX IF NOT EXISTS "custom_scalars_productId_idx"      ON "custom_scalars"("productId");
CREATE INDEX IF NOT EXISTS "union_types_tenantId_idx"          ON "union_types"("tenantId");
CREATE INDEX IF NOT EXISTS "union_types_domainId_idx"          ON "union_types"("domainId");
CREATE INDEX IF NOT EXISTS "union_types_productId_idx"         ON "union_types"("productId");
CREATE INDEX IF NOT EXISTS "service_definitions_tenantId_idx"  ON "service_definitions"("tenantId");
CREATE INDEX IF NOT EXISTS "service_definitions_productId_idx" ON "service_definitions"("productId");
