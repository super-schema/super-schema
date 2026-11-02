// npm run db:pglite-upgrade: moves a PGlite data directory made by PGlite 0.4 (PostgreSQL 17) to the PGlite this checkout runs
// (0.5, PostgreSQL 18), which cannot open the old one (src/lib/pglite-data-version.ts says so at start-up).
//
// How: PostgreSQL's on-disk format changes between majors, so the data is moved logically. The old PGlite and its pg_dump
// (@electric-sql/pglite 0.4.6 and @electric-sql/pglite-tools 0.3.6) are installed into a temporary directory (never into this checkout),
// dump the database to SQL there, and the SQL is restored into a fresh directory with this checkout's PGlite.
//   - The old directory is renamed to <dir>.pg17-backup-<time>, and the dump is kept next to it as <dir>.pg17-dump-<time>.sql. Nothing is
//     deleted: remove both by hand once the app works.
//   - `--no-owner --no-privileges`: a PGlite 0.4 database owns its objects as the role web_user, which a new PGlite does not have.
//   - Stop the app first (`npm run dev` holds the directory). Needs npm and network access for the temporary install.
// The directory is PGLITE_DATA_DIR (from the environment or .env), default ./data/pglite. docs/database.md, "Upgrading a PGlite 0.4 database".

import "dotenv/config";

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const OLD_PGLITE = "@electric-sql/pglite@0.4.6";
const OLD_PGLITE_TOOLS = "@electric-sql/pglite-tools@0.3.6";
const NEW_MAJOR = "18";

function fail(message) {
  console.error(`[pglite-upgrade] ${message}`);
  process.exit(1);
}

// The directory as PGlite opens it (pgliteFilesystemDir in src/lib/pglite-data-version.ts: `file://` stripped; memory and browser schemes
// are not on disk, so there is nothing here to upgrade).
const configured = process.env.PGLITE_DATA_DIR?.trim() || "./data/pglite";
if (["memory://", "idb://", "opfs-ahp://", "memfs2opfs://"].some((scheme) => configured.startsWith(scheme))) {
  console.log(`[pglite-upgrade] PGLITE_DATA_DIR=${configured} is not a directory on disk: nothing to upgrade.`);
  process.exit(0);
}
const dataDir = path.resolve(configured.startsWith("file://") ? configured.slice("file://".length) : configured);
const versionFile = path.join(dataDir, "PG_VERSION");

if (!existsSync(versionFile)) {
  console.log(`[pglite-upgrade] ${dataDir} holds no PGlite database: nothing to upgrade.`);
  process.exit(0);
}
const major = readFileSync(versionFile, "utf8").trim();
if (major === NEW_MAJOR) {
  console.log(`[pglite-upgrade] ${dataDir} is already PostgreSQL ${NEW_MAJOR}: nothing to upgrade.`);
  process.exit(0);
}
if (major !== "17") fail(`${dataDir} was made by PostgreSQL ${major}; this script upgrades PostgreSQL 17 (PGlite 0.4) only.`);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = `${dataDir}.pg17-backup-${stamp}`;
const dumpFile = `${dataDir}.pg17-dump-${stamp}.sql`;
const work = mkdtempSync(path.join(os.tmpdir(), "pglite-upgrade-"));

try {
  console.log(`[pglite-upgrade] installing ${OLD_PGLITE} and ${OLD_PGLITE_TOOLS} into ${work} ...`);
  writeFileSync(path.join(work, "package.json"), JSON.stringify({ private: true, type: "module" }));
  // npm is npm.cmd on Windows, which only a shell can start; the arguments are constants.
  execFileSync("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", OLD_PGLITE, OLD_PGLITE_TOOLS], {
    cwd: work,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  // Run the dump inside the temporary directory, so its imports resolve to the old PGlite and not to this checkout's.
  writeFileSync(
    path.join(work, "dump.mjs"),
    [
      'import { PGlite } from "@electric-sql/pglite";',
      'import { pgDump } from "@electric-sql/pglite-tools/pg_dump";',
      'import { writeFileSync } from "node:fs";',
      "const db = new PGlite(process.argv[2]);",
      'const dump = await pgDump({ pg: db, args: ["--no-owner", "--no-privileges"] });',
      "writeFileSync(process.argv[3], await dump.text());",
      "await db.close();",
    ].join("\n"),
  );
  console.log(`[pglite-upgrade] dumping ${dataDir} (PostgreSQL 17) ...`);
  execFileSync(process.execPath, [path.join(work, "dump.mjs"), dataDir, dumpFile], { cwd: work, stdio: "inherit" });
  const sql = readFileSync(dumpFile, "utf8");
  if (!sql.includes("PostgreSQL database dump complete")) throw new Error(`the dump ${dumpFile} is incomplete; ${dataDir} was left as it was.`);

  const { PGlite } = await import("@electric-sql/pglite");
  renameSync(dataDir, backupDir);
  console.log(`[pglite-upgrade] restoring into a new ${dataDir} (PostgreSQL ${NEW_MAJOR}) ...`);
  let db;
  try {
    db = new PGlite(dataDir);
    await db.exec(sql);
    const tables = await db.query("SELECT count(*)::int AS n FROM pg_catalog.pg_tables WHERE schemaname = 'public'");
    console.log(`[pglite-upgrade] done: ${tables.rows[0].n} tables restored.`);
    await db.close();
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    // close() rejects too when PGlite failed to start (it waits for the start), so it must not stand between the failure and the rollback.
    await db?.close().catch(() => {});
    try {
      rmSync(dataDir, { recursive: true, force: true });
      renameSync(backupDir, dataDir);
    } catch (rollbackError) {
      const why = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
      throw new Error(
        `the restore failed (${cause}), and putting the old directory back failed too (${why}): your PostgreSQL 17 data is in ${backupDir} ` +
          `(and dumped in ${dumpFile}); move it back to ${dataDir} by hand.`,
      );
    }
    throw new Error(`the restore failed, and ${dataDir} was put back as it was (the dump is kept in ${dumpFile}): ${cause}`);
  }
  console.log(`[pglite-upgrade] the old directory is ${backupDir} and the dump is ${dumpFile}; delete them once the app works.`);
} catch (error) {
  process.exitCode = 1;
  console.error(`[pglite-upgrade] ${error instanceof Error ? error.message : String(error)}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
