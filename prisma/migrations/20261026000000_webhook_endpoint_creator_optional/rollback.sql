-- ROLLBACK of 20261026000000_webhook_endpoint_creator_optional. NEVER run automatically: neither `prisma migrate deploy` nor
-- src/lib/pglite-migrate.ts reads this file (they read migration.sql only). Application stopped; psql -v ON_ERROR_STOP=1 -f this file; then
-- DELETE FROM "_prisma_migrations" WHERE migration_name = '20261026000000_webhook_endpoint_creator_optional'  (PGlite: "_pglite_migrations", column name).
--
-- It refuses (and changes nothing) while an endpoint has no creator, which is every endpoint the REST API key made. Delete those endpoints, or give
-- each a creator, first:  UPDATE "webhook_endpoints" SET "createdBy" = '<a user id>' WHERE "createdBy" IS NULL;
ALTER TABLE "webhook_endpoints" ALTER COLUMN "createdBy" SET NOT NULL;
