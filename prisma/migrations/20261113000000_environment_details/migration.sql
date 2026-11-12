-- Additive: per-environment description and Git branch override. Order stays in "deploymentEnvironments".
ALTER TABLE "tenants" ADD COLUMN "deploymentEnvironmentDetails" JSONB NOT NULL DEFAULT '{}';
