// Embedded-migration applier for the PGlite backend.
//
// Prisma's own `migrate deploy` connects over a datasource URL, which the
// in-process PGlite instance does not expose. PGlite runs the exact same
// PostgreSQL DDL that Prisma emits, so we apply the committed migration SQL
// directly against the PGlite data directory and track applied migrations in a
// dedicated table. This is a deploy-style applier (forward-only); authoring new
// migrations is still done with `prisma migrate dev` against PostgreSQL.
//
// Each applied migration's checksum is recorded and compared on every run (as Prisma does for PostgreSQL): editing a migration after a
// database applied it is refused instead of silently skipped, which once left local databases without columns the committed file added.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { PGlite } from "@electric-sql/pglite";

const DEFAULT_MIGRATIONS_DIR = "prisma/migrations";
const TRACKING_TABLE = "_pglite_migrations";
const ALLOW_CHANGED_ENV = "PGLITE_ALLOW_CHANGED_MIGRATIONS";

/** sha256 of a migration's SQL, with CRLF normalised to LF (a checkout's line endings are not a change). */
export function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");
}

/** Applied migrations whose files changed since they were applied. */
export class MigrationChecksumError extends Error {
  constructor(readonly changed: string[]) {
    super(
      `These migrations were changed after this database applied them: ${changed.join(", ")}. ` +
        `The database keeps what the earlier version created, so the change is not in it. ` +
        `Do not edit an applied migration: restore the file and add a new migration for the change. ` +
        `If this database already matches the edited files, set ${ALLOW_CHANGED_ENV}=1 once to record the new checksums.`,
    );
    this.name = "MigrationChecksumError";
  }
}

/**
 * Apply any migrations not yet recorded in the PGlite database, in lexical
 * (timestamp) order. Idempotent: already-applied migrations are skipped.
 * Refuses (MigrationChecksumError) when an applied migration's file changed; a migration recorded before checksums existed is given its
 * current checksum. Returns the names of the migrations applied during this call.
 */
export async function applyPgliteMigrations(
  db: PGlite,
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<string[]> {
  await db.exec(
    `CREATE TABLE IF NOT EXISTS "${TRACKING_TABLE}" (
       name TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     );
     ALTER TABLE "${TRACKING_TABLE}" ADD COLUMN IF NOT EXISTS checksum TEXT;`,
  );

  if (!existsSync(migrationsDir)) return [];

  const migrations = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .flatMap((name) => {
      const sqlPath = join(migrationsDir, name, "migration.sql");
      if (!existsSync(sqlPath)) return [];
      const sql = readFileSync(sqlPath, "utf8");
      return [{ name, sql, checksum: migrationChecksum(sql) }];
    });

  const existing = await db.query<{ name: string; checksum: string | null }>(
    `SELECT name, checksum FROM "${TRACKING_TABLE}"`,
  );
  const applied = new Map(existing.rows.map((row) => [row.name, row.checksum]));

  // Check every applied migration before running anything.
  const changed: string[] = [];
  for (const { name, checksum } of migrations) {
    if (!applied.has(name)) continue;
    const recorded = applied.get(name);
    if (recorded === null || recorded === undefined) {
      await db.query(`UPDATE "${TRACKING_TABLE}" SET checksum = $2 WHERE name = $1`, [name, checksum]);
    } else if (recorded !== checksum) {
      changed.push(name);
    }
  }
  if (changed.length > 0) {
    if (process.env[ALLOW_CHANGED_ENV] !== "1") throw new MigrationChecksumError(changed);
    console.warn(`[db] ${ALLOW_CHANGED_ENV}=1: recording the new checksums of changed migrations ${changed.join(", ")}.`);
    for (const name of changed) {
      const checksum = migrations.find((m) => m.name === name)!.checksum;
      await db.query(`UPDATE "${TRACKING_TABLE}" SET checksum = $2 WHERE name = $1`, [name, checksum]);
    }
  }

  const run: string[] = [];
  for (const { name, sql, checksum } of migrations) {
    if (applied.has(name)) continue;
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query(`INSERT INTO "${TRACKING_TABLE}" (name, checksum) VALUES ($1, $2)`, [name, checksum]);
    });
    run.push(name);
  }

  return run;
}
