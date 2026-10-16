-- Event document v2 (spec 2026-10-15 §10), part 2/2: published event versions store their fully resolved spec
-- (the ResolvedEventSpec, artifacts included) so external refs can reuse a referenced item without re-rendering.
-- Nullable: versions published before document v2 have none. event_spec_versions is immutable (BEFORE UPDATE
-- trigger) — new versions INSERT the value; it is never updated. ADD COLUMN without a default does not rewrite
-- the table or fire row triggers. Idempotent so a partial apply can be re-run.
ALTER TABLE "event_spec_versions" ADD COLUMN IF NOT EXISTS "resolvedSpec" JSONB;
