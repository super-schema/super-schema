-- GitOps metadata and disposable projection cache. No existing content is changed.

CREATE TABLE "git_provider_apps" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'github',
  "appId" TEXT NOT NULL,
  "privateKey" TEXT NOT NULL,
  "webhookSecret" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "clientSecret" TEXT NOT NULL,
  "baseUrl" TEXT NOT NULL DEFAULT 'https://github.com',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "tenant_git_bindings" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "productId" TEXT UNIQUE,
  "repositoryUrl" TEXT NOT NULL,
  "installationId" TEXT NOT NULL,
  "branch" TEXT NOT NULL DEFAULT 'main',
  "basePath" TEXT NOT NULL DEFAULT 'superschema',
  "indexedSha" TEXT,
  "lastSyncAt" TIMESTAMP(3),
  "nextSyncAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSyncStatus" TEXT NOT NULL DEFAULT 'PENDING',
  "lastError" TEXT,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "connectionId" TEXT,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "product_git_settings" (
  "productId" TEXT NOT NULL PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "bindingId" TEXT NOT NULL,
  "repositoryUrl" TEXT,
  "installationId" TEXT,
  "branch" TEXT,
  "basePath" TEXT,
  "stages" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "targets" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "owners" TEXT[] NOT NULL DEFAULT '{}',
  "workflowId" TEXT,
  "sourceSha" TEXT,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "product_git_settings_tenantId_idx" ON "product_git_settings" ("tenantId");

CREATE TABLE "git_user_links" (
  "userId" TEXT NOT NULL PRIMARY KEY,
  "githubId" TEXT NOT NULL UNIQUE,
  "login" TEXT NOT NULL,
  "accessToken" TEXT NOT NULL,
  "refreshToken" TEXT,
  "expiresAt" TIMESTAMP(3),
  "refreshExpiresAt" TIMESTAMP(3),
  "appRevision" INTEGER NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "gitops_oauth_states" (
  "hash" TEXT NOT NULL PRIMARY KEY,
  "verifier" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL
);

CREATE TABLE "change_sets" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "tenantId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "authorId" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'EDIT',
  "state" TEXT NOT NULL DEFAULT 'DRAFT',
  "openKey" TEXT UNIQUE,
  "title" TEXT NOT NULL DEFAULT '',
  "description" TEXT NOT NULL DEFAULT '',
  "branch" TEXT,
  "baseSha" TEXT,
  "headSha" TEXT,
  "prNumber" INTEGER,
  "prUrl" TEXT,
  "review" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "checks" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "mergeable" BOOLEAN,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "leaseToken" TEXT,
  "leasedUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "change_sets_tenantId_productId_state_idx" ON "change_sets" ("tenantId", "productId", "state");

CREATE TABLE "change_set_items" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "changeSetId" TEXT NOT NULL,
  "objectKey" TEXT NOT NULL,
  "objectKind" TEXT NOT NULL,
  "objectId" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "path" TEXT NOT NULL,
  "oldPath" TEXT,
  "baseBlobSha" TEXT,
  "baseDocument" JSONB,
  "submittedDocument" JSONB,
  "contentOverride" TEXT,
  "document" JSONB,
  "outOfDate" BOOLEAN NOT NULL DEFAULT false,
  "conflicts" JSONB NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE ("changeSetId", "objectKey")
);

CREATE TABLE "git_canonical_documents" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "bindingId" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "productId" TEXT,
  "objectId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "version" TEXT NOT NULL DEFAULT '',
  "stage" TEXT,
  "path" TEXT NOT NULL,
  "blobSha" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "commitSha" TEXT NOT NULL,
  "document" JSONB NOT NULL,
  UNIQUE ("bindingId", "path"),
  UNIQUE ("bindingId", "kind", "objectId", "version")
);

CREATE INDEX "git_canonical_documents_tenantId_productId_idx" ON "git_canonical_documents" ("tenantId", "productId");

CREATE TABLE "git_index_errors" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "bindingId" TEXT NOT NULL,
  "path" TEXT NOT NULL,
  "sha" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE ("bindingId", "path")
);

CREATE TABLE "gitops_jobs" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "dedupeKey" TEXT NOT NULL UNIQUE,
  "kind" TEXT NOT NULL,
  "bindingId" TEXT NOT NULL,
  "payload" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "state" TEXT NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "dueAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" TEXT,
  "leasedUntil" TIMESTAMP(3),
  "lastError" TEXT,
  "finishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "gitops_jobs_state_dueAt_idx" ON "gitops_jobs" ("state", "dueAt");

CREATE TABLE "delivery_pull_requests" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "deliveryKey" TEXT NOT NULL UNIQUE,
  "productId" TEXT NOT NULL,
  "bindingId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "target" TEXT NOT NULL,
  "installationId" TEXT,
  "repositoryUrl" TEXT NOT NULL,
  "baseBranch" TEXT NOT NULL,
  "branch" TEXT NOT NULL,
  "prNumber" INTEGER,
  "prUrl" TEXT,
  "headSha" TEXT,
  "sourceSha" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'PENDING',
  "versions" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "lastError" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "delivery_pull_requests_productId_state_idx" ON "delivery_pull_requests" ("productId", "state");

CREATE TABLE "git_webhook_deliveries" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "event" TEXT NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "tenant_git_bindings" ADD CONSTRAINT "tenant_git_bindings_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE;

ALTER TABLE "product_git_settings" ADD CONSTRAINT "product_git_settings_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE;

ALTER TABLE "product_git_settings" ADD CONSTRAINT "product_git_settings_bindingId_fkey" FOREIGN KEY ("bindingId") REFERENCES "tenant_git_bindings"("id") ON DELETE RESTRICT;

ALTER TABLE "git_user_links" ADD CONSTRAINT "git_user_links_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE;

ALTER TABLE "gitops_oauth_states" ADD CONSTRAINT "gitops_oauth_states_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE;

ALTER TABLE "change_sets" ADD CONSTRAINT "change_sets_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE;

ALTER TABLE "change_sets" ADD CONSTRAINT "change_sets_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT;

ALTER TABLE "change_set_items" ADD CONSTRAINT "change_set_items_changeSetId_fkey" FOREIGN KEY ("changeSetId") REFERENCES "change_sets"("id") ON DELETE CASCADE;

ALTER TABLE "git_canonical_documents" ADD CONSTRAINT "git_canonical_documents_bindingId_fkey" FOREIGN KEY ("bindingId") REFERENCES "tenant_git_bindings"("id") ON DELETE CASCADE;

ALTER TABLE "git_index_errors" ADD CONSTRAINT "git_index_errors_bindingId_fkey" FOREIGN KEY ("bindingId") REFERENCES "tenant_git_bindings"("id") ON DELETE CASCADE;

ALTER TABLE "gitops_jobs" ADD CONSTRAINT "gitops_jobs_bindingId_fkey" FOREIGN KEY ("bindingId") REFERENCES "tenant_git_bindings"("id") ON DELETE CASCADE;

ALTER TABLE "delivery_pull_requests" ADD CONSTRAINT "delivery_pull_requests_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE;

CREATE UNIQUE INDEX "tenant_git_bindings_root_key" ON "tenant_git_bindings" ("tenantId") WHERE "productId" IS NULL;
