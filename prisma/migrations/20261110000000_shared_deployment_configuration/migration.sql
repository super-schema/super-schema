-- Preserve existing schema workflows and receipts; new definitions belong to a product.
ALTER TABLE "tenants" ADD COLUMN "deploymentEnvironments" TEXT[] NOT NULL DEFAULT ARRAY['development', 'staging', 'production']::TEXT[];
UPDATE "tenants" t SET "deploymentEnvironments" = ARRAY(
  SELECT DISTINCT environment FROM (
    SELECT unnest(t."deploymentEnvironments") AS environment
    UNION ALL SELECT w.environment FROM "deployment_workflows" w WHERE w."tenantId" = t.id
    UNION ALL SELECT r.environment FROM "deployment_records" r JOIN "entities" e ON split_part(r.target, ':', 1) = e.id WHERE e."tenantId" = t.id
  ) names WHERE environment <> '' ORDER BY environment
);
ALTER TABLE "deployment_workflows" ALTER COLUMN "entityId" DROP NOT NULL;
ALTER TABLE "deployment_workflows" ADD COLUMN "productId" TEXT;
ALTER TABLE "deployment_workflows" ADD CONSTRAINT "deployment_workflows_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "deployment_workflows" ADD CONSTRAINT "deployment_workflows_owner_check" CHECK (("entityId" IS NOT NULL)::int + ("productId" IS NOT NULL)::int = 1);
CREATE UNIQUE INDEX "deployment_workflows_productId_name_key" ON "deployment_workflows"("productId", "name");
CREATE INDEX "deployment_workflows_tenantId_productId_idx" ON "deployment_workflows"("tenantId", "productId");

-- New tenants use target-specific defaults. Retain methods used by pre-existing workflows.
ALTER TABLE "tenants" ADD COLUMN "deploymentTargetMethods" JSONB NOT NULL DEFAULT '{}'::jsonb;
WITH configured AS (
  SELECT w."tenantId", w.format, c.method FROM "deployment_workflows" w JOIN "deployment_connections" c ON c.id = w."connectionId"
  UNION SELECT DISTINCT "tenantId", format, 'git' FROM "deployment_workflows"
  UNION SELECT DISTINCT "tenantId", format, CASE WHEN format IN ('avro', 'json-schema', 'protobuf') THEN 'registry' ELSE 'http' END FROM "deployment_workflows"
), grouped AS (
  SELECT "tenantId", format, jsonb_agg(method ORDER BY method) AS methods FROM configured GROUP BY "tenantId", format
)
UPDATE "tenants" t SET "deploymentTargetMethods" = COALESCE((SELECT jsonb_object_agg(format, methods) FROM grouped g WHERE g."tenantId" = t.id), '{}'::jsonb);
