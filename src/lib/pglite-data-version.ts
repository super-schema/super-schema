// Refuses a PGlite data directory that this PGlite cannot open, with words that say what to do.
//
// PGlite 0.5 embeds PostgreSQL 18; a directory made by PGlite 0.4 (PostgreSQL 17) is refused by the engine itself with only "PGlite failed
// to initialize properly". The directory records its PostgreSQL major in PG_VERSION, so the check reads that before PGlite opens it.
// `npm run db:pglite-upgrade` (scripts/pglite-upgrade.mjs) moves such a directory to PostgreSQL 18 (dump with the old PGlite, restore with
// this one, the old directory kept as a backup). docs/database.md, "Upgrading a PGlite 0.4 database".
//
// Relative imports only (no "@/" alias): scripts/db.ts runs this under tsx.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** The PostgreSQL major version that the installed @electric-sql/pglite (0.5.x) embeds. */
export const PGLITE_POSTGRES_MAJOR = "18";

/** The schemes PGlite opens somewhere other than the local disk. */
const NON_FILESYSTEM_SCHEMES = ["memory://", "idb://", "opfs-ahp://", "memfs2opfs://"];

/**
 * The directory on disk that PGlite opens for `dataDir`, or null when it opens none. This mirrors PGlite's own parsing (its dataDir
 * resolver): `file://` is stripped, the browser and memory schemes are not on disk, and any other value, even one that looks like a URL, is
 * a path. scripts/pglite-upgrade.mjs repeats this rule.
 */
export function pgliteFilesystemDir(dataDir: string): string | null {
  if (!dataDir || NON_FILESYSTEM_SCHEMES.some((scheme) => dataDir.startsWith(scheme))) return null;
  const dir = dataDir.startsWith("file://") ? dataDir.slice("file://".length) : dataDir;
  return dir || null;
}

/**
 * The problem with opening `dataDir` with this PGlite, or null when there is none: the directory does not exist yet (PGlite makes it),
 * is not on disk, or was made by the PostgreSQL major this PGlite embeds.
 */
export function pgliteDataDirProblem(dataDir: string): string | null {
  const dir = pgliteFilesystemDir(dataDir);
  if (dir === null) return null;
  const versionFile = path.join(dir, "PG_VERSION");
  if (!existsSync(versionFile)) return null;
  const major = readFileSync(versionFile, "utf8").trim();
  if (major === PGLITE_POSTGRES_MAJOR) return null;
  return (
    `The PGlite data directory ${dataDir} was made by PostgreSQL ${major || "(unknown)"}, and this PGlite embeds PostgreSQL ` +
    `${PGLITE_POSTGRES_MAJOR}, which cannot open it. Run \`npm run db:pglite-upgrade\` to move it to PostgreSQL ${PGLITE_POSTGRES_MAJOR} ` +
    "(the old directory is kept as a backup), or delete the directory to start with an empty database. docs/database.md, " +
    '"Upgrading a PGlite 0.4 database".'
  );
}

/** Throws the problem of `pgliteDataDirProblem`; returns `dataDir` unchanged otherwise, so a caller can write `new PGlite(checked(dir))`. */
export function assertPgliteDataDirOpenable(dataDir: string): string {
  const problem = pgliteDataDirProblem(dataDir);
  if (problem) throw new Error(problem);
  return dataDir;
}
