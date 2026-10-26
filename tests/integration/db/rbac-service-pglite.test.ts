/**
 * `assignRole` / `removeRole` against a real database (PGlite with every migration, behind the same driver adapter the app uses): who may
 * grant and revoke is decided from the CALLER'S STORED rows (a label of the context grants nothing), a platform assignment is valid for ADMIN only,
 * an administrator cannot remove their own administrator row, the last enabled global administrator stays, and two administrators removing each
 * other at the same moment leave exactly one. (PGlite runs one transaction at a time, so this proves the rules on real SQL, the SERIALIZABLE
 * level being accepted, and the outcome of the race; the retry of a transaction the database aborts is in tests/unit/lib/serializable-transaction.test.ts.)
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "../../helpers/pglite-db";

const holder = vi.hoisted(() => ({ db: undefined as undefined | TestDb }));
vi.mock("@/lib/db", async () => {
  holder.db = await (await import("../../helpers/pglite-db")).createPgliteDb();
  return { prisma: holder.db.prisma };
});

import { assignRole, removeRole } from "@/services/rbac.service";
import { scopeKey } from "@/lib/access/scope";
import type { ServiceContext } from "@/types/service-context";

const db = () => holder.db!.prisma;
const ctxOf = (userId: string, userRole = "VIEWER"): ServiceContext => ({ userId, userRole, prisma: db() });
let counter = 0;
const fresh = (label: string) => `${label}-${++counter}`;

afterAll(async () => {
  await holder.db?.close();
});

beforeEach(async () => {
  await db().userRole.deleteMany();
  await db().user.deleteMany();
});

async function makeUser(label = "user", disabled = false) {
  return db().user.create({ data: { email: `${fresh(label)}@example.test`, disabledAt: disabled ? new Date() : null } });
}
async function makeWorld() {
  const tenantA = await db().tenant.create({ data: { name: fresh("Tenant"), slug: fresh("tenant") } });
  const tenantB = await db().tenant.create({ data: { name: fresh("Tenant"), slug: fresh("tenant") } });
  const domainA = await db().domain.create({ data: { tenantId: tenantA.id, name: "A", slug: fresh("a") } });
  const domainB = await db().domain.create({ data: { tenantId: tenantB.id, name: "B", slug: fresh("b") } });
  const productA = await db().product.create({ data: { domainId: domainA.id, name: "P", slug: fresh("p") } });
  return { tenantA, tenantB, domainA, domainB, productA };
}
const grantGlobalAdmin = (userId: string) => db().userRole.create({ data: { userId, role: "ADMIN", scopeKey: "G" } });
const grantTenantAdmin = (userId: string, tenantId: string) => db().userRole.create({ data: { userId, role: "ADMIN", scopeKey: scopeKey({ kind: "TENANT", tenantId }), tenantId } });
const rolesOf = (userId: string) => db().userRole.findMany({ where: { userId }, orderBy: { scopeKey: "asc" } });

describe("assignRole on a real database", () => {
  it("a global administrator assigns at every scope; the row's columns agree with its key and name the granter", async () => {
    const w = await makeWorld();
    const admin = await makeUser("admin");
    const target = await makeUser("target");
    await grantGlobalAdmin(admin.id);

    for (const input of [
      { role: "ADMIN" as const },
      { role: "COMPLIANCE_OFFICER" as const, tenantId: w.tenantA.id },
      { role: "STEWARD" as const, domainId: w.domainA.id },
      { role: "AUTHOR" as const, productId: w.productA.id },
    ]) {
      expect((await assignRole({ userId: target.id, ...input }, ctxOf(admin.id))).success).toBe(true);
    }
    const rows = await rolesOf(target.id);
    expect(rows.map((r) => [r.role, r.scopeKey, r.tenantId, r.domainId, r.productId, r.grantedById])).toEqual(
      expect.arrayContaining([
        ["ADMIN", "G", null, null, null, admin.id],
        ["COMPLIANCE_OFFICER", `T:${w.tenantA.id}`, w.tenantA.id, null, null, admin.id],
        ["STEWARD", `D:${w.domainA.id}`, w.tenantA.id, w.domainA.id, null, admin.id],
        ["AUTHOR", `P:${w.productA.id}`, w.tenantA.id, w.domainA.id, w.productA.id, admin.id],
      ])
    );
    expect(rows).toHaveLength(4);
  });

  it("refuses GLOBAL for every role but ADMIN, with a reason, and stores nothing", async () => {
    const admin = await makeUser("admin");
    const target = await makeUser("target");
    await grantGlobalAdmin(admin.id);
    for (const role of ["COMPLIANCE_OFFICER", "STEWARD", "AUTHOR", "VIEWER"] as const) {
      const result = await assignRole({ userId: target.id, role }, ctxOf(admin.id));
      expect(result).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
    }
    expect(await rolesOf(target.id)).toEqual([]);
  });

  it("a tenant administrator grants inside their tenant and cannot reach another tenant, a domain of another tenant or the platform", async () => {
    const w = await makeWorld();
    const tenantAdmin = await makeUser("tadmin");
    const target = await makeUser("target");
    await grantTenantAdmin(tenantAdmin.id, w.tenantA.id);
    const as = ctxOf(tenantAdmin.id, "ADMIN"); // the label is not what counts

    expect((await assignRole({ userId: target.id, role: "AUTHOR", domainId: w.domainA.id }, as)).success).toBe(true);
    expect((await assignRole({ userId: target.id, role: "ADMIN", tenantId: w.tenantA.id }, as)).success).toBe(true);
    const refusals = [
      await assignRole({ userId: target.id, role: "AUTHOR", tenantId: w.tenantB.id }, as),
      await assignRole({ userId: target.id, role: "AUTHOR", domainId: w.domainB.id }, as),
      await assignRole({ userId: target.id, role: "ADMIN" }, as),
    ];
    for (const refusal of refusals) expect(refusal).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
    expect(await rolesOf(target.id)).toHaveLength(2);
  });

  it("a user with a lower role, a label that says ADMIN, or a disabled account grants nothing", async () => {
    const w = await makeWorld();
    const author = await makeUser("author");
    const target = await makeUser("target");
    await db().userRole.create({ data: { userId: author.id, role: "AUTHOR", scopeKey: `D:${w.domainA.id}`, tenantId: w.tenantA.id, domainId: w.domainA.id } });
    expect(await assignRole({ userId: target.id, role: "VIEWER", domainId: w.domainA.id }, ctxOf(author.id, "ADMIN"))).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });

    const disabled = await makeUser("disabled", true);
    await grantGlobalAdmin(disabled.id);
    expect(await assignRole({ userId: target.id, role: "VIEWER", domainId: w.domainA.id }, ctxOf(disabled.id))).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
    expect(await rolesOf(target.id)).toEqual([]);
  });
});

describe("removeRole on a real database", () => {
  it("an administrator cannot remove their own administrator row, tenant row or global", async () => {
    const w = await makeWorld();
    const admin = await makeUser("admin");
    const other = await makeUser("other");
    const own = await grantGlobalAdmin(admin.id);
    await grantGlobalAdmin(other.id);
    const tenantOwn = await grantTenantAdmin(admin.id, w.tenantA.id);
    expect(await removeRole(own.id, ctxOf(admin.id))).toMatchObject({ success: false, error: { message: "Cannot remove your own admin role" } });
    expect(await removeRole(tenantOwn.id, ctxOf(admin.id))).toMatchObject({ success: false, error: { message: "Cannot remove your own admin role" } });
    expect(await rolesOf(admin.id)).toHaveLength(2);
  });

  it("removes another administrator while one remains; a tenant administrator cannot remove a platform administrator (not found, like a missing row)", async () => {
    const w = await makeWorld();
    const admin = await makeUser("admin");
    const other = await makeUser("other");
    const tenantAdmin = await makeUser("tadmin");
    await grantGlobalAdmin(admin.id);
    const otherRow = await grantGlobalAdmin(other.id);
    await grantTenantAdmin(tenantAdmin.id, w.tenantA.id);

    const refused = await removeRole(otherRow.id, ctxOf(tenantAdmin.id));
    const missing = await removeRole("no-such-row", ctxOf(tenantAdmin.id));
    expect(refused).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
    expect(JSON.stringify(refused)).toBe(JSON.stringify(missing));
    expect(await rolesOf(other.id)).toHaveLength(1);

    expect((await removeRole(otherRow.id, ctxOf(admin.id))).success).toBe(true);
    expect(await rolesOf(other.id)).toEqual([]);
  });

  it("a disabled administrator's row can be cleared, and the enabled administrator stays", async () => {
    const admin = await makeUser("admin");
    const disabledAdmin = await makeUser("gone", true);
    await grantGlobalAdmin(admin.id);
    const goneRow = await grantGlobalAdmin(disabledAdmin.id);
    // The disabled administrator's row can be cleared (it is not an administrator who could act) ...
    expect((await removeRole(goneRow.id, ctxOf(admin.id))).success).toBe(true);
    // ... and the one enabled administrator is still there.
    expect(await db().userRole.count({ where: { role: "ADMIN", scopeKey: "G" } })).toBe(1);
  });

  it("two administrators removing each other at the same moment leave exactly one", async () => {
    for (let round = 0; round < 5; round++) {
      await db().userRole.deleteMany();
      await db().user.deleteMany();
      const a = await makeUser("admin-a");
      const b = await makeUser("admin-b");
      const rowA = await grantGlobalAdmin(a.id);
      const rowB = await grantGlobalAdmin(b.id);

      const [aRemovesB, bRemovesA] = await Promise.all([removeRole(rowB.id, ctxOf(a.id)), removeRole(rowA.id, ctxOf(b.id))]);

      expect([aRemovesB.success, bRemovesA.success].filter(Boolean)).toHaveLength(1);
      const loser = aRemovesB.success ? bRemovesA : aRemovesB;
      expect(loser).toMatchObject({ success: false, error: { code: "FORBIDDEN" } });
      expect(await db().userRole.count({ where: { role: "ADMIN", scopeKey: "G" } })).toBe(1);
    }
  });

  it("three administrators removing one another in a ring never leave none", async () => {
    const users = [await makeUser("r1"), await makeUser("r2"), await makeUser("r3")];
    const rows = await Promise.all(users.map((u) => grantGlobalAdmin(u.id)));
    const results = await Promise.all(users.map((u, i) => removeRole(rows[(i + 1) % 3].id, ctxOf(u.id))));
    expect(results.filter((r) => r.success).length).toBeGreaterThanOrEqual(1);
    expect(await db().userRole.count({ where: { role: "ADMIN", scopeKey: "G" } })).toBeGreaterThanOrEqual(1);
  });
});
