// @vitest-environment node
/**
 * Migration 20261114000000_tenant_content_storage gained two columns after an early draft of it had already been applied to local
 * databases. The PGlite migrator records migrations by name only, so those databases never received
 * `tenant_git_bindings.workflowDefaults` or `gitops_oauth_states.returnTo`, and /admin/settings/storage failed with
 * "The column ... does not exist". A later migration repairs such databases idempotently.
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { applyPgliteMigrations } from "@/lib/pglite-migrate";

const REPO_MIGRATIONS = path.join(process.cwd(), "prisma", "migrations");
const DRIFTED = "20261114000000_tenant_content_storage";

/** The migrations as a database that applied the early draft of DRIFTED saw them: the same, without the two later columns. */
function draftMigrationsDir(): string {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "draft-migrations-")), "migrations");
  // Only what existed then: the migrations up to and including DRIFTED.
  cpSync(REPO_MIGRATIONS, dir, { recursive: true, filter: (src) => { const name = path.relative(REPO_MIGRATIONS, src).split(path.sep)[0]; return !/^\d/.test(name) || name <= DRIFTED; } });
  const file = path.join(dir, DRIFTED, "migration.sql");
  const draft = readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => !/"workflowDefaults"|"returnTo"/.test(line))
    .join("\n");
  writeFileSync(file, draft);
  return dir;
}

async function hasColumn(db: PGlite, table: string, column: string): Promise<boolean> {
  const r = await db.query(`SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`, [table, column]);
  return r.rows.length > 0;
}

describe("repair of the tenant content storage columns", () => {
  it("adds the columns a database that applied the early draft is missing", async () => {
    const db = new PGlite();
    try {
      await applyPgliteMigrations(db, draftMigrationsDir());
      expect(await hasColumn(db, "tenant_git_bindings", "workflowDefaults")).toBe(false);

      await applyPgliteMigrations(db, REPO_MIGRATIONS);

      expect(await hasColumn(db, "tenant_git_bindings", "workflowDefaults")).toBe(true);
      expect(await hasColumn(db, "gitops_oauth_states", "returnTo")).toBe(true);
    } finally {
      await db.close();
    }
  }, 120_000);

  it("is a no-op on a database migrated from scratch", async () => {
    const db = new PGlite();
    try {
      await expect(applyPgliteMigrations(db, REPO_MIGRATIONS)).resolves.toBeDefined();
      expect(await hasColumn(db, "tenant_git_bindings", "workflowDefaults")).toBe(true);
      expect(await hasColumn(db, "gitops_oauth_states", "returnTo")).toBe(true);
    } finally {
      await db.close();
    }
  }, 120_000);
});
