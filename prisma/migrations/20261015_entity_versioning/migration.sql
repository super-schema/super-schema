-- Entity versioning, Phase 2a (spec §5.1, §6.1): immutable entity_versions,
-- draft pointers on entities, and the schema_references edge table.
-- Idempotent so a partial apply can be re-run.

-- ── enums ────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "EntityVersionChangeKind" AS ENUM ('INITIAL', 'MINOR', 'MAJOR');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "SchemaReferenceFromKind" AS ENUM ('ENTITY_VERSION', 'MESSAGE', 'MESSAGE_VERSION', 'EVENT_SPEC', 'EVENT_SPEC_VERSION', 'TRAIT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "SchemaReferenceRole" AS ENUM ('FIELD', 'PAYLOAD', 'HEADERS', 'KEY', 'MESSAGE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  CREATE TYPE "SchemaReferenceToKind" AS ENUM ('ENTITY_VERSION', 'MESSAGE_VERSION');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── entity_versions ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "entity_versions" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "major" INTEGER NOT NULL,
    "minor" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL,
    "resolvedSource" TEXT NOT NULL,
    "fieldSnapshot" JSONB NOT NULL,
    "changeKind" "EntityVersionChangeKind" NOT NULL,
    "compatReport" JSONB NOT NULL DEFAULT '{}',
    "changeSummary" TEXT,
    "publishedById" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "governanceRequestId" TEXT,
    CONSTRAINT "entity_versions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "entity_versions_entityId_major_minor_key" ON "entity_versions"("entityId", "major", "minor");
CREATE UNIQUE INDEX IF NOT EXISTS "entity_versions_entityId_sequence_key"    ON "entity_versions"("entityId", "sequence");

DO $$ BEGIN
  ALTER TABLE "entity_versions" ADD CONSTRAINT "entity_versions_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "entity_versions" ADD CONSTRAINT "entity_versions_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "entity_versions" ADD CONSTRAINT "entity_versions_numbers_check"
    CHECK ("major" >= 1 AND "minor" >= 0 AND "sequence" >= 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Immutable: a published version is never edited (publish a new one instead).
-- DELETE stays allowed so deleting an entity cascades its versions.
CREATE OR REPLACE FUNCTION prevent_entity_version_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Entity versions are immutable; publish a new version instead';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS entity_versions_immutable ON "entity_versions";
CREATE TRIGGER entity_versions_immutable
  BEFORE UPDATE ON "entity_versions"
  FOR EACH ROW
  EXECUTE FUNCTION prevent_entity_version_update();

-- ── draft pointers on entities ───────────────────────────────────────────────
ALTER TABLE "entities" ADD COLUMN IF NOT EXISTS "latestVersionId" TEXT;
ALTER TABLE "entities" ADD COLUMN IF NOT EXISTS "hasUnpublishedChanges" BOOLEAN NOT NULL DEFAULT true;

CREATE UNIQUE INDEX IF NOT EXISTS "entities_latestVersionId_key" ON "entities"("latestVersionId");

DO $$ BEGIN
  ALTER TABLE "entities" ADD CONSTRAINT "entities_latestVersionId_fkey" FOREIGN KEY ("latestVersionId") REFERENCES "entity_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── schema_references (spec §6.1) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "schema_references" (
    "id" TEXT NOT NULL,
    "fromKind" "SchemaReferenceFromKind" NOT NULL,
    "fromId" TEXT NOT NULL,
    "role" "SchemaReferenceRole" NOT NULL,
    "toKind" "SchemaReferenceToKind" NOT NULL,
    "toId" TEXT NOT NULL,
    "isDraft" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "schema_references_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "schema_references_fromKind_fromId_role_toKind_toId_key"
  ON "schema_references"("fromKind", "fromId", "role", "toKind", "toId");
CREATE INDEX IF NOT EXISTS "schema_references_toKind_toId_idx"     ON "schema_references"("toKind", "toId");
CREATE INDEX IF NOT EXISTS "schema_references_fromKind_fromId_idx" ON "schema_references"("fromKind", "fromId");
