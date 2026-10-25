-- ROLLBACK of 20261025230000_access_control. Documented in docs/database.md. NEVER run automatically: neither `prisma migrate deploy`
-- nor src/lib/pglite-migrate.ts reads this file (they read migration.sql only).
--
-- When: only to go back to an application version that predates access control, and only with the application stopped.
-- How (PostgreSQL):  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/migrations/20261025230000_access_control/rollback.sql
--                    (the file is its own transaction: it either completes or changes nothing)
--                    then tell Prisma the migration is no longer applied (`prisma migrate resolve --rolled-back` refuses a migration that
--                    succeeded, P3012, so remove its record):
--                    DELETE FROM "_prisma_migrations" WHERE migration_name = '20261025230000_access_control';
-- How (PGlite):      run this file with the same PGlite handle that holds the data directory, then
--                    DELETE FROM "_pglite_migrations" WHERE name = '20261025230000_access_control'.
--
-- Not reversible, said plainly:
--   * invitations, their roles, auth_tokens and auth_events are DROPPED with their rows (export them first if you need them);
--   * audit_log.tenantId is dropped (it was derived; the audit rows themselves are untouched);
--   * users' e-mails stay trimmed and lower-cased;
--   * a role row the old model cannot express is NOT left in user_roles, because the old code would read it as something wider (a
--     tenant-scoped row has no domain, which the old code treats as global; a product-scoped row would read as its whole domain). Such
--     rows (tenant and product scopes, which include the ones converted from old global non-admin roles) are copied to the table
--     user_roles_access_control_backup, then removed from user_roles. Narrowing is safe; widening is not. Re-grant them by hand;
--   * a user who was DISABLED would be enabled again by dropping the column, so their password hash is cleared first: they cannot sign in
--     with a password until an administrator sets one (a Google account is unaffected by this, and was never disable-able before).

BEGIN;

-- ── invitations, tokens, events ────────────────────────────────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS "invitation_roles";
DROP TABLE IF EXISTS "invitations";
DROP TABLE IF EXISTS "auth_tokens";
DROP TABLE IF EXISTS "auth_events";
DROP TYPE IF EXISTS "AuthTokenKind";

-- ── audit_log ──────────────────────────────────────────────────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS "audit_log_tenantId_timestamp_idx";
ALTER TABLE "audit_log" DROP COLUMN IF EXISTS "tenantId";

-- ── user_roles ─────────────────────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "user_roles_access_control_backup" AS
  SELECT * FROM "user_roles" WHERE false;

INSERT INTO "user_roles_access_control_backup"
  SELECT * FROM "user_roles" WHERE "scopeKey" LIKE 'T:%' OR "scopeKey" LIKE 'P:%';

DELETE FROM "user_roles" WHERE "scopeKey" LIKE 'T:%' OR "scopeKey" LIKE 'P:%';

ALTER TABLE "user_roles" DROP CONSTRAINT IF EXISTS "user_roles_grantedById_fkey";
ALTER TABLE "user_roles" DROP CONSTRAINT IF EXISTS "user_roles_scope_columns_check";
ALTER TABLE "user_roles" DROP CONSTRAINT IF EXISTS "user_roles_scope_key_shape_check";
DROP INDEX IF EXISTS "user_roles_scopeKey_idx";
DROP INDEX IF EXISTS "user_roles_userId_role_scopeKey_key";
ALTER TABLE "user_roles" DROP COLUMN IF EXISTS "grantedById";
ALTER TABLE "user_roles" DROP COLUMN IF EXISTS "scopeKey";
CREATE UNIQUE INDEX IF NOT EXISTS "user_roles_userId_role_tenantId_domainId_productId_key"
  ON "user_roles"("userId", "role", "tenantId", "domainId", "productId");

-- ── users ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS "users_email_lower_key";
UPDATE "users" SET "password" = NULL WHERE "disabledAt" IS NOT NULL;
ALTER TABLE "users" DROP COLUMN IF EXISTS "disabledAt";
ALTER TABLE "users" DROP COLUMN IF EXISTS "lastLoginAt";

COMMIT;
