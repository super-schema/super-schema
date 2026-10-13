-- Per-(entity,target) format options for schema authoring (starting with Avro).
-- Lives on the existing emission-target-status row rather than on the core
-- field decorators, so SuperSchemaModel stays format-agnostic.
ALTER TABLE "emission_target_statuses" ADD COLUMN IF NOT EXISTS "formatOptions" JSONB;
