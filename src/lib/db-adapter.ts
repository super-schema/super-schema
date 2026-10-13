// Shared Prisma driver-adapter factory.
//
// Centralizes backend selection so the Next.js runtime (src/lib/db.ts), the
// seed script, and CLI tooling all construct the same adapter from DB_PROVIDER.
// Uses relative imports only (no "@/" alias) so it also resolves under tsx.

import { PrismaPg } from "@prisma/adapter-pg";
import { PGlite } from "@electric-sql/pglite";
import { PrismaPGlite } from "./pglite-adapter";

import { getDbProvider, getPgliteDataDir } from "./db-provider";

let pgliteClient: PGlite | undefined;

/**
 * Process-wide singleton PGlite instance. PGlite holds an exclusive lock on its
 * data directory, so only one instance per process may open it.
 */
export function getPgliteClient(): PGlite {
  if (!pgliteClient) {
    pgliteClient = new PGlite(getPgliteDataDir());
  }
  return pgliteClient;
}

/**
 * Build the Prisma driver adapter for the active provider. For PostgreSQL this
 * requires DATABASE_URL; for PGlite it opens the embedded data directory, which
 * must already be migrated (see scripts/db.ts / `npm run db:deploy`).
 */
export function createDbAdapter() {
  const provider = getDbProvider();

  if (provider === "postgresql") {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        'DATABASE_URL is required when DB_PROVIDER="postgresql".',
      );
    }
    return new PrismaPg({ connectionString });
  }

  return new PrismaPGlite(getPgliteClient());
}
