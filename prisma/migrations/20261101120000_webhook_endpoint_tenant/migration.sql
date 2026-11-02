-- webhook_endpoints.tenantId: an endpoint belongs to one tenant, and it is sent the events of that tenant only (dispatchEvent).
-- Before this column every endpoint received every tenant's events, because it belonged to no tenant. Additive: one nullable column, a foreign key
-- to tenants (ON DELETE CASCADE, as the tenant's other rows) and its index.
--
-- BACKFILL (the endpoints that exist now). An endpoint names the user who created it (createdBy), and that user's roles name their tenants
-- (user_roles.tenantId; a domain or product role names its tenant too). The rule reads the roles as they stand now:
--   1. The creator's roles name EXACTLY ONE tenant: the endpoint belongs to that tenant.
--   2. Anything else cannot be attributed and is not guessed: no creator (an endpoint the REST API key made), a creator who holds only platform
--      roles (a global role names no tenant), or a creator whose roles span more than one tenant. Those keep tenantId NULL and are DEACTIVATED
--      (active = false): the row and its deliveries stay, but no event reaches them until an administrator gives them a tenant:
--      UPDATE "webhook_endpoints" SET "tenantId" = '<tenant id>', "active" = true WHERE "id" = '<endpoint id>';

ALTER TABLE "webhook_endpoints" ADD COLUMN "tenantId" TEXT;

UPDATE "webhook_endpoints" AS w
   SET "tenantId" = (
     SELECT MIN(ur."tenantId")
       FROM "user_roles" AS ur
      WHERE ur."userId" = w."createdBy" AND ur."tenantId" IS NOT NULL
      HAVING COUNT(DISTINCT ur."tenantId") = 1
   )
 WHERE w."createdBy" IS NOT NULL;

UPDATE "webhook_endpoints" SET "active" = false WHERE "tenantId" IS NULL;

ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "webhook_endpoints_tenantId_idx" ON "webhook_endpoints"("tenantId");
