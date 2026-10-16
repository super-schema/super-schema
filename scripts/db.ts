// Database migration helper for both backends.
//
//   tsx scripts/db.ts ensure   — PGlite: apply pending migrations; PostgreSQL: no-op.
//   tsx scripts/db.ts deploy    — PGlite: apply pending migrations; PostgreSQL: `prisma migrate deploy`.
//
// `ensure` runs automatically before `dev`/`build` so the embedded PGlite
// database is ready with zero manual setup, while never requiring a running
// PostgreSQL server for the PostgreSQL provider.
//
// Both modes then install the built-in message properties (CloudEvents, W3C Trace Context) as
// library traits of every tenant that lacks them — idempotent, one query per tenant when nothing
// is missing. That step is best effort: any failure (no server, schema not migrated yet) is logged
// and never fails the start.

import "dotenv/config";

import { getDbProvider, getPgliteDataDir } from "../src/lib/db-provider";
import { applyPgliteMigrations } from "../src/lib/pglite-migrate";

const mode = process.argv[2] === "deploy" ? "deploy" : "ensure";

/** How long a PostgreSQL connection may take before the built-in step gives up (the dev start must stay fast). */
const CONNECT_TIMEOUT_MS = 5_000;

async function runPglite(): Promise<void> {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite(getPgliteDataDir());
  const applied = await applyPgliteMigrations(db);
  await db.close();
  console.log(
    applied.length
      ? `[db] PGlite: applied ${applied.length} migration(s): ${applied.join(", ")}`
      : "[db] PGlite: schema up to date.",
  );
}

async function runPostgres(): Promise<void> {
  if (mode === "ensure") {
    console.log(
      "[db] DB_PROVIDER=postgresql — skipping auto-migrate. Run `npm run db:deploy` against your database.",
    );
    return;
  }
  const { execSync } = await import("node:child_process");
  execSync("prisma migrate deploy", { stdio: "inherit" });
}

/** The last line of an error's message (a driver's one-line reason), so a failure never floods the dev start's output. */
const lastLine = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).trim().split("\n").filter(Boolean).pop() ?? "unknown error";

/**
 * Installs the built-in message properties for every tenant. Never throws: the result is one log line.
 * (The PGlite data directory is exclusive to one process, so this runs only after the migration step has closed its own handle.)
 */
async function installBundledTraits(): Promise<void> {
  // The services log a database failure with its full stack (`dbErrorResult`); the start-up needs one line, so capture it.
  const logged: unknown[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { logged.push(...args); };
  try {
    const { PrismaClient } = await import("../src/generated/prisma/client");
    const { ensureBundledTraitsForAllTenants } = await import("../src/services/events/bundled-traits.service");

    let close: () => Promise<void> = async () => undefined;
    let adapter: ConstructorParameters<typeof PrismaClient>[0]["adapter"];
    if (getDbProvider() === "pglite") {
      const [{ PGlite }, { PrismaPGlite }] = await Promise.all([import("@electric-sql/pglite"), import("../src/lib/pglite-adapter")]);
      const pglite = new PGlite(getPgliteDataDir());
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
    } finally {
      await prisma.$disconnect();
      await close();
    }
  } catch (error) {
    const cause = logged.find((entry) => entry instanceof Error) ?? error;
    console.warn(`[db] built-in message properties: skipped (${lastLine(cause)}).`);
  } finally {
    console.error = originalError;
  }
}

async function main(): Promise<void> {
  const provider = getDbProvider();
  if (provider === "pglite") {
    await runPglite();
  } else {
    await runPostgres();
  }
  await installBundledTraits();
}

main().catch((error) => {
  console.error("[db] migration failed:", error);
  process.exit(1);
});
