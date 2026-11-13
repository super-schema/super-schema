// Connection pooling note for serverless deployments (PostgreSQL provider):
// When running behind PgBouncer (e.g. Supabase, Railway, or self-hosted),
// append `?pgbouncer=true` to DATABASE_URL so Prisma uses compatible
// connection handling (disables prepared statements, uses simple protocol).
// Example: postgresql://user:pass@host:6543/db?pgbouncer=true
//
// Without PgBouncer in serverless, each function invocation may open a new
// connection, risking pool exhaustion. Consider Prisma Accelerate or a
// PgBouncer sidecar in production serverless environments.
//
// The embedded PGlite provider (default) runs in-process and is intended for
// single-instance deployments and local development, not multi-instance
// serverless fan-out.

import { PrismaClient } from "@/generated/prisma/client";

import { createDbAdapter } from "./db-adapter";
import { withStorageInitialization } from "./db-storage-init";
import { initializeLegacyTenantStorage } from "./gitops/tenant-mode";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// Building the client opens nothing: the PGlite directory is opened on the first query (see createDbAdapter).
const rawPrisma =
  globalForPrisma.prisma ?? new PrismaClient({ adapter: createDbAdapter() });
export const prisma = withStorageInitialization(rawPrisma, () =>
  initializeLegacyTenantStorage(rawPrisma),
);

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = rawPrisma;
}
