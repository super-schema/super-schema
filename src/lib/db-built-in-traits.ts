// The built-in message properties (CloudEvents and W3C Trace Context, src/lib/events/bundled-traits.ts) for every tenant of the database that
// the environment names: the last step of scripts/db.ts, after the migrations (`ensure` before `npm run dev`, `deploy` for production).
//
// `strict` (deploy): a failure is thrown, so `npm run db:deploy` exits 1 and the compose stack's migrate service stops before the app starts.
// An app that serves without its built-in traits is the failure this step exists to prevent. Not strict (ensure): a failure is one log line,
// and the start goes on. A name that something else in a tenant already holds is neither: it is reported and left alone.

import { getDbProvider, getPgliteDataDir } from "./db-provider";
import { assertPgliteDataDirOpenable } from "./pglite-data-version";

/** How long a PostgreSQL connection may take before the step gives up (the dev start must stay fast). */
const CONNECT_TIMEOUT_MS = 5_000;

/** The last line of an error's message (a driver's one-line reason), so a failure never floods the dev start's output. */
const lastLine = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).trim().split("\n").filter(Boolean).pop() ?? "unknown error";

/**
 * Installs the built-in message properties for every tenant and prints one summary line. See the header for `strict`.
 * (The PGlite data directory is exclusive to one process, so the caller runs this only after the migration step has closed its own handle.)
 */
export async function installBuiltInTraits({ strict }: { strict: boolean }): Promise<void> {
  // The services log a database failure with its full stack (`dbErrorResult`); the start-up needs one line, so capture it.
  const logged: unknown[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(...args);
  };
  try {
    const { PrismaClient } = await import("../generated/prisma/client");
    const { ensureBundledTraitsForAllTenants } = await import("../services/events/bundled-traits.service");

    let close: () => Promise<void> = async () => undefined;
    let adapter: ConstructorParameters<typeof PrismaClient>[0]["adapter"];
    if (getDbProvider() === "pglite") {
      const [{ PGlite }, { PrismaPGlite }] = await Promise.all([import("@electric-sql/pglite"), import("./pglite-adapter")]);
      const pglite = new PGlite(assertPgliteDataDirOpenable(getPgliteDataDir()));
      close = () => pglite.close();
      adapter = new PrismaPGlite(pglite);
    } else {
      const connectionString = process.env.DATABASE_URL;
      if (!connectionString) throw new Error("DATABASE_URL is not set");
      const { PrismaPg } = await import("@prisma/adapter-pg");
      adapter = new PrismaPg({ connectionString, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
    }

    const prisma = new PrismaClient({ adapter });
    try {
      const result = await ensureBundledTraitsForAllTenants(prisma);
      if (!result.success) throw new Error(`${result.error.code}: ${result.error.message}`);
      const { tenants, created, skipped, failed } = result.data;
      const made = created.reduce((n, c) => n + c.names.length, 0);
      const parts = [`${made} created across ${tenants} tenant(s)`];
      for (const s of skipped) parts.push(`name taken in ${s.tenantId}: ${s.names.join(", ")}`);
      for (const f of failed) parts.push(`failed for ${f.tenantId} (${f.code})`);
      console.log(`[db] built-in message properties: ${parts.join("; ")}.`);
      if (strict && failed.length > 0) {
        throw new Error(`the built-in message properties are not installed for ${failed.map((f) => f.tenantId).join(", ")}`);
      }
    } finally {
      await prisma.$disconnect();
      await close();
    }
  } catch (error) {
    if (strict) {
      // The database's own error, printed in full (the capture above held it back), then the failure itself.
      for (const entry of logged) originalError(entry);
      throw error;
    }
    const cause = logged.find((entry) => entry instanceof Error) ?? error;
    console.warn(`[db] built-in message properties: skipped (${lastLine(cause)}).`);
  } finally {
    console.error = originalError;
  }
}
