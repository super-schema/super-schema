-- Events core (Epic 18, spec §6.1): channels, channel_messages, traits, messages,
-- message_versions, event_specs, event_spec_versions. Pins reuse schema_references
-- (Track B). Idempotent so a partial apply can be re-run.

-- ── enum ─────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "TraitKind" AS ENUM ('MESSAGE', 'OPERATION');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── tables ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "channels" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "protocol" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "formatDialect" TEXT,
    "spec" JSONB NOT NULL DEFAULT '{}',
    "tenantId" TEXT NOT NULL,
    "domainId" TEXT,
    "productId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "channels_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "traits" (
    "id" TEXT NOT NULL,
    "kind" "TraitKind" NOT NULL,
    "name" TEXT NOT NULL,
    "spec" JSONB NOT NULL DEFAULT '{}',
    "headersEntityId" TEXT,
    "headersEntityVersionId" TEXT,
    "tenantId" TEXT NOT NULL,
    "domainId" TEXT,
    "productId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "traits_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "messages" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "spec" JSONB NOT NULL DEFAULT '{}',
    "payloadEntityId" TEXT NOT NULL,
    "payloadEntityVersionId" TEXT,
    "headersEntityId" TEXT,
    "headersEntityVersionId" TEXT,
    "keyEntityId" TEXT,
    "keyEntityVersionId" TEXT,
    "latestVersionId" TEXT,
    "hasUnpublishedChanges" BOOLEAN NOT NULL DEFAULT true,
    "tenantId" TEXT NOT NULL,
    "domainId" TEXT,
    "productId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "channel_messages" (
    "channelId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "channel_messages_pkey" PRIMARY KEY ("channelId", "messageId")
);

CREATE TABLE IF NOT EXISTS "message_versions" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "major" INTEGER NOT NULL,
    "minor" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL,
    "resolvedSpec" JSONB NOT NULL,
    "payloadEntityVersionId" TEXT NOT NULL,
    "headersEntityVersionId" TEXT,
    "keyEntityVersionId" TEXT,
    "changeKind" "EntityVersionChangeKind" NOT NULL,
    "compatReport" JSONB NOT NULL DEFAULT '{}',
    "changeSummary" TEXT,
    "publishedById" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "governanceRequestId" TEXT,
    CONSTRAINT "message_versions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "event_specs" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "specType" TEXT NOT NULL DEFAULT 'asyncapi@3.0',
    "document" JSONB NOT NULL,
    "latestVersionId" TEXT,
    "hasUnpublishedChanges" BOOLEAN NOT NULL DEFAULT true,
    "importedSource" TEXT,
    "sourceVersion" TEXT,
    "tenantId" TEXT NOT NULL,
    "domainId" TEXT,
    "productId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "event_specs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "event_spec_versions" (
    "id" TEXT NOT NULL,
    "eventSpecId" TEXT NOT NULL,
    "major" INTEGER NOT NULL,
    "minor" INTEGER NOT NULL,
    "sequence" INTEGER NOT NULL,
    "document" JSONB NOT NULL,
    "sourceDocument" JSONB NOT NULL,
    "frozenChannels" JSONB NOT NULL,
    "frozenTraits" JSONB NOT NULL,
    "messageVersionIds" TEXT[],
    "changeKind" "EntityVersionChangeKind" NOT NULL,
    "compatReport" JSONB NOT NULL DEFAULT '{}',
    "changeSummary" TEXT,
    "publishedById" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "governanceRequestId" TEXT,
    CONSTRAINT "event_spec_versions_pkey" PRIMARY KEY ("id")
);

-- ── unique + lookup indexes ──────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS "messages_latestVersionId_key"                ON "messages"("latestVersionId");
CREATE UNIQUE INDEX IF NOT EXISTS "event_specs_latestVersionId_key"             ON "event_specs"("latestVersionId");
CREATE UNIQUE INDEX IF NOT EXISTS "message_versions_messageId_major_minor_key"  ON "message_versions"("messageId", "major", "minor");
CREATE UNIQUE INDEX IF NOT EXISTS "message_versions_messageId_sequence_key"     ON "message_versions"("messageId", "sequence");
CREATE UNIQUE INDEX IF NOT EXISTS "event_spec_versions_eventSpecId_major_minor_key" ON "event_spec_versions"("eventSpecId", "major", "minor");
CREATE UNIQUE INDEX IF NOT EXISTS "event_spec_versions_eventSpecId_sequence_key"    ON "event_spec_versions"("eventSpecId", "sequence");
CREATE INDEX IF NOT EXISTS "channels_tenantId_idx"      ON "channels"("tenantId");
CREATE INDEX IF NOT EXISTS "channels_domainId_idx"      ON "channels"("domainId");
CREATE INDEX IF NOT EXISTS "channels_productId_idx"     ON "channels"("productId");
CREATE INDEX IF NOT EXISTS "traits_tenantId_idx"        ON "traits"("tenantId");
CREATE INDEX IF NOT EXISTS "traits_domainId_idx"        ON "traits"("domainId");
CREATE INDEX IF NOT EXISTS "traits_productId_idx"       ON "traits"("productId");
CREATE INDEX IF NOT EXISTS "messages_tenantId_idx"      ON "messages"("tenantId");
CREATE INDEX IF NOT EXISTS "messages_domainId_idx"      ON "messages"("domainId");
CREATE INDEX IF NOT EXISTS "messages_productId_idx"     ON "messages"("productId");
CREATE INDEX IF NOT EXISTS "messages_payloadEntityId_idx" ON "messages"("payloadEntityId");
CREATE INDEX IF NOT EXISTS "channel_messages_messageId_idx" ON "channel_messages"("messageId");
CREATE INDEX IF NOT EXISTS "message_versions_payloadEntityVersionId_idx" ON "message_versions"("payloadEntityVersionId");
CREATE INDEX IF NOT EXISTS "event_specs_tenantId_idx"   ON "event_specs"("tenantId");
CREATE INDEX IF NOT EXISTS "event_specs_domainId_idx"   ON "event_specs"("domainId");
CREATE INDEX IF NOT EXISTS "event_specs_productId_idx"  ON "event_specs"("productId");

-- ── foreign keys (D3: pins are NO ACTION — checked at end of statement) ───────
DO $$ BEGIN ALTER TABLE "channels" ADD CONSTRAINT "channels_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "channels" ADD CONSTRAINT "channels_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "domains"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "channels" ADD CONSTRAINT "channels_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE "traits" ADD CONSTRAINT "traits_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "traits" ADD CONSTRAINT "traits_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "domains"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "traits" ADD CONSTRAINT "traits_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "traits" ADD CONSTRAINT "traits_headersEntityId_fkey" FOREIGN KEY ("headersEntityId") REFERENCES "entities"("id") ON DELETE NO ACTION ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "traits" ADD CONSTRAINT "traits_headersEntityVersionId_fkey" FOREIGN KEY ("headersEntityVersionId") REFERENCES "entity_versions"("id") ON DELETE NO ACTION ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE "messages" ADD CONSTRAINT "messages_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "messages" ADD CONSTRAINT "messages_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "domains"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "messages" ADD CONSTRAINT "messages_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "messages" ADD CONSTRAINT "messages_payloadEntityId_fkey" FOREIGN KEY ("payloadEntityId") REFERENCES "entities"("id") ON DELETE NO ACTION ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "messages" ADD CONSTRAINT "messages_payloadEntityVersionId_fkey" FOREIGN KEY ("payloadEntityVersionId") REFERENCES "entity_versions"("id") ON DELETE NO ACTION ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "messages" ADD CONSTRAINT "messages_headersEntityId_fkey" FOREIGN KEY ("headersEntityId") REFERENCES "entities"("id") ON DELETE NO ACTION ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "messages" ADD CONSTRAINT "messages_headersEntityVersionId_fkey" FOREIGN KEY ("headersEntityVersionId") REFERENCES "entity_versions"("id") ON DELETE NO ACTION ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "messages" ADD CONSTRAINT "messages_keyEntityId_fkey" FOREIGN KEY ("keyEntityId") REFERENCES "entities"("id") ON DELETE NO ACTION ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "messages" ADD CONSTRAINT "messages_keyEntityVersionId_fkey" FOREIGN KEY ("keyEntityVersionId") REFERENCES "entity_versions"("id") ON DELETE NO ACTION ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "messages" ADD CONSTRAINT "messages_latestVersionId_fkey" FOREIGN KEY ("latestVersionId") REFERENCES "message_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "channel_messages" ADD CONSTRAINT "channel_messages_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE "message_versions" ADD CONSTRAINT "message_versions_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "message_versions" ADD CONSTRAINT "message_versions_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "message_versions" ADD CONSTRAINT "message_versions_payloadEntityVersionId_fkey" FOREIGN KEY ("payloadEntityVersionId") REFERENCES "entity_versions"("id") ON DELETE NO ACTION ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "message_versions" ADD CONSTRAINT "message_versions_headersEntityVersionId_fkey" FOREIGN KEY ("headersEntityVersionId") REFERENCES "entity_versions"("id") ON DELETE NO ACTION ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "message_versions" ADD CONSTRAINT "message_versions_keyEntityVersionId_fkey" FOREIGN KEY ("keyEntityVersionId") REFERENCES "entity_versions"("id") ON DELETE NO ACTION ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE "event_specs" ADD CONSTRAINT "event_specs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "event_specs" ADD CONSTRAINT "event_specs_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "domains"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "event_specs" ADD CONSTRAINT "event_specs_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "event_specs" ADD CONSTRAINT "event_specs_latestVersionId_fkey" FOREIGN KEY ("latestVersionId") REFERENCES "event_spec_versions"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE "event_spec_versions" ADD CONSTRAINT "event_spec_versions_eventSpecId_fkey" FOREIGN KEY ("eventSpecId") REFERENCES "event_specs"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "event_spec_versions" ADD CONSTRAINT "event_spec_versions_publishedById_fkey" FOREIGN KEY ("publishedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── placement + shape CHECKs (spec §4.1, D1) ─────────────────────────────────
DO $$ BEGIN ALTER TABLE "channels" ADD CONSTRAINT "channels_level_check" CHECK ("productId" IS NOT NULL AND "domainId" IS NOT NULL); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "messages" ADD CONSTRAINT "messages_level_check" CHECK ("productId" IS NOT NULL AND "domainId" IS NOT NULL); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "event_specs" ADD CONSTRAINT "event_specs_level_check" CHECK ("productId" IS NOT NULL AND "domainId" IS NOT NULL); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "traits" ADD CONSTRAINT "traits_level_check" CHECK ("productId" IS NULL OR "domainId" IS NOT NULL); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "channels" ADD CONSTRAINT "channels_format_check" CHECK (
    "format" IN ('avro', 'json-schema', 'protobuf')
    AND ("formatDialect" IS NULL OR ("format" = 'json-schema' AND "formatDialect" IN ('draft-07', '2020-12')))
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "traits" ADD CONSTRAINT "traits_headers_check"
    CHECK ("kind" = 'MESSAGE' OR ("headersEntityId" IS NULL AND "headersEntityVersionId" IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "message_versions" ADD CONSTRAINT "message_versions_numbers_check" CHECK ("major" >= 1 AND "minor" >= 0 AND "sequence" >= 1); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "event_spec_versions" ADD CONSTRAINT "event_spec_versions_numbers_check" CHECK ("major" >= 1 AND "minor" >= 0 AND "sequence" >= 1); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── immutability (DELETE stays allowed so parents cascade) ───────────────────
CREATE OR REPLACE FUNCTION prevent_published_version_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Published versions are immutable; publish a new version instead';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS message_versions_immutable ON "message_versions";
CREATE TRIGGER message_versions_immutable
  BEFORE UPDATE ON "message_versions"
  FOR EACH ROW
  EXECUTE FUNCTION prevent_published_version_update();

DROP TRIGGER IF EXISTS event_spec_versions_immutable ON "event_spec_versions";
CREATE TRIGGER event_spec_versions_immutable
  BEFORE UPDATE ON "event_spec_versions"
  FOR EACH ROW
  EXECUTE FUNCTION prevent_published_version_update();
