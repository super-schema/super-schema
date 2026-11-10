-- Additive: existing workflows keep their target and existing runs keep their exact format.
ALTER TABLE "deployment_workflows" ADD COLUMN "supportedTargets" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
UPDATE "deployment_workflows" SET "supportedTargets" = ARRAY["format"];
