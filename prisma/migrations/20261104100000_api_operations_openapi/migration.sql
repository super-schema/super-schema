-- API operations speak the OpenAPI 3.1 Operation subset in src/types/schemas/api-operation.ts:
-- operations gain operationId / summary / tags / deprecated / requestBody; parameters and responses gain isArray (and
-- responses a contentType); both get a sortOrder so the editor's order survives a reload.
-- Backfill: a legacy parameter with location "body" is not an OpenAPI parameter. The first one of each operation becomes
-- that operation's requestBody, then every "body" parameter row is removed.

-- AlterTable
ALTER TABLE "operation_parameters" ADD COLUMN IF NOT EXISTS "isArray" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "operation_parameters" ADD COLUMN IF NOT EXISTS "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "operation_responses" ADD COLUMN IF NOT EXISTS "contentType" TEXT NOT NULL DEFAULT 'application/json';
ALTER TABLE "operation_responses" ADD COLUMN IF NOT EXISTS "isArray" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "operation_responses" ADD COLUMN IF NOT EXISTS "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "operations" ADD COLUMN IF NOT EXISTS "deprecated" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "operations" ADD COLUMN IF NOT EXISTS "operationId" TEXT;
ALTER TABLE "operations" ADD COLUMN IF NOT EXISTS "requestBody" JSONB;
ALTER TABLE "operations" ADD COLUMN IF NOT EXISTS "summary" TEXT NOT NULL DEFAULT '';
ALTER TABLE "operations" ADD COLUMN IF NOT EXISTS "tags" JSONB NOT NULL DEFAULT '[]';

-- Backfill: legacy "body" parameters -> operations.requestBody (first one per operation, by id).
UPDATE "operations" AS o
SET "requestBody" = jsonb_build_object(
  'type', b."type",
  'isArray', false,
  'contentType', 'application/json',
  'required', b."required",
  'description', b."description"
)
FROM (
  SELECT DISTINCT ON ("operationId") "operationId", "type", "required", "description"
  FROM "operation_parameters"
  WHERE "location" = 'body'
  ORDER BY "operationId", "id"
) AS b
WHERE o."id" = b."operationId" AND o."requestBody" IS NULL;

DELETE FROM "operation_parameters" WHERE "location" = 'body';

-- Backfill: keep the existing (id) order of parameters and responses explicit.
UPDATE "operation_parameters" AS p
SET "sortOrder" = r.n
FROM (SELECT "id", (ROW_NUMBER() OVER (PARTITION BY "operationId" ORDER BY "id") - 1)::int AS n FROM "operation_parameters") AS r
WHERE p."id" = r."id";

UPDATE "operation_responses" AS p
SET "sortOrder" = r.n
FROM (SELECT "id", (ROW_NUMBER() OVER (PARTITION BY "operationId" ORDER BY "id") - 1)::int AS n FROM "operation_responses") AS r
WHERE p."id" = r."id";
