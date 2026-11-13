-- Repairs databases that applied an early draft of 20261114000000_tenant_content_storage: the committed migration also adds these two
-- columns, but migrations are recorded by name, so such databases never received them (/admin/settings/storage then failed with
-- "The column ... does not exist"). A no-op on databases migrated from the committed files.
ALTER TABLE "tenant_git_bindings" ADD COLUMN IF NOT EXISTS "workflowDefaults" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "gitops_oauth_states" ADD COLUMN IF NOT EXISTS "returnTo" TEXT NOT NULL DEFAULT '/admin/workflows/gitops';
