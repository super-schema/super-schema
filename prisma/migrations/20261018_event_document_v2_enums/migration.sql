-- Event document v2 (spec 2026-10-15 §6, §10), part 1/2: external event references are schema_references edges
-- with toKind = EVENT_SPEC_VERSION (role MESSAGE).
--
-- Its own file on purpose: src/lib/pglite-migrate.ts wraps every migration file in a transaction (and Prisma migrate
-- runs one file as one multi-statement script), and a value added by ALTER TYPE ... ADD VALUE cannot be *used* until
-- that transaction commits. Nothing here may use the new value; 20261018_event_document_v2_columns and later code do.
-- Idempotent so a partial apply can be re-run. Enum values can never be dropped (rollback = leave it unused).
ALTER TYPE "SchemaReferenceToKind" ADD VALUE IF NOT EXISTS 'EVENT_SPEC_VERSION';
