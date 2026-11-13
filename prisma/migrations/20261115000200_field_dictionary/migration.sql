-- Tenant field dictionary. Existing fields are untouched (dictionaryEntryId is nullable).
CREATE TABLE "field_dictionary_entries" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "aliases" TEXT[],
  "type" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "classification" TEXT,
  "attributes" JSONB NOT NULL DEFAULT '{}',
  "conceptId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "field_dictionary_entries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "field_dictionary_entries_tenantId_name_key" ON "field_dictionary_entries"("tenantId", "name");

ALTER TABLE "field_dictionary_entries" ADD CONSTRAINT "field_dictionary_entries_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "fields" ADD COLUMN "dictionaryEntryId" TEXT;

ALTER TABLE "fields" ADD CONSTRAINT "fields_dictionaryEntryId_fkey" FOREIGN KEY ("dictionaryEntryId") REFERENCES "field_dictionary_entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
