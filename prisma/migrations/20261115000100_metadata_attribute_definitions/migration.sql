-- Tenant-defined metadata attribute dictionary (x-* keys). No existing content is changed.
CREATE TABLE "metadata_attribute_definitions" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "valueSchema" JSONB NOT NULL,
  "targets" TEXT[],
  "scope" TEXT NOT NULL DEFAULT 'schema',
  "placement" TEXT NOT NULL DEFAULT 'field',
  "derive" JSONB,
  "requiredWhen" TEXT NOT NULL DEFAULT 'never',
  "pack" TEXT,
  "protobufOptionNumber" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "metadata_attribute_definitions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "metadata_attribute_definitions_tenantId_key_key" ON "metadata_attribute_definitions"("tenantId", "key");
CREATE UNIQUE INDEX "metadata_attribute_definitions_tenantId_protobufOptionNumber_key" ON "metadata_attribute_definitions"("tenantId", "protobufOptionNumber");

ALTER TABLE "metadata_attribute_definitions" ADD CONSTRAINT "metadata_attribute_definitions_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
