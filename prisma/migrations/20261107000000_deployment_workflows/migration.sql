CREATE TABLE "deployment_connections" (
  "id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "name" TEXT NOT NULL, "method" TEXT NOT NULL,
  "config" JSONB NOT NULL, "credentials" TEXT NOT NULL, "revision" INTEGER NOT NULL DEFAULT 1,
  "active" BOOLEAN NOT NULL DEFAULT true, "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "deployment_connections_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "deployment_connections_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "deployment_connections_tenantId_name_key" ON "deployment_connections"("tenantId", "name");

CREATE TABLE "deployment_workflows" (
  "id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "entityId" TEXT NOT NULL, "connectionId" TEXT NOT NULL,
  "name" TEXT NOT NULL, "format" TEXT NOT NULL, "environment" TEXT NOT NULL, "settings" JSONB NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1, "active" BOOLEAN NOT NULL DEFAULT true, "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "deployment_workflows_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "deployment_workflows_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "deployment_workflows_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entities"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "deployment_workflows_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "deployment_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "deployment_workflows_entityId_name_key" ON "deployment_workflows"("entityId", "name");
CREATE INDEX "deployment_workflows_tenantId_entityId_idx" ON "deployment_workflows"("tenantId", "entityId");

CREATE TABLE "deployment_runs" (
  "id" TEXT NOT NULL, "tenantId" TEXT NOT NULL, "entityId" TEXT NOT NULL, "workflowId" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL, "connectionRevision" INTEGER NOT NULL, "method" TEXT NOT NULL,
  "format" TEXT NOT NULL, "artifactVersion" INTEGER NOT NULL, "environment" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PREVIEWED', "snapshot" JSONB NOT NULL, "planHash" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL, "receipt" JSONB, "error" TEXT, "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "leaseUntil" TIMESTAMP(3), "leaseToken" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL, "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "deployment_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "deployment_runs_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "deployment_runs_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entities"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "deployment_runs_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "deployment_workflows"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "deployment_runs_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "deployment_connections"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "deployment_runs_tenantId_idempotencyKey_key" ON "deployment_runs"("tenantId", "idempotencyKey");
CREATE INDEX "deployment_runs_status_nextAttemptAt_idx" ON "deployment_runs"("status", "nextAttemptAt");
CREATE INDEX "deployment_runs_tenantId_entityId_createdAt_idx" ON "deployment_runs"("tenantId", "entityId", "createdAt");

CREATE TABLE "deployment_attempts" (
  "id" TEXT NOT NULL, "runId" TEXT NOT NULL, "number" INTEGER NOT NULL, "status" TEXT NOT NULL,
  "error" TEXT, "receipt" JSONB, "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "finishedAt" TIMESTAMP(3),
  CONSTRAINT "deployment_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "deployment_attempts_runId_fkey" FOREIGN KEY ("runId") REFERENCES "deployment_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "deployment_attempts_runId_number_key" ON "deployment_attempts"("runId", "number");
