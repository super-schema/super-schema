// Database migration helper for both backends.
//
//   tsx scripts/db.ts ensure   — PGlite: apply pending migrations; PostgreSQL: no-op.
//   tsx scripts/db.ts deploy    — PGlite: apply pending migrations; PostgreSQL: `prisma migrate deploy`.
//
// `ensure` runs automatically before `dev` (predev) so the embedded PGlite
// database is ready with zero manual setup, while never requiring a running
// PostgreSQL server for the PostgreSQL provider. `build` never runs it: a build
// writes to no database. Production runs `deploy` (npm run db:deploy).
//
// Both modes then install the built-in message properties (CloudEvents, W3C Trace Context) as
// library traits of every tenant that lacks them (src/lib/db-built-in-traits.ts). `ensure` treats that
// step as best effort: a failure is logged and never fails the start. `deploy` fails when it fails:
// an app that starts without its built-in traits is the failure the step exists to prevent.

import "dotenv/config";

import { installBuiltInTraits } from "../src/lib/db-built-in-traits";
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
  await installBuiltInTraits({ strict: mode === "deploy" });
}

main().catch((error) => {
  console.error("[db] failed:", error);
  process.exit(1);
});
