-- Snapshot versioning, phase 1 (SemVer MAJOR.MINOR.PATCH with a snapshot stage): entity_versions and event_spec_versions gain
-- "patch", "stage" (SNAPSHOT | RELEASED), "releasedAt" / "releasedById" and "updatedAt".
--
--   * Every existing row is a released x.y.0: ADD COLUMN ... DEFAULT fills "patch" = 0 and "stage" = 'RELEASED'; the backfill block
--     copies "publishedAt" / "publishedById" into "releasedAt" / "releasedById" (and "updatedAt").
--   * The version number unique key gains "patch"; one open SNAPSHOT per entity / event spec (partial unique index); a RELEASED row
--     always has "releasedAt" (CHECK).
--   * Immutability now applies to RELEASED rows only: an UPDATE is allowed while OLD."stage" = 'SNAPSHOT' (edit the snapshot, or promote
--     it to RELEASED), refused afterwards. DELETE rules (the *_no_delete triggers) are unchanged.
--
-- ALTER TYPE ... ADD VALUE 'PATCH' runs inside this migration's transaction (src/lib/pglite-migrate.ts wraps each file in one); a value
-- added that way cannot be *used* before the transaction commits, and nothing below uses it.
-- message_versions (which shared prevent_published_version_update) was dropped by 20261020_drop_legacy_event_catalog; only
-- event_spec_versions still uses that function.
-- Idempotent so a partial apply can be re-run. Enum values can never be dropped (rollback = leave PATCH unused).

-- ── enums ────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "VersionStage" AS ENUM ('SNAPSHOT', 'RELEASED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TYPE "EntityVersionChangeKind" ADD VALUE IF NOT EXISTS 'PATCH';

-- ── columns ──────────────────────────────────────────────────────────────────
-- "updatedAt" keeps its DEFAULT (schema: @default(now()) @updatedAt) so raw-SQL writers and the rows below get a value.
ALTER TABLE "entity_versions"
  ADD COLUMN IF NOT EXISTS "patch"        INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "stage"        "VersionStage" NOT NULL DEFAULT 'RELEASED',
  ADD COLUMN IF NOT EXISTS "releasedAt"   TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "releasedById" TEXT,
  ADD COLUMN IF NOT EXISTS "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "event_spec_versions"
  ADD COLUMN IF NOT EXISTS "patch"        INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "stage"        "VersionStage" NOT NULL DEFAULT 'RELEASED',
  ADD COLUMN IF NOT EXISTS "releasedAt"   TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "releasedById" TEXT,
  ADD COLUMN IF NOT EXISTS "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- ── backfill ─────────────────────────────────────────────────────────────────
-- The pre-existing immutability triggers refuse every UPDATE, so they are disabled around the backfill (the no-delete triggers stay on).
-- tests/integration/db/entity-versioning-pglite.test.ts runs this block (between the markers) against legacy-shaped rows.
-- BEGIN backfill
ALTER TABLE "entity_versions" DISABLE TRIGGER "entity_versions_immutable";
UPDATE "entity_versions"
   SET "releasedAt" = "publishedAt", "releasedById" = "publishedById", "updatedAt" = "publishedAt"
 WHERE "stage" = 'RELEASED' AND "releasedAt" IS NULL;
ALTER TABLE "entity_versions" ENABLE TRIGGER "entity_versions_immutable";

ALTER TABLE "event_spec_versions" DISABLE TRIGGER "event_spec_versions_immutable";
UPDATE "event_spec_versions"
   SET "releasedAt" = "publishedAt", "releasedById" = "publishedById", "updatedAt" = "publishedAt"
 WHERE "stage" = 'RELEASED' AND "releasedAt" IS NULL;
ALTER TABLE "event_spec_versions" ENABLE TRIGGER "event_spec_versions_immutable";
-- END backfill

-- ── version number unique keys gain "patch" (new key first: every old (major, minor) pair is unique, so (major, minor, 0) is) ─────
CREATE UNIQUE INDEX IF NOT EXISTS "entity_versions_entityId_major_minor_patch_key"
  ON "entity_versions"("entityId", "major", "minor", "patch");
DROP INDEX IF EXISTS "entity_versions_entityId_major_minor_key";

CREATE UNIQUE INDEX IF NOT EXISTS "event_spec_versions_eventSpecId_major_minor_patch_key"
  ON "event_spec_versions"("eventSpecId", "major", "minor", "patch");
DROP INDEX IF EXISTS "event_spec_versions_eventSpecId_major_minor_key";

-- ── one open snapshot per object ─────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS entity_versions_one_snapshot ON "entity_versions" ("entityId") WHERE "stage" = 'SNAPSHOT';
CREATE UNIQUE INDEX IF NOT EXISTS event_spec_versions_one_snapshot ON "event_spec_versions" ("eventSpecId") WHERE "stage" = 'SNAPSHOT';

-- ── foreign keys (Restrict like publishedById: SET NULL would UPDATE a released row, which the trigger refuses) ──────────────────
DO $$ BEGIN
  ALTER TABLE "entity_versions" ADD CONSTRAINT "entity_versions_releasedById_fkey" FOREIGN KEY ("releasedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "event_spec_versions" ADD CONSTRAINT "event_spec_versions_releasedById_fkey" FOREIGN KEY ("releasedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── CHECKs: numbers gain "patch" >= 0; a RELEASED row has "releasedAt" ───────
ALTER TABLE "entity_versions" DROP CONSTRAINT IF EXISTS "entity_versions_numbers_check";
ALTER TABLE "entity_versions" ADD CONSTRAINT "entity_versions_numbers_check"
  CHECK ("major" >= 1 AND "minor" >= 0 AND "patch" >= 0 AND "sequence" >= 1);
ALTER TABLE "event_spec_versions" DROP CONSTRAINT IF EXISTS "event_spec_versions_numbers_check";
ALTER TABLE "event_spec_versions" ADD CONSTRAINT "event_spec_versions_numbers_check"
  CHECK ("major" >= 1 AND "minor" >= 0 AND "patch" >= 0 AND "sequence" >= 1);

DO $$ BEGIN
  ALTER TABLE "entity_versions" ADD CONSTRAINT "entity_versions_released_check"
    CHECK ("stage" = 'SNAPSHOT' OR "releasedAt" IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "event_spec_versions" ADD CONSTRAINT "event_spec_versions_released_check"
    CHECK ("stage" = 'SNAPSHOT' OR "releasedAt" IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── immutability: only a SNAPSHOT row may be updated ─────────────────────────
-- The existing BEFORE UPDATE triggers (entity_versions_immutable, event_spec_versions_immutable) keep calling these functions.
-- Promotion (SNAPSHOT -> RELEASED) is allowed because OLD is still a snapshot; any later UPDATE of the row is refused.
CREATE OR REPLACE FUNCTION prevent_entity_version_update()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."stage" = 'SNAPSHOT' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Released versions are immutable; save a new snapshot instead';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION prevent_published_version_update()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."stage" = 'SNAPSHOT' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Released versions are immutable; save a new snapshot instead';
END;
$$ LANGUAGE plpgsql;
