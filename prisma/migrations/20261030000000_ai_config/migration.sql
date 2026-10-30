-- AI provider configuration, editable by a platform administrator (Admin > AI).
--
-- One row (id "default") overrides the AI_PROVIDER / AI_BASE_URL / AI_MODEL environment variables when its provider and baseUrl are both set
-- (src/services/ai-config.service.ts). A null field means "not set here". The API key is never stored in this table: it is read from AI_API_KEY.
-- Additive only: a new table, no existing row is touched.

-- CreateTable
CREATE TABLE "ai_config" (
    "id" TEXT NOT NULL,
    "provider" TEXT,
    "baseUrl" TEXT,
    "model" TEXT,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_config_pkey" PRIMARY KEY ("id")
);
