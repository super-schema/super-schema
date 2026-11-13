/**
 * src/lib/pglite-migrate.ts: an applied migration whose file changed is refused, not silently skipped. Migrations used to be recorded by name
 * only, so a database that applied an early draft of a migration never received what the committed file added later (the missing
 * tenant_git_bindings.workflowDefaults that broke /admin/settings/storage). A checksum of each applied file is stored and compared on every run.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyPgliteMigrations, MigrationChecksumError } from "../../../src/lib/pglite-migrate";

const open: PGlite[] = [];
afterEach(async () => {
  delete process.env.PGLITE_ALLOW_CHANGED_MIGRATIONS;
  vi.restoreAllMocks();
  await Promise.all(open.splice(0).map((db) => db.close().catch(() => undefined)));
});

function migrationsDir(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "pglite-migrations-"));
  for (const [name, sql] of Object.entries(files)) write(dir, name, sql);
  return dir;
}
function write(dir: string, name: string, sql: string) {
  mkdirSync(path.join(dir, name), { recursive: true });
  writeFileSync(path.join(dir, name, "migration.sql"), sql);
}
async function freshDb() {
  const db = new PGlite();
  open.push(db);
  return db;
}
const checksums = async (db: PGlite) =>
  Object.fromEntries((await db.query<{ name: string; checksum: string | null }>(`SELECT name, checksum FROM "_pglite_migrations" ORDER BY name`)).rows.map((r) => [r.name, r.checksum]));

describe("applyPgliteMigrations checksums", () => {
  it("records a checksum for every migration it applies", async () => {
    const db = await freshDb();
    const dir = migrationsDir({ "001_a": "CREATE TABLE a (id int);" });
    await applyPgliteMigrations(db, dir);
    expect((await checksums(db))["001_a"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses to run when an applied migration file has changed, naming it, and applies nothing after it", async () => {
    const db = await freshDb();
    const dir = migrationsDir({ "001_a": "CREATE TABLE a (id int);" });
    await applyPgliteMigrations(db, dir);
    write(dir, "001_a", "CREATE TABLE a (id int);\nALTER TABLE a ADD COLUMN b int;");
    write(dir, "002_c", "CREATE TABLE c (id int);");

    const run = applyPgliteMigrations(db, dir);
    await expect(run).rejects.toBeInstanceOf(MigrationChecksumError);
    await expect(run).rejects.toThrow(/001_a/);
    const tables = (await db.query<{ t: string }>(`SELECT tablename t FROM pg_tables WHERE tablename = 'c'`)).rows;
    expect(tables).toHaveLength(0);
  });

  it("gives a migration recorded before checksums existed today's checksum instead of refusing", async () => {
    const db = await freshDb();
    await db.exec(`CREATE TABLE "_pglite_migrations" (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());
                   INSERT INTO "_pglite_migrations" (name) VALUES ('001_a'); CREATE TABLE a (id int);`);
    const dir = migrationsDir({ "001_a": "CREATE TABLE a (id int);" });

    await expect(applyPgliteMigrations(db, dir)).resolves.toEqual([]);
    expect((await checksums(db))["001_a"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("treats CRLF and LF line endings as the same file", async () => {
    const db = await freshDb();
    const dir = migrationsDir({ "001_a": "CREATE TABLE a (id int);\nCREATE TABLE b (id int);\n" });
    await applyPgliteMigrations(db, dir);
    write(dir, "001_a", "CREATE TABLE a (id int);\r\nCREATE TABLE b (id int);\r\n");
    await expect(applyPgliteMigrations(db, dir)).resolves.toEqual([]);
  });

  it("with PGLITE_ALLOW_CHANGED_MIGRATIONS=1 warns, records the new checksum and continues", async () => {
    const db = await freshDb();
    const dir = migrationsDir({ "001_a": "CREATE TABLE a (id int);" });
    await applyPgliteMigrations(db, dir);
    const before = (await checksums(db))["001_a"];
    write(dir, "001_a", "CREATE TABLE a (id int); -- edited");
    write(dir, "002_c", "CREATE TABLE c (id int);");
    process.env.PGLITE_ALLOW_CHANGED_MIGRATIONS = "1";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(applyPgliteMigrations(db, dir)).resolves.toEqual(["002_c"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("001_a"));
    expect((await checksums(db))["001_a"]).not.toBe(before);
  });
});
