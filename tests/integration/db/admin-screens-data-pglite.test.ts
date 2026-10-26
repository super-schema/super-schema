// @vitest-environment node
/**
 * What the Admin screens need beyond the user lifecycle itself, against a real database (PGlite with every migration):
 *  - `listUsers` says WHY a control is unavailable (the user is yourself, the last platform administrator, out of reach), in the service's own words, so a
 *    screen can disable the control with the reason and never has to compare a role name;
 *  - `listGrantableScopes` is the list of scopes the caller may grant a role in (the tenants, domains and products an administrator administers, each with the
 *    roles `grantAllowed` accepts there), which fills the scope pickers. A tenant administrator is offered their tenants only; platform scope is offered to a
 *    platform administrator only.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "../../helpers/pglite-db";

const holder = vi.hoisted(() => ({ db: undefined as undefined | TestDb }));
vi.mock("@/lib/db", async () => {
  holder.db = await (await import("../../helpers/pglite-db")).createPgliteDb();
  return { prisma: holder.db.prisma };
});

import { listUsers } from "@/services/user.service";
import { listGrantableScopes } from "@/services/user-directory.service";
import type { ServiceContext } from "@/types/service-context";
import { ROLE_HIERARCHY } from "@/types/schemas/rbac";

const db = () => holder.db!.prisma;
const ctxOf = (userId: string): ServiceContext => ({ userId, userRole: "VIEWER", prisma: db() });
let counter = 0;
const fresh = (label: string) => `${label}-${++counter}`;

afterAll(async () => {
  await holder.db?.close();
});

beforeEach(async () => {
  await db().$executeRawUnsafe('TRUNCATE TABLE "audit_log"');
  await db().invitation.deleteMany();
  await db().authToken.deleteMany();
  await db().userRole.deleteMany();
  await db().user.deleteMany();
  await db().domain.deleteMany();
  await db().tenant.deleteMany({ where: { isSystem: false } });
});

const makeUser = (label: string, disabled = false) => db().user.create({ data: { email: `${fresh(label)}@example.test`, disabledAt: disabled ? new Date() : null } });
const grant = (userId: string, role: string, scope: { key: string; tenantId?: string; domainId?: string; productId?: string }) =>
  db().userRole.create({ data: { userId, role, scopeKey: scope.key, tenantId: scope.tenantId ?? null, domainId: scope.domainId ?? null, productId: scope.productId ?? null } });
const grantGlobalAdmin = (userId: string) => grant(userId, "ADMIN", { key: "G" });
const grantTenant = (userId: string, role: string, tenantId: string) => grant(userId, role, { key: `T:${tenantId}`, tenantId });
const grantDomain = (userId: string, role: string, tenantId: string, domainId: string) => grant(userId, role, { key: `D:${domainId}`, tenantId, domainId });

async function makeWorld() {
  const tenantA = await db().tenant.create({ data: { name: fresh("Alpha"), slug: fresh("alpha") } });
  const tenantB = await db().tenant.create({ data: { name: fresh("Beta"), slug: fresh("beta") } });
  const tenantC = await db().tenant.create({ data: { name: fresh("Gamma"), slug: fresh("gamma"), isActive: false } });
  const domainA = await db().domain.create({ data: { tenantId: tenantA.id, name: "Payments", slug: fresh("pay") } });
  const domainB = await db().domain.create({ data: { tenantId: tenantB.id, name: "Billing", slug: fresh("bill") } });
  const productA = await db().product.create({ data: { domainId: domainA.id, name: "Checkout", slug: fresh("co") } });
  return { tenantA, tenantB, tenantC, domainA, domainB, productA };
}
type World = Awaited<ReturnType<typeof makeWorld>>;

const GENERIC = { success: false, error: { code: "FORBIDDEN", message: "You do not have permission to do this" } };

describe("listUsers says why a control is unavailable", () => {
  it("the only platform administrator: their own row cannot be disabled and their platform role cannot be removed, and the reasons are about being the last one", async () => {
    const admin = await makeUser("admin");
    await grantGlobalAdmin(admin.id);
    const result = await listUsers(ctxOf(admin.id));
    expect(result.success).toBe(true);
    if (!result.success) return;
    const me = result.data.items.find((item) => item.userId === admin.id)!;
    expect(me.isSelf).toBe(true);
    expect(me.disableBlockedReason).toBe("Cannot disable the last platform administrator: at least one must stay enabled");
    expect(me.roles).toHaveLength(1);
    expect(me.roles[0].removeBlockedReason).toBe("Cannot remove the last admin role — at least one admin must remain");
  });

  it("with a second enabled platform administrator the rule that remains is the one about yourself; the other one's controls are free", async () => {
    const admin = await makeUser("admin");
    const other = await makeUser("other");
    await grantGlobalAdmin(admin.id);
    await grantGlobalAdmin(other.id);
    const result = await listUsers(ctxOf(admin.id));
    if (!result.success) throw new Error("setup");
    const me = result.data.items.find((item) => item.userId === admin.id)!;
    const them = result.data.items.find((item) => item.userId === other.id)!;
    expect(me.disableBlockedReason).toBe("You cannot disable your own account");
    expect(me.roles[0].removeBlockedReason).toBe("Cannot remove your own admin role");
    expect(them.disableBlockedReason).toBeNull();
    expect(them.roles[0].removeBlockedReason).toBeNull();
  });

  it("a DISABLED platform administrator does not count as one that stays: the enabled one left is the last", async () => {
    const admin = await makeUser("admin");
    const off = await makeUser("off", true);
    await grantGlobalAdmin(admin.id);
    await grantGlobalAdmin(off.id);
    const result = await listUsers(ctxOf(admin.id));
    if (!result.success) throw new Error("setup");
    const them = result.data.items.find((item) => item.userId === off.id)!;
    expect(them.status).toBe("disabled");
    // enabling them is always possible; removing their platform role does not touch the last ENABLED one
    expect(them.disableBlockedReason).toBeNull();
    expect(them.roles[0].removeBlockedReason).toBeNull();
    const me = result.data.items.find((item) => item.userId === admin.id)!;
    expect(me.disableBlockedReason).toBe("Cannot disable the last platform administrator: at least one must stay enabled");
  });

  it("a tenant administrator: their own row is blocked by the self rule, a user of their tenant is free, a user they cannot reach is blocked without saying why", async () => {
    const w = await makeWorld();
    const tenantAdmin = await makeUser("tadmin");
    await grantTenant(tenantAdmin.id, "ADMIN", w.tenantA.id);
    const member = await makeUser("member");
    await grantTenant(member.id, "AUTHOR", w.tenantA.id);
    const both = await makeUser("both");
    await grantTenant(both.id, "VIEWER", w.tenantA.id);
    await grantTenant(both.id, "VIEWER", w.tenantB.id);
    const result = await listUsers(ctxOf(tenantAdmin.id));
    if (!result.success) throw new Error("setup");
    const row = (id: string) => result.data.items.find((item) => item.userId === id)!;
    expect(row(tenantAdmin.id).disableBlockedReason).toBe("You cannot disable your own account");
    expect(row(tenantAdmin.id).roles[0].removeBlockedReason).toBe("Cannot remove your own admin role");
    expect(row(member.id).disableBlockedReason).toBeNull();
    expect(row(member.id).roles[0].removeBlockedReason).toBeNull();
    expect(row(both.id).manageable).toBe(false);
    expect(row(both.id).disableBlockedReason).toBe("This account cannot be changed from here.");
    // the reason names no tenant and no role: nothing of the other tenant
    expect(JSON.stringify(row(both.id))).not.toContain(w.tenantB.name);
    // an invitation has no account to disable: the control is the invitation's revoke
    expect(result.data.items.filter((i) => i.kind === "invitation").every((i) => i.disableBlockedReason !== null || i.manageable === false)).toBe(true);
  });
});

describe("listGrantableScopes", () => {
  it("everyone below a tenant administrator, and a domain administrator, gets the generic refusal", async () => {
    const w: World = await makeWorld();
    const roleless = await makeUser("roleless");
    const dadmin = await makeUser("dadmin");
    await grantDomain(dadmin.id, "ADMIN", w.tenantA.id, w.domainA.id);
    const viewers = await Promise.all(["VIEWER", "AUTHOR", "STEWARD", "COMPLIANCE_OFFICER"].map(async (role) => {
      const user = await makeUser(role.toLowerCase());
      await grantTenant(user.id, role, w.tenantA.id);
      return user;
    }));
    for (const user of [roleless, dadmin, ...viewers]) expect(await listGrantableScopes(ctxOf(user.id))).toMatchObject(GENERIC);
    expect(await listGrantableScopes(ctxOf("nobody"))).toMatchObject(GENERIC);
  });

  it("a tenant administrator is offered their tenant, its domains and their products, each with every role, and nothing of another tenant or the platform", async () => {
    const w = await makeWorld();
    const tenantAdmin = await makeUser("tadmin");
    await grantTenant(tenantAdmin.id, "ADMIN", w.tenantA.id);
    const result = await listGrantableScopes(ctxOf(tenantAdmin.id));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.canGrantPlatform).toBe(false);
    expect(result.data.truncated).toBe(false);
    expect(result.data.scopes.map((s) => [s.kind, s.depth, s.label])).toEqual([
      ["TENANT", 0, w.tenantA.name],
      ["DOMAIN", 1, `${w.tenantA.name} / Payments`],
      ["PRODUCT", 2, `${w.tenantA.name} / Payments / Checkout`],
    ]);
    for (const scope of result.data.scopes) expect(scope.roles).toEqual([...ROLE_HIERARCHY]);
    expect(result.data.scopes[2]).toMatchObject({ tenantId: w.tenantA.id, domainId: w.domainA.id, productId: w.productA.id, tenantName: w.tenantA.name, domainName: "Payments", productName: "Checkout" });
    expect(JSON.stringify(result.data)).not.toContain(w.tenantB.name);
    expect(JSON.stringify(result.data)).not.toContain("Billing");
  });

  it("a tenant administrator of two tenants is offered both; one who is only a viewer of the second is not offered it", async () => {
    const w = await makeWorld();
    const user = await makeUser("two");
    await grantTenant(user.id, "ADMIN", w.tenantA.id);
    await grantTenant(user.id, "VIEWER", w.tenantB.id);
    const first = await listGrantableScopes(ctxOf(user.id));
    expect(first.success && first.data.scopes.filter((s) => s.kind === "TENANT").map((s) => s.tenantId)).toEqual([w.tenantA.id]);
    await grantTenant(user.id, "ADMIN", w.tenantB.id);
    await db().userRole.deleteMany({ where: { userId: user.id, role: "VIEWER" } });
    const second = await listGrantableScopes(ctxOf(user.id));
    expect(second.success && second.data.scopes.filter((s) => s.kind === "TENANT").map((s) => s.tenantId).sort()).toEqual([w.tenantA.id, w.tenantB.id].sort());
  });

  it("a platform administrator is offered every ACTIVE tenant with its domains and products, and platform scope (ADMIN only, decided by the screen from `canGrantPlatform`)", async () => {
    const w = await makeWorld();
    const admin = await makeUser("gadmin");
    await grantGlobalAdmin(admin.id);
    const result = await listGrantableScopes(ctxOf(admin.id));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.canGrantPlatform).toBe(true);
    const tenants = result.data.scopes.filter((s) => s.kind === "TENANT").map((s) => s.tenantId);
    expect(tenants).toEqual(expect.arrayContaining([w.tenantA.id, w.tenantB.id]));
    expect(tenants).not.toContain(w.tenantC.id);
    expect(result.data.scopes.some((s) => s.kind === "DOMAIN" && s.domainId === w.domainB.id)).toBe(true);
    // parents come before their children (the screen lists them in this order)
    const keys = result.data.scopes.map((s) => s.scopeKey);
    expect(keys.indexOf(`T:${w.tenantA.id}`)).toBeLessThan(keys.indexOf(`D:${w.domainA.id}`));
    expect(keys.indexOf(`D:${w.domainA.id}`)).toBeLessThan(keys.indexOf(`P:${w.productA.id}`));
  });

  it("a disabled administrator is offered nothing", async () => {
    const w = await makeWorld();
    const off = await makeUser("off", true);
    await grantTenant(off.id, "ADMIN", w.tenantA.id);
    expect(await listGrantableScopes(ctxOf(off.id))).toMatchObject(GENERIC);
  });
});
