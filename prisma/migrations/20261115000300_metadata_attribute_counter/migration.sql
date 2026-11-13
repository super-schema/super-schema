-- Per-tenant high-water mark of metadata attribute Protobuf option numbers (50000–99999, never reused).
CREATE TABLE "metadata_attribute_counters" (
  "tenantId" TEXT NOT NULL,
  "nextProtobufOption" INTEGER NOT NULL DEFAULT 50000,

  CONSTRAINT "metadata_attribute_counters_pkey" PRIMARY KEY ("tenantId")
);

ALTER TABLE "metadata_attribute_counters" ADD CONSTRAINT "metadata_attribute_counters_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Definitions written before numbers were assigned get one now, in creation order per tenant, and the counter starts after them.
WITH numbered AS (
  SELECT "id", 49999 + ROW_NUMBER() OVER (PARTITION BY "tenantId" ORDER BY "createdAt", "id") AS "n"
  FROM "metadata_attribute_definitions"
  WHERE "protobufOptionNumber" IS NULL
)
UPDATE "metadata_attribute_definitions" AS d
SET "protobufOptionNumber" = numbered."n"
FROM numbered
WHERE d."id" = numbered."id";

INSERT INTO "metadata_attribute_counters" ("tenantId", "nextProtobufOption")
SELECT "tenantId", MAX("protobufOptionNumber") + 1
FROM "metadata_attribute_definitions"
GROUP BY "tenantId";
