// Shared Prisma driver-adapter factory.
//
// Centralizes backend selection so the Next.js runtime (src/lib/db.ts), the
// seed script, and CLI tooling all construct the same adapter from DB_PROVIDER.
// Uses relative imports only (no "@/" alias) so it also resolves under tsx.

import { PrismaPg } from "@prisma/adapter-pg";
import type { PGlite } from "@electric-sql/pglite";
import { PrismaPGlite } from "./pglite-adapter";

import { getDbProvider, getPgliteDataDir } from "./db-provider";
import { closeOnSignals, sharedPglite } from "./pglite-open";

/**
 * Process-wide singleton PGlite instance per data directory (kept on globalThis, so the separate module graphs Next builds for routes,
 * actions and the proxy share it: a second instance on the same directory aborts). The directory is created with its parents, and the
 * client is closed when the process is stopped. See pglite-open.ts.
 */
export function getPgliteClient(): PGlite {
  const client = sharedPglite(getPgliteDataDir());
  closeOnSignals(client);
  return client;
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

  // Opened on Prisma's first query, not here: see PrismaPGliteAdapterFactory.
  return new PrismaPGlite(getPgliteClient);
}
