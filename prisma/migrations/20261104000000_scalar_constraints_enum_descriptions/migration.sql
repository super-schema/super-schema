-- Shared custom scalars keep the logical type and the validation constraints of the schema they were imported from (JSON Schema
-- primitive-only schemas), and shared enums keep per-symbol descriptions (JSON Schema `x-enum`).
-- Additive only: nullable columns, no existing row is touched.

-- AlterTable
ALTER TABLE "custom_scalars" ADD COLUMN IF NOT EXISTS "logicalType" TEXT;
ALTER TABLE "custom_scalars" ADD COLUMN IF NOT EXISTS "constraints" JSONB;

-- AlterTable
ALTER TABLE "shared_enums" ADD COLUMN IF NOT EXISTS "valueDescriptions" JSONB;
