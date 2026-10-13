-- TypeSpec-as-system-of-record (architecture.md, 2026-10-12): the entity's
-- real TypeSpec source becomes the canonical captured representation.
-- Nullable during the transition — existing entities get it lazily
-- generated on first view of the TypeSpec Source tab (Epic 12, Story 12.7).
ALTER TABLE "entities" ADD COLUMN IF NOT EXISTS "typespecSource" TEXT;
