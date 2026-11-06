// Recovery for an unopenable embedded database (a process killed while PGlite was writing leaves the data directory half-written):
//
//   npm run db:reset            move the directory aside ONLY if it cannot be opened, then build a fresh migrated one
//   npm run db:reset -- --force move it aside even if it opens (stop the dev server and every script first)
//
// The old directory is renamed to `<dir>.corrupt-<time>`, never deleted. PGlite only (PostgreSQL has its own tooling).
// Run `npm run db:seed` afterwards for the demo data and the admin login.

import "dotenv/config";
import { execFileSync } from "node:child_process";

import { getDbProvider, getPgliteDataDir } from "../src/lib/db-provider";
import { resetPgliteDataDir } from "../src/lib/pglite-open";

async function main(): Promise<void> {
  if (getDbProvider() !== "pglite") {
    console.log('[db:reset] DB_PROVIDER is not "pglite"; nothing to reset.');
    return;
  }
  const dir = getPgliteDataDir();
  const outcome = await resetPgliteDataDir(dir, { force: process.argv.includes("--force") });
  console.log(`[db:reset] ${outcome.reason}`);
  if (!outcome.moved && existsMessage(outcome.reason)) return;
  execFileSync("npx", ["tsx", "scripts/db.ts", "ensure"], { stdio: "inherit" });
  console.log("[db:reset] fresh database ready. `npm run db:seed` adds the demo data and the admin login.");
}

/** A directory that opens fine is left alone (and not rebuilt); a missing one is just created by `ensure`. */
const existsMessage = (reason: string): boolean => reason.includes("opens fine");

main().catch((error) => {
  console.error("[db:reset] failed:", error);
  process.exit(1);
});
