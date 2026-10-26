/**
 * The access_control migration, applied to a PGlite database that holds rows written under the OLD schema (the one before it):
 * global, domain-scoped, product-scoped, tenant-scoped and tenant-null role rows, mixed-case e-mails and audit rows of every entity type.
 * Pinned: the backfill (scopeKey, tenantId, domainId, audit tenantId, lower-cased e-mails), the constraints that follow it (the unique key
 * that closes the old NULL-distinct hole, the scopeKey shape and column-consistency CHECKs, the lower(email) unique index), the refusals
 * (duplicate e-mails by case, duplicate role rows) and that a refusal changes nothing, and that nothing is destroyed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { applyPgliteMigrations } from "@/lib/pglite-migrate";
import { parseScopeKey, scopeKey } from "@/lib/access/scope";

const SUFFIX = "_access_control";
const NOW = "CURRENT_TIMESTAMP";
const MIGRATION = readdirSync("prisma/migrations").find((name) => name.endsWith(SUFFIX)) ?? `<no migration ending in ${SUFFIX}>`;

let beforeDir = "";
let oldSchema: File | Blob;

/** A copy of prisma/migrations without the migration under test: the schema as it was before access control. */
function migrationsBefore(): string {
  const dir = mkdtempSync(join(tmpdir(), "migrations-before-access-control-"));
  for (const entry of readdirSync("prisma/migrations", { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== MIGRATION) cpSync(join("prisma/migrations", entry.name), join(dir, entry.name), { recursive: true });
  }
  return dir;
}

beforeAll(async () => {
  beforeDir = migrationsBefore();
  const db = new PGlite();
  try {
    await applyPgliteMigrations(db, beforeDir);
    oldSchema = await db.dumpDataDir("none");
  } finally {
    await db.close();
  }
}, 120_000);

afterAll(() => {
  if (beforeDir) rmSync(beforeDir, { recursive: true, force: true });
});

/** Run `body` on a fresh PGlite holding the old schema (every migration but the one under test). */
async function onOldSchema(body: (db: PGlite) => Promise<void>): Promise<void> {
  const db = new PGlite({ loadDataDir: oldSchema });
  try {
    await body(db);
  } finally {
    await db.close();
  }
}

async function rows<T = Record<string, unknown>>(db: PGlite, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}
async function scalar<T>(db: PGlite, sql: string): Promise<T> {
  return (await rows<{ v: T }>(db, sql))[0].v;
}
const tableExists = async (db: PGlite, table: string) => (await scalar<string | null>(db, `SELECT to_regclass('public."${table}"')::text AS v`)) !== null;
const migrationRecorded = async (db: PGlite) => (await scalar<number>(db, `SELECT count(*)::int AS v FROM "_pglite_migrations" WHERE name = '${MIGRATION}'`)) === 1;

/** The error a statement raises (its message and SQLSTATE), or undefined when it succeeds. */
async function failure(db: PGlite, sql: string): Promise<{ message: string; code?: string } | undefined> {
  try {
    await db.exec(sql);
    return undefined;
  } catch (e) {
    const error = e as { message?: string; code?: string };
    return { message: String(error.message), code: error.code };
  }
}

const user = (id: string, email: string) => `INSERT INTO "users" ("id","email","updatedAt") VALUES ('${id}','${email}',${NOW})`;
const role = (id: string, userId: string, name: string, cols: { tenantId?: string; domainId?: string; productId?: string } = {}) =>
  `INSERT INTO "user_roles" ("id","userId","role","tenantId","domainId","productId")
   VALUES ('${id}','${userId}','${name}',${cols.tenantId ? `'${cols.tenantId}'` : "NULL"},${cols.domainId ? `'${cols.domainId}'` : "NULL"},${cols.productId ? `'${cols.productId}'` : "NULL"})`;
const audit = (id: string, action: string, entityType: string, entityId: string, afterState?: object) =>
  `INSERT INTO "audit_log" ("id","action","entityType","entityId","userId","afterState")
   VALUES ('${id}','${action}','${entityType}','${entityId}','u1',${afterState ? `'${JSON.stringify(afterState)}'::jsonb` : "NULL"})`;

/** Two tenants, a domain and a product in each, an entity with a field in the default tenant, an event spec and a trait in the second. */
async function seedHierarchy(db: PGlite) {
  await db.exec(`INSERT INTO "tenants" ("id","name","slug","updatedAt") VALUES ('ten2','Second','second',${NOW})`);
  await db.exec(`INSERT INTO "domains" ("id","tenantId","name","slug","updatedAt") VALUES ('d1','tenant_default','D1','d1',${NOW}),('d2','ten2','D2','d2',${NOW})`);
  await db.exec(`INSERT INTO "products" ("id","domainId","name","slug","updatedAt") VALUES ('p1','d1','P1','p1',${NOW}),('p2','d2','P2','p2',${NOW})`);
  await db.exec(
    `INSERT INTO "entities" ("id","name","slug","tenantId","domainId","productId","ownerId","updatedAt")
     VALUES ('e1','Order','order','tenant_default','d1','p1','u1',${NOW})`
  );
  await db.exec(`INSERT INTO "fields" ("id","entityId","name","slug","type","sortOrder","updatedAt") VALUES ('f1','e1','id','id','string',0,${NOW})`);
  await db.exec(`INSERT INTO "event_specs" ("id","name","document","tenantId","domainId","productId","updatedAt") VALUES ('s1','checkout','{"documentVersion":2}','ten2','d2','p2',${NOW})`);
  await db.exec(`INSERT INTO "traits" ("id","kind","name","tenantId","updatedAt") VALUES ('t1','MESSAGE','trace','ten2',${NOW})`);
}

describe("access_control migration: backfill over rows written under the old schema", () => {
  it("is found next to the others and sorts after the latest earlier migration", () => {
    const names = readdirSync("prisma/migrations", { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    expect(MIGRATION).toMatch(/^\d{8,14}_access_control$/);
    // It comes right after the last migration that predates it; later ones (the webhook creator, 20261026) follow it.
    expect(names[names.indexOf(MIGRATION) - 1]).toBe("20261020_drop_legacy_event_catalog");
    expect(names.indexOf(MIGRATION)).toBeGreaterThan(0);
  });

  it("the old schema lets two identical global ADMIN rows coexist (the NULL-distinct hole the new unique key closes)", async () => {
    await onOldSchema(async (db) => {
      await db.exec(user("u1", "u1@example.test"));
      await db.exec(role("g1", "u1", "ADMIN"));
      await db.exec(role("g2", "u1", "ADMIN"));
      expect(await scalar<number>(db, `SELECT count(*)::int AS v FROM "user_roles"`)).toBe(2);
    });
  }, 60_000);

  it("backfills scopeKey, tenantId and domainId of every kind of old role row, and keeps the rows", async () => {
    await onOldSchema(async (db) => {
      await db.exec(user("u1", "u1@example.test"));
      for (const id of ["u2", "u3", "u4", "u5", "u6"]) await db.exec(user(id, `${id}@example.test`));
      await seedHierarchy(db);
      await db.exec(role("r-global", "u1", "ADMIN")); // global
      await db.exec(role("r-dom-nulltenant", "u2", "AUTHOR", { domainId: "d1" })); // domain-scoped, tenantId null: the usual shape the app wrote
      await db.exec(role("r-dom-tenant", "u3", "STEWARD", { domainId: "d2", tenantId: "ten2" })); // domain-scoped with its tenant
      await db.exec(role("r-prod", "u2", "VIEWER", { productId: "p2" })); // product-scoped, domainId and tenantId null
      await db.exec(role("r-tenant", "u4", "VIEWER", { tenantId: "ten2" })); // tenant-scoped
      await db.exec(role("r-global-co", "u5", "COMPLIANCE_OFFICER")); // legacy "system-level" compliance officer
      await db.exec(role("r-global-viewer", "u6", "VIEWER")); // a global non-admin row written by hand

      const applied = await applyPgliteMigrations(db);
      expect(applied).toEqual([MIGRATION]);

      const byId = Object.fromEntries(
        (await rows<{ id: string; role: string; userId: string; scopeKey: string; tenantId: string | null; domainId: string | null; productId: string | null }>(
          db,
          `SELECT "id","userId","role","scopeKey","tenantId","domainId","productId" FROM "user_roles" ORDER BY "id"`
        )).map((r) => [r.id, r])
      );
      expect(byId["r-global"]).toMatchObject({ role: "ADMIN", scopeKey: "G", tenantId: null, domainId: null, productId: null });
      expect(byId["r-dom-nulltenant"]).toMatchObject({ role: "AUTHOR", scopeKey: "D:d1", tenantId: "tenant_default", domainId: "d1", productId: null });
      expect(byId["r-dom-tenant"]).toMatchObject({ role: "STEWARD", scopeKey: "D:d2", tenantId: "ten2", domainId: "d2", productId: null });
      expect(byId["r-prod"]).toMatchObject({ role: "VIEWER", scopeKey: "P:p2", tenantId: "ten2", domainId: "d2", productId: "p2" });
      expect(byId["r-tenant"]).toMatchObject({ role: "VIEWER", scopeKey: "T:ten2", tenantId: "ten2", domainId: null, productId: null });

      // A global row of a role that is not ADMIN is no longer a valid assignment (GLOBAL is ADMIN only): it becomes one tenant-scoped row
      // per existing tenant, the same access it gave, and the original row goes. Nothing else changes hands.
      expect(byId["r-global-co"]).toBeUndefined();
      expect(byId["r-global-viewer"]).toBeUndefined();
      const expanded = await rows<{ userId: string; role: string; scopeKey: string; tenantId: string }>(
        db,
        `SELECT "userId","role","scopeKey","tenantId" FROM "user_roles" WHERE "userId" IN ('u5','u6') ORDER BY "userId","scopeKey" COLLATE "C"`
      );
      expect(expanded).toEqual([
        { userId: "u5", role: "COMPLIANCE_OFFICER", scopeKey: "T:ten2", tenantId: "ten2" },
        { userId: "u5", role: "COMPLIANCE_OFFICER", scopeKey: "T:tenant_default", tenantId: "tenant_default" },
        { userId: "u6", role: "VIEWER", scopeKey: "T:ten2", tenantId: "ten2" },
        { userId: "u6", role: "VIEWER", scopeKey: "T:tenant_default", tenantId: "tenant_default" },
      ]);
      expect(await scalar<number>(db, `SELECT count(*)::int AS v FROM "user_roles"`)).toBe(5 + 4);

      // Every stored key is one the scope module reads back, and the keys it writes are the ones stored.
      const everyKey = [...Object.values(byId).map((r) => r.scopeKey), ...expanded.map((r) => r.scopeKey)];
      for (const key of everyKey) expect(parseScopeKey(key), key).toBeDefined();
      expect(parseScopeKey(byId["r-prod"].scopeKey)).toEqual({ kind: "PRODUCT", productId: "p2" });
      expect(byId["r-global"].scopeKey).toBe(scopeKey({ kind: "GLOBAL" }));
      expect(byId["r-tenant"].scopeKey).toBe(scopeKey({ kind: "TENANT", tenantId: "ten2" }));
      expect(byId["r-dom-tenant"].scopeKey).toBe(scopeKey({ kind: "DOMAIN", tenantId: "ten2", domainId: "d2" }));

      // New columns exist and start empty.
      expect(await scalar<number>(db, `SELECT count(*)::int AS v FROM "user_roles" WHERE "grantedById" IS NOT NULL`)).toBe(0);
      expect(await scalar<number>(db, `SELECT count(*)::int AS v FROM "users" WHERE "disabledAt" IS NOT NULL OR "lastLoginAt" IS NOT NULL`)).toBe(0);
      expect(await migrationRecorded(db)).toBe(true);
    });
  }, 60_000);

  it("lower-cases (and trims) the e-mails, keeps every user, and the lower(email) unique index refuses a case variant", async () => {
    await onOldSchema(async (db) => {
      await db.exec(user("u1", "Mixed.Case@Example.TEST"));
      await db.exec(user("u2", "  padded@example.test "));
      await db.exec(user("u3", "already@example.test"));
      await applyPgliteMigrations(db);
      expect(await rows(db, `SELECT "id","email" FROM "users" ORDER BY "id"`)).toEqual([
        { id: "u1", email: "mixed.case@example.test" },
        { id: "u2", email: "padded@example.test" },
        { id: "u3", email: "already@example.test" },
      ]);
      const refused = await failure(db, user("u4", "MIXED.case@example.TEST"));
      expect(refused?.code).toBe("23505");
      expect(refused?.message).toMatch(/users_email_lower_key/);
      // The exact-case unique index of Prisma's `@unique` is still there (findUnique({ where: { email } })).
      expect(await scalar<number>(db, `SELECT count(*)::int AS v FROM pg_indexes WHERE tablename = 'users' AND indexname = 'users_email_key'`)).toBe(1);
    });
  }, 60_000);

  it("backfills audit_log.tenantId where the entry's target tells it, leaves the rest null, and changes nothing else in the audit trail", async () => {
    await onOldSchema(async (db) => {
      await db.exec(user("u1", "u1@example.test"));
      await seedHierarchy(db);
      const entries = [
        audit("a-entity", "CREATE", "Entity", "e1"),
        audit("a-field", "UPDATE", "Field", "f1"),
        audit("a-domain", "CREATE", "Domain", "d2"),
        audit("a-product", "CREATE", "Product", "p2"),
        audit("a-event", "CREATE", "EventSpec", "s1"),
        audit("a-trait", "CREATE", "Trait", "t1"),
        audit("a-annotation-entity", "annotation.create", "Annotation", "e1"),
        audit("a-annotation-field", "annotation.create", "Annotation", "f1"),
        // The target is gone: the entry's own state names the tenant (and only a tenant that exists counts).
        audit("a-gone-state", "DELETE", "Entity", "gone-1", { tenantId: "ten2", name: "Old" }),
        audit("a-gone-bogus", "DELETE", "Entity", "gone-2", { tenantId: "no-such-tenant" }),
        audit("a-gone-plain", "DELETE", "Entity", "gone-3"),
        // Platform-level or not derivable.
        audit("a-user", "UPDATE", "User", "u1"),
        audit("a-git", "CREATE", "GitConfig", "g1"),
        audit("a-failed", "EMISSION_FAILED", "Entity", "e1", { message: "boom" }),
      ];
      for (const sql of entries) await db.exec(sql);
      const before = await rows(db, `SELECT "id","action","entityType","entityId","userId","timestamp","beforeState","afterState" FROM "audit_log" ORDER BY "id"`);

      await applyPgliteMigrations(db);

      const tenants = Object.fromEntries((await rows<{ id: string; tenantId: string | null }>(db, `SELECT "id","tenantId" FROM "audit_log"`)).map((r) => [r.id, r.tenantId]));
      expect(tenants).toEqual({
        "a-entity": "tenant_default",
        "a-field": "tenant_default",
        "a-domain": "ten2",
        "a-product": "ten2",
        "a-event": "ten2",
        "a-trait": "ten2",
        "a-annotation-entity": "tenant_default",
        "a-annotation-field": "tenant_default",
        "a-gone-state": "ten2",
        "a-gone-bogus": null,
        "a-gone-plain": null,
        "a-user": null,
        "a-git": null,
        "a-failed": "tenant_default",
      });
      // No row was added, removed or altered other than the new column.
      const after = await rows(db, `SELECT "id","action","entityType","entityId","userId","timestamp","beforeState","afterState" FROM "audit_log" ORDER BY "id"`);
      expect(after).toEqual(before);
      // The audit trail is still immutable: the migration lifted the trigger for its backfill only.
      const tampered = await failure(db, `UPDATE "audit_log" SET "action" = 'X' WHERE "id" = 'a-entity'`);
      expect(tampered?.message).toMatch(/immutable/);
      const deleted = await failure(db, `DELETE FROM "audit_log" WHERE "id" = 'a-entity'`);
      expect(deleted?.message).toMatch(/immutable/);
      expect(await scalar<string>(db, `SELECT tgenabled::text AS v FROM pg_trigger WHERE tgname = 'audit_log_immutable'`)).toBe("O");
    });
  }, 60_000);
});

describe("access_control migration: the constraints", () => {
  /** The migrated schema with two users, a tenant, a domain and a product, and one global ADMIN row for u1. */
  async function migrated(body: (db: PGlite) => Promise<void>) {
    await onOldSchema(async (db) => {
      await db.exec(user("u1", "u1@example.test"));
      await db.exec(user("u2", "u2@example.test"));
      await seedHierarchy(db);
      await db.exec(role("g1", "u1", "ADMIN"));
      await applyPgliteMigrations(db);
      await body(db);
    });
  }
  const insertRole = (id: string, userId: string, name: string, key: string, cols: { tenantId?: string; domainId?: string; productId?: string } = {}) =>
    `INSERT INTO "user_roles" ("id","userId","role","scopeKey","tenantId","domainId","productId")
     VALUES ('${id}','${userId}','${name}','${key}',${cols.tenantId ? `'${cols.tenantId}'` : "NULL"},${cols.domainId ? `'${cols.domainId}'` : "NULL"},${cols.productId ? `'${cols.productId}'` : "NULL"})`;

  it("refuses a second global ADMIN row for the same user (unique userId, role, scopeKey), but not another role or another user", async () => {
    await migrated(async (db) => {
      const duplicate = await failure(db, insertRole("g2", "u1", "ADMIN", "G"));
      expect(duplicate?.code).toBe("23505");
      expect(duplicate?.message).toMatch(/user_roles_userId_role_scopeKey_key/);
      expect(await failure(db, insertRole("g3", "u2", "ADMIN", "G"))).toBeUndefined();
      expect(await failure(db, insertRole("t1", "u1", "VIEWER", "T:ten2", { tenantId: "ten2" }))).toBeUndefined();
      const sameScopeTwice = await failure(db, insertRole("t2", "u1", "VIEWER", "T:ten2", { tenantId: "ten2" }));
      expect(sameScopeTwice?.code).toBe("23505");
    });
  }, 60_000);

  it.each([
    ["an unknown kind", "X:abc"],
    ["an empty key", ""],
    ["a global key with an id", "G:abc"],
    ["a scope letter without an id", "T:"],
    ["an id with a space", "D:a b"],
    ["an id with a second colon", "T:a:b"],
    ["an id with a control character", "T:a\tb"],
    ["lower-case kind", "t:abc"],
    ["an id longer than 128 characters", `P:${"x".repeat(129)}`],
  ])("the CHECK refuses a scopeKey that is %s", async (_label, key) => {
    await migrated(async (db) => {
      const refused = await failure(db, insertRole("bad", "u2", "VIEWER", key));
      expect(refused?.code).toBe("23514");
      expect(refused?.message).toMatch(/user_roles_scope_key_shape_check/);
    });
  }, 60_000);

  it("accepts the four key shapes with columns that agree with them", async () => {
    await migrated(async (db) => {
      expect(await failure(db, insertRole("ok-t", "u2", "VIEWER", "T:ten2", { tenantId: "ten2" }))).toBeUndefined();
      expect(await failure(db, insertRole("ok-d", "u2", "AUTHOR", "D:d2", { tenantId: "ten2", domainId: "d2" }))).toBeUndefined();
      expect(await failure(db, insertRole("ok-p", "u2", "STEWARD", "P:p2", { tenantId: "ten2", domainId: "d2", productId: "p2" }))).toBeUndefined();
      expect(await failure(db, insertRole("ok-g", "u2", "ADMIN", "G"))).toBeUndefined();
    });
  }, 60_000);

  it.each([
    ["a tenant key that names no tenant column", insertRole("c1", "u2", "VIEWER", "T:ten2")],
    ["a tenant key whose column is another tenant", insertRole("c2", "u2", "VIEWER", "T:ten2", { tenantId: "tenant_default" })],
    ["a domain key without its tenant", insertRole("c3", "u2", "VIEWER", "D:d2", { domainId: "d2" })],
    ["a domain key whose column is another domain", insertRole("c4", "u2", "VIEWER", "D:d2", { tenantId: "ten2", domainId: "d1" })],
    ["a product key without its domain", insertRole("c5", "u2", "VIEWER", "P:p2", { tenantId: "ten2", productId: "p2" })],
    ["a global key that carries a tenant column", insertRole("c6", "u2", "ADMIN", "G", { tenantId: "ten2" })],
  ])("the CHECK refuses %s", async (_label, sql) => {
    await migrated(async (db) => {
      const refused = await failure(db, sql);
      expect(refused?.code).toBe("23514");
      expect(refused?.message).toMatch(/user_roles_scope_columns_check/);
    });
  }, 60_000);

  it("does not refuse a global row of another role in the database: the policy engine ignores it, and the legacy admin screen still writes one until Task 7", async () => {
    await migrated(async (db) => {
      expect(await failure(db, insertRole("gc", "u2", "COMPLIANCE_OFFICER", "G"))).toBeUndefined();
    });
  }, 60_000);

  it("deleting a domain or a tenant removes its role rows (the scope columns are still foreign keys)", async () => {
    await migrated(async (db) => {
      await db.exec(insertRole("d-role", "u2", "AUTHOR", "D:d2", { tenantId: "ten2", domainId: "d2" }));
      await db.exec(insertRole("p-role", "u2", "STEWARD", "P:p2", { tenantId: "ten2", domainId: "d2", productId: "p2" }));
      await db.exec(insertRole("t-role", "u2", "VIEWER", "T:ten2", { tenantId: "ten2" }));
      await db.exec(`DELETE FROM "domains" WHERE "id" = 'd2'`);
      expect((await rows<{ id: string }>(db, `SELECT "id" FROM "user_roles" WHERE "userId" = 'u2' ORDER BY "id"`)).map((r) => r.id)).toEqual(["t-role"]);
      await db.exec(`DELETE FROM "tenants" WHERE "id" = 'ten2'`);
      expect(await scalar<number>(db, `SELECT count(*)::int AS v FROM "user_roles" WHERE "userId" = 'u2'`)).toBe(0);
    });
  }, 60_000);

  it("creates the new tables with their columns, and a granted-by id that is cleared when the granter goes", async () => {
    await migrated(async (db) => {
      const columns = async (table: string) =>
        (await rows<{ column_name: string }>(db, `SELECT column_name FROM information_schema.columns WHERE table_name = '${table}' ORDER BY column_name`)).map((r) => r.column_name);
      expect(await columns("invitations")).toEqual(["createdAt", "createdById", "emailLower", "expiresAt", "id", "tokenHash", "usedAt"]);
      expect(await columns("invitation_roles")).toEqual(["invitationId", "role", "scopeKey"]);
      expect(await columns("auth_tokens")).toEqual(["createdAt", "expiresAt", "id", "kind", "tokenHash", "usedAt", "userId"]);
      expect(await columns("auth_events")).toEqual(["createdAt", "emailHash", "id", "ipHash", "kind", "outcome"]);
      expect(await columns("audit_log")).toContain("tenantId");
      expect(await columns("users")).toEqual(expect.arrayContaining(["disabledAt", "lastLoginAt"]));
      expect(await columns("user_roles")).toEqual(expect.arrayContaining(["scopeKey", "grantedById"]));

      // invitations: token hash unique, spent flag, role grants cascade with the invitation and carry a valid key.
      await db.exec(`INSERT INTO "invitations" ("id","emailLower","tokenHash","expiresAt","createdById") VALUES ('i1','new@example.test','h1',${NOW} + interval '7 days','u1')`);
      await db.exec(`INSERT INTO "invitation_roles" ("invitationId","role","scopeKey") VALUES ('i1','VIEWER','T:ten2')`);
      expect((await failure(db, `INSERT INTO "invitations" ("id","emailLower","tokenHash","expiresAt","createdById") VALUES ('i2','x@example.test','h1',${NOW},'u1')`))?.code).toBe("23505");
      expect((await failure(db, `INSERT INTO "invitation_roles" ("invitationId","role","scopeKey") VALUES ('i1','VIEWER','bogus')`))?.code).toBe("23514");
      expect((await failure(db, `INSERT INTO "invitation_roles" ("invitationId","role","scopeKey") VALUES ('i1','VIEWER','T:ten2')`))?.code).toBe("23505");
      await db.exec(`DELETE FROM "invitations" WHERE "id" = 'i1'`);
      expect(await scalar<number>(db, `SELECT count(*)::int AS v FROM "invitation_roles"`)).toBe(0);

      // auth_tokens: the two kinds only, hash unique, user optional.
      await db.exec(`INSERT INTO "auth_tokens" ("id","userId","kind","tokenHash","expiresAt") VALUES ('k1',NULL,'INVITE','th1',${NOW}),('k2','u1','RESET','th2',${NOW})`);
      expect((await failure(db, `INSERT INTO "auth_tokens" ("id","kind","tokenHash","expiresAt") VALUES ('k3','OTHER','th3',${NOW})`))?.code).toBe("22P02");
      expect((await failure(db, `INSERT INTO "auth_tokens" ("id","kind","tokenHash","expiresAt") VALUES ('k4','RESET','th2',${NOW})`))?.code).toBe("23505");

      // auth_events: no user reference, only hashes.
      await db.exec(`INSERT INTO "auth_events" ("id","kind","emailHash","ipHash","outcome") VALUES ('ev1','LOGIN','eh','ih','FAILURE')`);

      // user_roles.grantedById: set null when the granter is deleted, the grant stays.
      await db.exec(`UPDATE "user_roles" SET "grantedById" = 'u2' WHERE "id" = 'g1'`);
      await db.exec(`DELETE FROM "users" WHERE "id" = 'u2'`);
      expect(await scalar<string | null>(db, `SELECT "grantedById" AS v FROM "user_roles" WHERE "id" = 'g1'`)).toBeNull();
    });
  }, 60_000);

  it("applies on an empty database (a fresh install) and creates no extension", async () => {
    const db = new PGlite();
    try {
      const before = await rows<{ extname: string }>(db, `SELECT extname FROM pg_extension ORDER BY extname`);
      const applied = await applyPgliteMigrations(db);
      // Applied, in order, after every earlier migration (a later one may follow it).
      expect(applied.indexOf(MIGRATION)).toBe(applied.indexOf("20261020_drop_legacy_event_catalog") + 1);
      expect(await rows<{ extname: string }>(db, `SELECT extname FROM pg_extension ORDER BY extname`)).toEqual(before);
      expect(await scalar<number>(db, `SELECT count(*)::int AS v FROM "user_roles"`)).toBe(0);
      expect(await migrationRecorded(db)).toBe(true);
    } finally {
      await db.close();
    }
  }, 120_000);
});

describe("access_control migration: refusals leave nothing behind", () => {
  /** The migration must refuse and change nothing: `needle` is the part of the message that names the offending rows. */
  async function expectRefused(db: PGlite, needle: RegExp, ...unchanged: string[]) {
    const snapshot = async () => Promise.all(unchanged.map((sql) => rows(db, sql)));
    const before = await snapshot();
    await expect(applyPgliteMigrations(db)).rejects.toThrow(needle);
    expect(await snapshot()).toEqual(before);
    expect(await migrationRecorded(db)).toBe(false);
    expect(await tableExists(db, "invitations")).toBe(false);
    expect(await scalar<number>(db, `SELECT count(*)::int AS v FROM information_schema.columns WHERE table_name = 'user_roles' AND column_name = 'scopeKey'`)).toBe(0);
  }

  it("refuses duplicate e-mails that differ by case or by surrounding spaces, and lists them", async () => {
    await onOldSchema(async (db) => {
      await db.exec(user("u1", "Dup@Example.test"));
      await db.exec(user("u2", "dup@example.test"));
      await db.exec(user("u3", "other@example.test"));
      await db.exec(user("u4", " other@example.test "));
      await db.exec(user("u5", "unique@example.test"));
      const message = await applyPgliteMigrations(db).then(
        () => "",
        (e: Error) => e.message
      );
      expect(message).toMatch(/Cannot enforce case-insensitive e-mail uniqueness/);
      expect(message).toContain("dup@example.test");
      expect(message).toContain("u1");
      expect(message).toContain("u2");
      expect(message).toContain("other@example.test");
      expect(message).toContain("u3");
      expect(message).toContain("u4");
      expect(message).not.toContain("unique@example.test");
      expect(message).toMatch(/never merges or deletes users/);
      await expectRefused(db, /Cannot enforce case-insensitive e-mail uniqueness/, `SELECT "id","email" FROM "users" ORDER BY "id"`);
    });
  }, 60_000);

  it("refuses role rows that would collide on (user, role, scope), and lists them", async () => {
    await onOldSchema(async (db) => {
      await db.exec(user("u1", "u1@example.test"));
      await seedHierarchy(db);
      await db.exec(role("g1", "u1", "ADMIN"));
      await db.exec(role("g2", "u1", "ADMIN")); // the old NULL-distinct hole
      await db.exec(role("d1a", "u1", "AUTHOR", { domainId: "d1" }));
      await db.exec(role("d1b", "u1", "AUTHOR", { domainId: "d1", tenantId: "tenant_default" })); // the same scope, written with its tenant
      await db.exec(role("ok", "u1", "VIEWER", { domainId: "d1" }));
      const message = await applyPgliteMigrations(db).then(
        () => "",
        (e: Error) => e.message
      );
      expect(message).toMatch(/Cannot make user_roles unique per \(user, role, scope\)/);
      expect(message).toContain("u1");
      expect(message).toMatch(/ADMIN/);
      expect(message).toContain("g1");
      expect(message).toContain("g2");
      expect(message).toContain("D:d1");
      expect(message).toContain("d1a");
      expect(message).toContain("d1b");
      expect(message).toMatch(/never deletes role rows/);
      await expectRefused(db, /Cannot make user_roles unique/, `SELECT * FROM "user_roles" ORDER BY "id"`);
    });
  }, 60_000);

  it("a global non-admin row that would expand onto a tenant row the user already holds is merged, not refused", async () => {
    await onOldSchema(async (db) => {
      await db.exec(user("u1", "u1@example.test"));
      await seedHierarchy(db);
      await db.exec(role("co-global", "u1", "COMPLIANCE_OFFICER"));
      await db.exec(role("co-tenant", "u1", "COMPLIANCE_OFFICER", { tenantId: "ten2" }));
      await applyPgliteMigrations(db);
      expect(await rows(db, `SELECT "id","scopeKey" FROM "user_roles" ORDER BY "scopeKey" COLLATE "C"`)).toEqual([
        { id: "co-tenant", scopeKey: "T:ten2" }, // the row that was already there is kept as it was
        expect.objectContaining({ scopeKey: "T:tenant_default" }),
      ]);
    });
  }, 60_000);
});

describe("access_control migration: rollback.sql (documented, never run automatically)", () => {
  const rollbackSql = () => readFileSync(`prisma/migrations/${MIGRATION}/rollback.sql`, "utf8");

  it("sits next to migration.sql, which is the only file the two runners read", () => {
    expect(readdirSync(`prisma/migrations/${MIGRATION}`).sort()).toEqual(["migration.sql", "rollback.sql"]);
  });

  it("restores the old shape, keeps what the old model can express, backs up (never widens) the rest, and the migration applies again", async () => {
    await onOldSchema(async (db) => {
      await db.exec(user("u1", "u1@example.test"));
      await db.exec(user("u2", "u2@example.test"));
      await db.exec(user("u3", "u3@example.test"));
      await db.exec(`UPDATE "users" SET "password" = 'hash' WHERE "id" IN ('u2','u3')`);
      await seedHierarchy(db);
      await db.exec(role("r-global", "u1", "ADMIN"));
      await db.exec(role("r-dom", "u2", "AUTHOR", { domainId: "d1" }));
      await db.exec(role("r-prod", "u2", "VIEWER", { productId: "p2" }));
      await db.exec(role("r-tenant", "u3", "VIEWER", { tenantId: "ten2" }));
      await applyPgliteMigrations(db);
      // After the migration: u3 is disabled and an auth event exists.
      await db.exec(`UPDATE "users" SET "disabledAt" = ${NOW} WHERE "id" = 'u3'`);
      await db.exec(`INSERT INTO "auth_events" ("id","kind","outcome") VALUES ('ev1','LOGIN','FAILURE')`);

      await db.exec(rollbackSql());

      // The new tables, columns, indexes and constraints are gone.
      for (const table of ["invitations", "invitation_roles", "auth_tokens", "auth_events"]) expect(await tableExists(db, table), table).toBe(false);
      const columns = async (table: string) =>
        (await rows<{ column_name: string }>(db, `SELECT column_name FROM information_schema.columns WHERE table_name = '${table}'`)).map((r) => r.column_name);
      const userRoleColumns = await columns("user_roles");
      expect(userRoleColumns).not.toContain("scopeKey");
      expect(userRoleColumns).not.toContain("grantedById");
      expect(await columns("audit_log")).not.toContain("tenantId");
      const userColumns = await columns("users");
      expect(userColumns).not.toContain("disabledAt");
      expect(userColumns).not.toContain("lastLoginAt");
      const indexes = (await rows<{ indexname: string }>(db, `SELECT indexname FROM pg_indexes WHERE tablename IN ('users','user_roles','audit_log')`)).map((r) => r.indexname);
      expect(indexes).toContain("user_roles_userId_role_tenantId_domainId_productId_key");
      expect(indexes).not.toContain("users_email_lower_key");
      expect(indexes).not.toContain("user_roles_userId_role_scopeKey_key");

      // Rows the old model expresses stay (global and domain-scoped); the tenant and product rows are in the backup, not widened in place.
      expect((await rows<{ id: string }>(db, `SELECT "id" FROM "user_roles" ORDER BY "id"`)).map((r) => r.id)).toEqual(["r-dom", "r-global"]);
      expect(await rows(db, `SELECT "id","scopeKey" FROM "user_roles_access_control_backup" ORDER BY "id"`)).toEqual([
        { id: "r-prod", scopeKey: "P:p2" },
        { id: "r-tenant", scopeKey: "T:ten2" },
      ]);
      // A user who was disabled cannot sign in with a password once the column is gone.
      expect(await rows(db, `SELECT "id","password" FROM "users" ORDER BY "id"`)).toEqual([
        { id: "u1", password: null },
        { id: "u2", password: "hash" },
        { id: "u3", password: null },
      ]);
      // The audit trail's immutability is intact.
      expect(await scalar<string>(db, `SELECT tgenabled::text AS v FROM pg_trigger WHERE tgname = 'audit_log_immutable'`)).toBe("O");

      // Rolled back means the runner may apply it again (after the tracking row is removed, as the file says).
      await db.exec(`DROP TABLE "user_roles_access_control_backup"`);
      await db.exec(`DELETE FROM "_pglite_migrations" WHERE name = '${MIGRATION}'`);
      expect(await applyPgliteMigrations(db)).toEqual([MIGRATION]);
      expect(await scalar<number>(db, `SELECT count(*)::int AS v FROM "user_roles"`)).toBe(2);
    });
  }, 60_000);
});
