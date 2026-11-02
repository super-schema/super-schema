import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { applyPgliteMigrations } from "@/lib/pglite-migrate";

const MIGRATIONS = "prisma/migrations";
const MIGRATION = "20261101120000_webhook_endpoint_tenant";
const NOW = "CURRENT_TIMESTAMP";

/** A copy of the migrations without `name`: the database as it stood before that migration (the copy is removed by the caller). */
function migrationsWithout(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "webhook-tenant-migrations-"));
  for (const entry of readdirSync(MIGRATIONS, { withFileTypes: true })) {
    if (entry.isDirectory() && /^\d/.test(entry.name) && entry.name !== name) {
      cpSync(join(MIGRATIONS, entry.name), join(dir, entry.name), { recursive: true });
    }
  }
  return dir;
}

const user = (id: string) => `INSERT INTO "users" ("id","email","updatedAt") VALUES ('${id}','${id}@example.test',${NOW})`;
const tenant = (id: string) => `INSERT INTO "tenants" ("id","name","slug","updatedAt") VALUES ('${id}','${id}','${id}',${NOW})`;
const tenantRole = (id: string, userId: string, tenantId: string) =>
  `INSERT INTO "user_roles" ("id","userId","role","scopeKey","tenantId") VALUES ('${id}','${userId}','VIEWER','T:${tenantId}','${tenantId}')`;
const globalRole = (id: string, userId: string) =>
  `INSERT INTO "user_roles" ("id","userId","role","scopeKey") VALUES ('${id}','${userId}','ADMIN','G')`;
const endpoint = (id: string, createdBy: string | null, active = true) =>
  `INSERT INTO "webhook_endpoints" ("id","url","events","secret","active","createdBy","updatedAt")
   VALUES ('${id}','https://example.invalid/h',ARRAY['emission.completed'],'s',${active},${createdBy === null ? "NULL" : `'${createdBy}'`},${NOW})`;

describe("webhook endpoint tenant (migration 20261101120000) on PGlite", () => {
  it("applies: a nullable tenant column, a foreign key to tenants, and its index", async () => {
    const db = new PGlite();
    try {
      expect(await applyPgliteMigrations(db)).toContain(MIGRATION);

      const column = await db.query<{ is_nullable: string }>(
        `select is_nullable from information_schema.columns where table_name = 'webhook_endpoints' and column_name = 'tenantId'`,
      );
      expect(column.rows).toEqual([{ is_nullable: "YES" }]);
      const index = await db.query<{ indexname: string }>(`select indexname from pg_indexes where tablename = 'webhook_endpoints'`);
      expect(index.rows.map((row) => row.indexname)).toContain("webhook_endpoints_tenantId_idx");
      const foreignKey = await db.query<{ conname: string }>(`select conname from pg_constraint where conname = 'webhook_endpoints_tenantId_fkey'`);
      expect(foreignKey.rows).toHaveLength(1);
    } finally {
      await db.close();
    }
  }, 60_000);

  it("backfills an endpoint whose creator belongs to exactly one tenant, and deactivates every endpoint it cannot attribute", async () => {
    const before = migrationsWithout(MIGRATION);
    const db = new PGlite();
    try {
      await applyPgliteMigrations(db, before);
      for (const statement of [tenant("t-one"), tenant("t-two"), user("u-one"), user("u-two"), user("u-global"), user("u-none")]) {
        await db.exec(statement);
      }
      await db.exec(tenantRole("r1", "u-one", "t-one"));
      await db.exec(tenantRole("r2", "u-two", "t-one"));
      await db.exec(tenantRole("r3", "u-two", "t-two"));
      await db.exec(globalRole("r4", "u-global"));
      await db.exec(endpoint("w-one", "u-one"));
      await db.exec(endpoint("w-one-off", "u-one", false));
      await db.exec(endpoint("w-two", "u-two"));
      await db.exec(endpoint("w-global", "u-global"));
      await db.exec(endpoint("w-none", "u-none"));
      await db.exec(endpoint("w-key", null));

      expect(await applyPgliteMigrations(db)).toEqual([MIGRATION]);

      const rows = await db.query<{ id: string; tenantId: string | null; active: boolean }>(
        `SELECT "id", "tenantId", "active" FROM "webhook_endpoints" ORDER BY "id"`,
      );
      expect(rows.rows).toEqual([
        // Not attributable (a creator with only a platform role, no creator, no roles, roles in two tenants): not guessed, so the endpoint
        // is deactivated and keeps no tenant.
        { id: "w-global", tenantId: null, active: false },
        { id: "w-key", tenantId: null, active: false },
        { id: "w-none", tenantId: null, active: false },
        // The creator's roles name one tenant: the endpoint belongs to it, and its active flag is kept as it was.
        { id: "w-one", tenantId: "t-one", active: true },
        { id: "w-one-off", tenantId: "t-one", active: false },
        { id: "w-two", tenantId: null, active: false },
      ]);
    } finally {
      await db.close();
      rmSync(before, { recursive: true, force: true });
    }
  }, 120_000);

  it("an endpoint belongs to a real tenant, and deleting the tenant deletes its endpoints", async () => {
    const db = new PGlite();
    try {
      await applyPgliteMigrations(db);
      await db.exec(tenant("t-one"));
      await db.exec(`INSERT INTO "webhook_endpoints" ("id","url","events","secret","tenantId","updatedAt")
        VALUES ('w-own','https://example.invalid/h',ARRAY['emission.completed'],'s','t-one',${NOW})`);
      await expect(
        db.exec(`INSERT INTO "webhook_endpoints" ("id","url","events","secret","tenantId","updatedAt")
          VALUES ('w-ghost','https://example.invalid/h',ARRAY['emission.completed'],'s','no-such-tenant',${NOW})`),
      ).rejects.toThrow(/foreign key|violates/i);

      await db.exec(`DELETE FROM "tenants" WHERE "id" = 't-one'`);
      expect((await db.query(`SELECT "id" FROM "webhook_endpoints"`)).rows).toEqual([]);
    } finally {
      await db.close();
    }
  }, 60_000);
});
