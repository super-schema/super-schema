// Embedded-migration applier for the PGlite backend.
//
// Prisma's own `migrate deploy` connects over a datasource URL, which the
// in-process PGlite instance does not expose. PGlite runs the exact same
// PostgreSQL DDL that Prisma emits, so we apply the committed migration SQL
// directly against the PGlite data directory and track applied migrations in a
// dedicated table. This is a deploy-style applier (forward-only); authoring new
// migrations is still done with `prisma migrate dev` against PostgreSQL.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { PGlite } from "@electric-sql/pglite";

const DEFAULT_MIGRATIONS_DIR = "prisma/migrations";
const TRACKING_TABLE = "_pglite_migrations";

/**
 * Apply any migrations not yet recorded in the PGlite database, in lexical
 * (timestamp) order. Idempotent: already-applied migrations are skipped.
 * Returns the names of the migrations applied during this call.
 */
export async function applyPgliteMigrations(
  db: PGlite,
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR,
): Promise<string[]> {
  await db.exec(
    `CREATE TABLE IF NOT EXISTS "${TRACKING_TABLE}" (
       name TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     );`,
  );

  if (!existsSync(migrationsDir)) return [];

  const migrations = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d/.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  const existing = await db.query<{ name: string }>(
    `SELECT name FROM "${TRACKING_TABLE}"`,
  );
  const applied = new Set(existing.rows.map((row) => row.name));

  const run: string[] = [];
  for (const name of migrations) {
    if (applied.has(name)) continue;

    const sqlPath = join(migrationsDir, name, "migration.sql");
    if (!existsSync(sqlPath)) continue;

    const sql = readFileSync(sqlPath, "utf8");
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query(`INSERT INTO "${TRACKING_TABLE}" (name) VALUES ($1)`, [name]);
    });
    run.push(name);
  }

  return run;
}
