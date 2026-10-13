-- Tenant / Product hierarchy: Tenant > Domain > Product > Entity > Field
-- Backfills existing data with assumed defaults (single default tenant, one
-- default product per existing domain). Written idempotently so a partial
-- apply can be safely re-run.

-- ── New tables ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "tenants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "product_tiers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayColor" TEXT NOT NULL DEFAULT '#6b7280',
    "bgColor" TEXT NOT NULL DEFAULT '#f3f4f6',
    "textColor" TEXT NOT NULL DEFAULT '#111827',
    "description" TEXT NOT NULL DEFAULT '',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "product_tiers_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "products" (
    "id" TEXT NOT NULL,
    "domainId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "tierId" TEXT,
    "ownerTeam" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- ── Seed: default tenant + tier taxonomy ─────────────────────────────────────
INSERT INTO "tenants" ("id","name","slug","description","isSystem","updatedAt")
VALUES ('tenant_default','Default Tenant','default','Auto-created during tenant/product migration',true,CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "product_tiers" ("id","name","displayColor","bgColor","textColor","description","sortOrder","isSystem","updatedAt") VALUES
  ('tier_1','TIER_1','#dc2626','#fef2f2','#7f1d1d','Mission-critical',1,true,CURRENT_TIMESTAMP),
  ('tier_2','TIER_2','#d97706','#fffbeb','#78350f','Business-important',2,true,CURRENT_TIMESTAMP),
  ('tier_3','TIER_3','#16a34a','#f0fdf4','#14532d','Standard',3,true,CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

-- ── domains.tenantId ─────────────────────────────────────────────────────────
ALTER TABLE "domains" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
UPDATE "domains" SET "tenantId" = 'tenant_default' WHERE "tenantId" IS NULL;
ALTER TABLE "domains" ALTER COLUMN "tenantId" SET NOT NULL;

-- ── one default product per existing domain ──────────────────────────────────
INSERT INTO "products" ("id","domainId","name","slug","description","isSystem","updatedAt")
SELECT 'prd_' || d."id", d."id", 'Default', 'default',
       'Auto-created default product during tenant/product migration', true, CURRENT_TIMESTAMP
FROM "domains" d
WHERE NOT EXISTS (
  SELECT 1 FROM "products" p WHERE p."domainId" = d."id" AND p."slug" = 'default'
);

-- ── entities.productId ───────────────────────────────────────────────────────
ALTER TABLE "entities" ADD COLUMN IF NOT EXISTS "productId" TEXT;
UPDATE "entities" e
SET "productId" = p."id"
FROM "products" p
WHERE p."domainId" = e."domainId" AND p."slug" = 'default' AND e."productId" IS NULL;
ALTER TABLE "entities" ALTER COLUMN "productId" SET NOT NULL;

-- ── user_roles.tenantId / productId ──────────────────────────────────────────
ALTER TABLE "user_roles" ADD COLUMN IF NOT EXISTS "productId" TEXT;
ALTER TABLE "user_roles" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
UPDATE "user_roles" ur
SET "tenantId" = d."tenantId"
FROM "domains" d
WHERE ur."domainId" = d."id" AND ur."tenantId" IS NULL;

-- ── swap unique indexes (drop whichever form exists) ─────────────────────────
ALTER TABLE "domains" DROP CONSTRAINT IF EXISTS "domains_name_key";
ALTER TABLE "domains" DROP CONSTRAINT IF EXISTS "domains_slug_key";
ALTER TABLE "entities" DROP CONSTRAINT IF EXISTS "entities_name_domainId_key";
ALTER TABLE "entities" DROP CONSTRAINT IF EXISTS "entities_slug_domainId_key";
ALTER TABLE "user_roles" DROP CONSTRAINT IF EXISTS "user_roles_userId_role_domainId_key";
DROP INDEX IF EXISTS "domains_name_key";
DROP INDEX IF EXISTS "domains_slug_key";
DROP INDEX IF EXISTS "entities_name_domainId_key";
DROP INDEX IF EXISTS "entities_slug_domainId_key";
DROP INDEX IF EXISTS "user_roles_userId_role_domainId_key";

CREATE UNIQUE INDEX IF NOT EXISTS "tenants_name_key" ON "tenants"("name");
CREATE UNIQUE INDEX IF NOT EXISTS "tenants_slug_key" ON "tenants"("slug");
CREATE UNIQUE INDEX IF NOT EXISTS "product_tiers_name_key" ON "product_tiers"("name");
CREATE UNIQUE INDEX IF NOT EXISTS "products_slug_domainId_key" ON "products"("slug", "domainId");
CREATE UNIQUE INDEX IF NOT EXISTS "products_name_domainId_key" ON "products"("name", "domainId");
CREATE UNIQUE INDEX IF NOT EXISTS "domains_slug_tenantId_key" ON "domains"("slug", "tenantId");
CREATE UNIQUE INDEX IF NOT EXISTS "domains_name_tenantId_key" ON "domains"("name", "tenantId");
CREATE UNIQUE INDEX IF NOT EXISTS "entities_slug_productId_key" ON "entities"("slug", "productId");
CREATE UNIQUE INDEX IF NOT EXISTS "entities_name_productId_key" ON "entities"("name", "productId");
CREATE UNIQUE INDEX IF NOT EXISTS "user_roles_userId_role_tenantId_domainId_productId_key" ON "user_roles"("userId", "role", "tenantId", "domainId", "productId");

-- ── foreign keys (drop-then-add for idempotency) ─────────────────────────────
ALTER TABLE "domains" DROP CONSTRAINT IF EXISTS "domains_tenantId_fkey";
ALTER TABLE "domains" ADD CONSTRAINT "domains_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "products" DROP CONSTRAINT IF EXISTS "products_domainId_fkey";
ALTER TABLE "products" ADD CONSTRAINT "products_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "domains"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "products" DROP CONSTRAINT IF EXISTS "products_tierId_fkey";
ALTER TABLE "products" ADD CONSTRAINT "products_tierId_fkey" FOREIGN KEY ("tierId") REFERENCES "product_tiers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "entities" DROP CONSTRAINT IF EXISTS "entities_productId_fkey";
ALTER TABLE "entities" ADD CONSTRAINT "entities_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_roles" DROP CONSTRAINT IF EXISTS "user_roles_tenantId_fkey";
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_roles" DROP CONSTRAINT IF EXISTS "user_roles_productId_fkey";
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
