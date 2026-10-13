// Database migration helper for both backends.
//
//   tsx scripts/db.ts ensure   — PGlite: apply pending migrations; PostgreSQL: no-op.
//   tsx scripts/db.ts deploy    — PGlite: apply pending migrations; PostgreSQL: `prisma migrate deploy`.
//
// `ensure` runs automatically before `dev`/`build` so the embedded PGlite
// database is ready with zero manual setup, while never requiring a running
// PostgreSQL server for the PostgreSQL provider.

import "dotenv/config";

import { getDbProvider, getPgliteDataDir } from "../src/lib/db-provider";
import { applyPgliteMigrations } from "../src/lib/pglite-migrate";

const mode = process.argv[2] === "deploy" ? "deploy" : "ensure";

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

async function main(): Promise<void> {
  const provider = getDbProvider();
  if (provider === "pglite") {
    await runPglite();
  } else {
    await runPostgres();
  }
}

main().catch((error) => {
  console.error("[db] migration failed:", error);
  process.exit(1);
});
