-- Admin-defined levels must pick a class on the fixed 1-5 scale (1 = most restrictive). Existing custom rows become class 3.
ALTER TABLE "classification_levels" ADD COLUMN "classNumber" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "classification_levels" ADD CONSTRAINT "classification_levels_class_number_check" CHECK ("classNumber" BETWEEN 1 AND 5);

-- System rows sit at their fixed positions.
UPDATE "classification_levels" SET "classNumber" = 2 WHERE "name" = 'PII' AND "isSystem" = true;
UPDATE "classification_levels" SET "classNumber" = 3 WHERE "name" = 'SENSITIVE' AND "isSystem" = true;
UPDATE "classification_levels" SET "classNumber" = 4 WHERE "name" = 'INTERNAL' AND "isSystem" = true;
UPDATE "classification_levels" SET "classNumber" = 5 WHERE "name" = 'PUBLIC' AND "isSystem" = true;
