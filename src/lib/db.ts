// Connection pooling note for serverless deployments:
// When running behind PgBouncer (e.g. Supabase, Railway, or self-hosted),
// append `?pgbouncer=true` to DATABASE_URL so Prisma uses compatible
// connection handling (disables prepared statements, uses simple protocol).
// Example: postgresql://user:pass@host:6543/db?pgbouncer=true
//
// Without PgBouncer in serverless, each function invocation may open a new
// connection, risking pool exhaustion. Consider Prisma Accelerate or a
// PgBouncer sidecar in production serverless environments.

import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createPrismaClient() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL environment variable is required");
  }
  const adapter = new PrismaPg({
    connectionString: process.env.DATABASE_URL,
  });
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
