-- ROLLBACK of 20261101120000_webhook_endpoint_tenant. NEVER run automatically: neither `prisma migrate deploy` nor
-- src/lib/pglite-migrate.ts reads this file (they read migration.sql only). Application stopped; psql -v ON_ERROR_STOP=1 -f this file; then
-- DELETE FROM "_prisma_migrations" WHERE migration_name = '20261101120000_webhook_endpoint_tenant'  (PGlite: "_pglite_migrations", column name).
--
-- Dropping the column forgets which tenant each endpoint belongs to (its foreign key and index go with it). The endpoints this migration
-- deactivated stay inactive: re-activate the ones that should deliver again. Before dropping, note them:
--   SELECT "id", "createdBy" FROM "webhook_endpoints" WHERE "active" = false;
ALTER TABLE "webhook_endpoints" DROP COLUMN "tenantId";
