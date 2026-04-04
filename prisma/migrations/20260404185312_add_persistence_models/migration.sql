-- CreateEnum
CREATE TYPE "GitAuthMethod" AS ENUM ('SSH_KEY', 'PERSONAL_ACCESS_TOKEN', 'GITHUB_APP');

-- CreateEnum
CREATE TYPE "GitSyncStatus" AS ENUM ('SUCCESS', 'FAILED', 'PENDING');

-- CreateEnum
CREATE TYPE "PrReviewMode" AS ENUM ('ALWAYS', 'BREAKING_ONLY', 'NEVER');

-- CreateEnum
CREATE TYPE "GitPrStatus" AS ENUM ('OPEN', 'MERGED', 'CLOSED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('APPROVAL_REQUEST', 'APPROVAL_DECISION', 'CHANGE_COMPLETE', 'DRIFT_ALERT', 'ANNOTATION_TAG', 'ANNOTATION_REPLY', 'COMPLIANCE_GAP');

-- CreateEnum
CREATE TYPE "GovernanceStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'AUTO_APPROVED');

-- CreateEnum
CREATE TYPE "GovernanceDecision" AS ENUM ('APPROVE', 'REJECT');

-- CreateEnum
CREATE TYPE "EmissionStatus" AS ENUM ('CURRENT', 'STAGED', 'BEHIND');

-- CreateEnum
CREATE TYPE "DeploymentStatus" AS ENUM ('DEPLOYED', 'STAGED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "git_config" (
    "id" TEXT NOT NULL,
    "repositoryUrl" TEXT NOT NULL,
    "branch" TEXT NOT NULL DEFAULT 'main',
    "basePath" TEXT NOT NULL DEFAULT 'schemas/',
    "authMethod" "GitAuthMethod" NOT NULL,
    "authCredential" TEXT NOT NULL,
    "prReviewMode" "PrReviewMode" NOT NULL DEFAULT 'BREAKING_ONLY',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncStatus" "GitSyncStatus",
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "git_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "git_pull_requests" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "prUrl" TEXT NOT NULL,
    "prNumber" INTEGER NOT NULL,
    "branchName" TEXT NOT NULL,
    "status" "GitPrStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "git_pull_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "domainId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "classification_levels" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayColor" TEXT NOT NULL,
    "bgColor" TEXT NOT NULL,
    "textColor" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "classification_levels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "entityId" TEXT,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_endpoints" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "events" TEXT[],
    "secret" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "statusCode" INTEGER,
    "error" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "nextRetryAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "governance_requests" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "entityName" TEXT NOT NULL,
    "domainId" TEXT,
    "versionId" TEXT,
    "changeType" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "status" "GovernanceStatus" NOT NULL DEFAULT 'PENDING',
    "impactReport" JSONB,
    "requestedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "governance_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "governance_approvals" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "approverId" TEXT NOT NULL,
    "decision" "GovernanceDecision" NOT NULL,
    "comment" TEXT,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "governance_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "type_mapping_overrides" (
    "id" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "targetFormat" TEXT NOT NULL,
    "mappedType" TEXT NOT NULL,
    "isLossy" BOOLEAN NOT NULL DEFAULT false,
    "lossDescription" TEXT,
    "justification" TEXT,
    "approvedBy" TEXT,
    "entityId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "type_mapping_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lossy_mapping_acks" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "targetFormat" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "acknowledgedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lossy_mapping_acks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "emitter_configs" (
    "id" TEXT NOT NULL,
    "emitterName" TEXT NOT NULL,
    "targetFormat" TEXT NOT NULL,
    "version" TEXT NOT NULL DEFAULT '1.0.0',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT NOT NULL DEFAULT '',
    "configOverrides" JSONB,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "emitter_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "emission_target_statuses" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "emittedVersion" INTEGER,
    "stagedVersion" INTEGER,
    "lastEmittedAt" TIMESTAMP(3),
    "status" "EmissionStatus" NOT NULL DEFAULT 'BEHIND',
    "output" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "emission_target_statuses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deployment_records" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "DeploymentStatus" NOT NULL DEFAULT 'DEPLOYED',
    "driftReport" JSONB,
    "isDrifted" BOOLEAN NOT NULL DEFAULT false,
    "deployedBy" TEXT,
    "deployedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deployment_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_roles_userId_role_domainId_key" ON "user_roles"("userId", "role", "domainId");

-- CreateIndex
CREATE UNIQUE INDEX "classification_levels_name_key" ON "classification_levels"("name");

-- CreateIndex
CREATE INDEX "notifications_userId_read_idx" ON "notifications"("userId", "read");

-- CreateIndex
CREATE INDEX "webhook_deliveries_endpointId_idx" ON "webhook_deliveries"("endpointId");

-- CreateIndex
CREATE INDEX "governance_requests_status_idx" ON "governance_requests"("status");

-- CreateIndex
CREATE UNIQUE INDEX "type_mapping_overrides_sourceType_targetFormat_entityId_key" ON "type_mapping_overrides"("sourceType", "targetFormat", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "lossy_mapping_acks_entityId_sourceType_targetFormat_userId_key" ON "lossy_mapping_acks"("entityId", "sourceType", "targetFormat", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "emitter_configs_emitterName_key" ON "emitter_configs"("emitterName");

-- CreateIndex
CREATE UNIQUE INDEX "emission_target_statuses_entityId_target_key" ON "emission_target_statuses"("entityId", "target");

-- CreateIndex
CREATE UNIQUE INDEX "deployment_records_entityId_target_environment_key" ON "deployment_records"("entityId", "target", "environment");

-- AddForeignKey
ALTER TABLE "git_config" ADD CONSTRAINT "git_config_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "git_pull_requests" ADD CONSTRAINT "git_pull_requests_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "domains"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "webhook_endpoints"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "governance_approvals" ADD CONSTRAINT "governance_approvals_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "governance_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;
