// Isolated database used only by the explicitly invoked hosted smoke test.
import { PGlite } from "@electric-sql/pglite";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPGlite } from "@/lib/pglite-adapter";
import { applyPgliteMigrations } from "@/lib/pglite-migrate";
export const hostedPg = new PGlite();
await applyPgliteMigrations(hostedPg);
export const prisma = new PrismaClient({ adapter: new PrismaPGlite(hostedPg) });
