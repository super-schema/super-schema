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
import {
  initializeLegacyTenantStorage,
  isTenantGitWriteError,
} from "./gitops/tenant-mode";
import { GitOpsError } from "./gitops/contracts";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const rawPrisma =
  globalForPrisma.prisma ?? new PrismaClient({ adapter: createDbAdapter() });
let storageInitialization: Promise<void> | undefined;
const initializeStorage = () =>
  (storageInitialization ??= initializeLegacyTenantStorage(rawPrisma).catch(
    (error) => {
      storageInitialization = undefined;
      throw error;
    },
  ));
export const prisma = rawPrisma.$extends({
  query: {
    $allModels: {
      async $allOperations({ args, query }) {
        await initializeStorage();
        try {
          return await query(args);
        } catch (error) {
          if (isTenantGitWriteError(error))
            throw new GitOpsError(
              "This tenant stores contracts in Git. Use GitOps authoring to save a private draft and submit a pull request.",
              "GITOPS_AUTHORING_REQUIRED",
            );
          throw error;
        }
      },
    },
  },
}) as unknown as PrismaClient;

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = rawPrisma;
}
