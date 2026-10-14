-- Navigation indexes: the explorer tree and the domain / product workspaces
-- look rows up by their parent ids. The existing composite uniques only lead
-- with slug / name, so these parent columns had no usable index. Names match
-- Prisma's @@index defaults so `prisma migrate dev` sees no drift. Idempotent.
CREATE INDEX IF NOT EXISTS "entities_domainId_idx"            ON "entities"("domainId");
CREATE INDEX IF NOT EXISTS "entities_productId_idx"           ON "entities"("productId");
CREATE INDEX IF NOT EXISTS "products_domainId_idx"            ON "products"("domainId");
CREATE INDEX IF NOT EXISTS "service_definitions_domainId_idx" ON "service_definitions"("domainId");
