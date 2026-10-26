import { PGlite } from "@electric-sql/pglite";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPGlite } from "@/lib/pglite-adapter";
import { applyPgliteMigrations } from "@/lib/pglite-migrate";

/**
 * A real database for a test: PGlite (in-process PostgreSQL), migrated with every migration of the repository, behind the same Prisma driver
 * adapter the app uses. For the code whose point is what the database does (a unique key deciding a race, an atomic UPDATE, a window query), where
 * a mock would only repeat the author's belief.
 *
 * Tests of code that imports `prisma` from `@/lib/db` give it this client with a dynamic factory (`vi.mock` is hoisted above the imports):
 *
 *   const holder = vi.hoisted(() => ({ db: undefined as undefined | TestDb }));
 *   vi.mock("@/lib/db", async () => {
 *     holder.db = await (await import("../../helpers/pglite-db")).createPgliteDb();
 *     return { prisma: holder.db.prisma };
 *   });
 *   afterAll(() => holder.db?.close());
 *
 * Migrating takes several seconds: give the hook a generous timeout, and keep one database per test file.
 */
export type TestDb = { prisma: PrismaClient; close: () => Promise<void> };

export async function createPgliteDb(): Promise<TestDb> {
  const pglite = new PGlite();
  await applyPgliteMigrations(pglite);
  const prisma = new PrismaClient({ adapter: new PrismaPGlite(pglite) });
  return {
    prisma,
    close: async () => {
      await prisma.$disconnect();
      await pglite.close();
    },
  };
}
