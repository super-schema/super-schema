/**
 * The life cycle of an account and the user directory against a real database (PGlite with every migration, behind the same driver adapter the app uses):
 * disabling and enabling, reset links, the user list and the role matrix. Who may do what to whom is decided from the actor's STORED rows; a user outside the
 * actor's reach answers exactly like one that does not exist; the change and its audit entry commit together; a disabled user is nobody to the REAL principal
 * loader on the next request; an account is never deleted.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "../../helpers/pglite-db";

const holder = vi.hoisted(() => ({ db: undefined as undefined | TestDb, session: { current: null as null | { user: { id: string; email: string } } } }));
vi.mock("@/lib/db", async () => {
  holder.db = await (await import("../../helpers/pglite-db")).createPgliteDb();
  return { prisma: holder.db.prisma };
});
vi.mock("@/lib/auth", () => ({ auth: async () => holder.session.current }));

import { createResetLink, getRoleMatrix, listUsers, setUserDisabled } from "@/services/user.service";
import { consumeResetToken, hashToken, INVALID_LINK_MESSAGE } from "@/lib/auth/tokens";
import { getPrincipal, loadPrincipalById } from "@/lib/access/principal";
import { authorize } from "@/lib/action-context";
import type { ServiceContext } from "@/types/service-context";

const db = () => holder.db!.prisma;
const ctxOf = (userId: string, userRole = "VIEWER"): ServiceContext => ({ userId, userRole, prisma: db() });
let counter = 0;
const fresh = (label: string) => `${label}-${++counter}`;
const PASSWORD = "tangerine-lantern-orbit-42";

afterAll(async () => {
  await holder.db?.close();
});

beforeEach(async () => {
  holder.session.current = null;
  await db().$executeRawUnsafe('TRUNCATE TABLE "audit_log"');
  await db().invitation.deleteMany();
  await db().authToken.deleteMany();
  await db().userRole.deleteMany();
  await db().user.deleteMany();
});

async function makeUser(label = "user", options: { disabled?: boolean; email?: string; name?: string; password?: string; lastLoginAt?: Date } = {}) {
  return db().user.create({
    data: { email: options.email ?? `${fresh(label)}@example.test`, name: options.name ?? null, password: options.password ?? null, disabledAt: options.disabled ? new Date() : null, lastLoginAt: options.lastLoginAt ?? null },
  });
}
async function makeWorld() {
  const tenantA = await db().tenant.create({ data: { name: fresh("Tenant A"), slug: fresh("tenant") } });
  const tenantB = await db().tenant.create({ data: { name: fresh("Tenant B"), slug: fresh("tenant") } });
  const domainA = await db().domain.create({ data: { tenantId: tenantA.id, name: "Payments", slug: fresh("a") } });
  const domainA2 = await db().domain.create({ data: { tenantId: tenantA.id, name: "Risk", slug: fresh("a2") } });
  const domainB = await db().domain.create({ data: { tenantId: tenantB.id, name: "Billing", slug: fresh("b") } });
  const productA = await db().product.create({ data: { domainId: domainA.id, name: "Checkout", slug: fresh("p") } });
  return { tenantA, tenantB, domainA, domainA2, domainB, productA };
}
type World = Awaited<ReturnType<typeof makeWorld>>;

const grant = (userId: string, role: string, scope: { key: string; tenantId?: string; domainId?: string; productId?: string }) =>
  db().userRole.create({ data: { userId, role, scopeKey: scope.key, tenantId: scope.tenantId ?? null, domainId: scope.domainId ?? null, productId: scope.productId ?? null } });
const grantGlobalAdmin = (userId: string) => grant(userId, "ADMIN", { key: "G" });
const grantTenant = (userId: string, role: string, tenantId: string) => grant(userId, role, { key: `T:${tenantId}`, tenantId });
const grantDomain = (userId: string, role: string, tenantId: string, domainId: string) => grant(userId, role, { key: `D:${domainId}`, tenantId, domainId });

const GENERIC_FORBIDDEN = { success: false, error: { code: "FORBIDDEN", message: "You do not have permission to do this", suggestedFix: "Contact your administrator" } };
const USER_NOT_FOUND = { success: false, error: { code: "NOT_FOUND", message: "User not found", suggestedFix: "Verify the user and try again." } };
const auditOf = (action: string) => db().auditLog.findMany({ where: { action }, orderBy: { timestamp: "asc" } });
const reload = (id: string) => db().user.findUniqueOrThrow({ where: { id } });

async function callers(w: World) {
  const make = async (label: string, roles: (userId: string) => Promise<unknown>) => {
    const user = await makeUser(label);
    await roles(user.id);
    return user;
  };
  return {
    roleless: await make("roleless", async () => undefined),
    viewer: await make("viewer", (id) => grantTenant(id, "VIEWER", w.tenantA.id)),
    author: await make("author", (id) => grantTenant(id, "AUTHOR", w.tenantA.id)),
    steward: await make("steward", (id) => grantTenant(id, "STEWARD", w.tenantA.id)),
    compliance: await make("compliance", (id) => grantTenant(id, "COMPLIANCE_OFFICER", w.tenantA.id)),
    domainAdmin: await make("dadmin", (id) => grantDomain(id, "ADMIN", w.tenantA.id, w.domainA.id)),
    tenantAdmin: await make("tadmin", (id) => grantTenant(id, "ADMIN", w.tenantA.id)),
    globalAdmin: await make("gadmin", (id) => grantGlobalAdmin(id)),
  };
}
const BELOW_TENANT_ADMIN = ["roleless", "viewer", "author", "steward", "compliance", "domainAdmin"] as const;

/** The targets a tenant administrator of A must NOT reach: they answer as one that does not exist. */
async function targetsOutOfReach(w: World) {
  const inBoth = await makeUser("both");
  await grantTenant(inBoth.id, "VIEWER", w.tenantA.id);
  await grantTenant(inBoth.id, "VIEWER", w.tenantB.id);
  const platform = await makeUser("platform");
  await grantGlobalAdmin(platform.id);
  const platformAndA = await makeUser("platform-a");
  await grantGlobalAdmin(platformAndA.id);
  await grantTenant(platformAndA.id, "VIEWER", w.tenantA.id);
  const roleless = await makeUser("nobody");
  const inB = await makeUser("inb");
  await grantTenant(inB.id, "VIEWER", w.tenantB.id);
  return { inBoth, platform, platformAndA, roleless, inB };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// setUserDisabled
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("setUserDisabled: who may", () => {
  it("every rung below tenant administrator, a domain administrator included, gets the generic refusal and nothing changes", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const target = await makeUser("target");
    await grantTenant(target.id, "VIEWER", w.tenantA.id);
    for (const name of BELOW_TENANT_ADMIN) expect(await setUserDisabled(target.id, true, ctxOf(who[name].id, "ADMIN")), name).toEqual(GENERIC_FORBIDDEN);
    expect((await reload(target.id)).disabledAt).toBeNull();
    expect(await db().auditLog.count()).toBe(0);
  });

  it("a tenant administrator disables a user whose roles all lie in their tenant (a tenant, a domain and a product role): audited in that tenant", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const target = await makeUser("target");
    await grantTenant(target.id, "VIEWER", w.tenantA.id);
    await grantDomain(target.id, "AUTHOR", w.tenantA.id, w.domainA.id);
    await grant(target.id, "STEWARD", { key: `P:${w.productA.id}`, tenantId: w.tenantA.id, domainId: w.domainA.id, productId: w.productA.id });

    const before = Date.now();
    const result = await setUserDisabled(target.id, true, ctxOf(who.tenantAdmin.id));
    expect(result).toEqual({ success: true, data: { userId: target.id, disabled: true, changed: true, revokedResetLinks: 0 } });
    const row = await reload(target.id);
    expect(row.disabledAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);

    const [entry] = await auditOf("USER_DISABLED");
    expect(entry).toMatchObject({ entityType: "User", entityId: target.id, userId: who.tenantAdmin.id, tenantId: w.tenantA.id, beforeState: { disabledAt: null } });
    expect((entry.afterState as { disabledAt: string }).disabledAt).toBe(row.disabledAt!.toISOString());
  });

  it("a tenant administrator cannot reach: a user with a role in another tenant too, a platform administrator, one with no role, one of another tenant, a missing id: ONE answer, byte for byte, nothing changes", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const out = await targetsOutOfReach(w);
    const as = ctxOf(who.tenantAdmin.id);
    const answers = [
      await setUserDisabled(out.inBoth.id, true, as),
      await setUserDisabled(out.platform.id, true, as),
      await setUserDisabled(out.platformAndA.id, true, as),
      await setUserDisabled(out.roleless.id, true, as),
      await setUserDisabled(out.inB.id, true, as),
      await setUserDisabled("no-such-user", true, as),
      await setUserDisabled("", true, as),
      await setUserDisabled(undefined as never, true, as),
    ];
    for (const answer of answers) expect(answer).toEqual(USER_NOT_FOUND);
    for (const user of Object.values(out)) expect((await reload(user.id)).disabledAt).toBeNull();
    expect(await db().auditLog.count()).toBe(0);
  });

  it("a platform administrator disables any user: a roleless one, one in two tenants, another platform administrator", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const out = await targetsOutOfReach(w);
    const as = ctxOf(who.globalAdmin.id);
    for (const user of [out.roleless, out.inBoth, out.inB, out.platform]) expect((await setUserDisabled(user.id, true, as)).success, user.email).toBe(true);
    expect(await auditOf("USER_DISABLED")).toHaveLength(4);
    // A user whose roles span tenants is a platform-level entry; one tenant's user is that tenant's.
    const both = (await auditOf("USER_DISABLED")).find((e) => e.entityId === out.inBoth.id);
    expect(both!.tenantId).toBeNull();
    expect((await auditOf("USER_DISABLED")).find((e) => e.entityId === out.inB.id)!.tenantId).toBe(w.tenantB.id);
  });

  it("nobody disables themselves, whatever they are (the one refusal that says why)", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    for (const name of ["tenantAdmin", "globalAdmin"] as const) {
      const result = await setUserDisabled(who[name].id, true, ctxOf(who[name].id));
      expect(result).toMatchObject({ success: false, error: { code: "FORBIDDEN", message: "You cannot disable your own account" } });
      expect((await reload(who[name].id)).disabledAt).toBeNull();
    }
  });

  it("a disabled administrator, and a user who does not exist, disable nobody", async () => {
    const w = await makeWorld();
    const gone = await makeUser("gone", { disabled: true });
    await grantGlobalAdmin(gone.id);
    const target = await makeUser("target");
    await grantTenant(target.id, "VIEWER", w.tenantA.id);
    expect(await setUserDisabled(target.id, true, ctxOf(gone.id))).toEqual(GENERIC_FORBIDDEN);
    expect(await setUserDisabled(target.id, true, ctxOf("no-such-user"))).toEqual(GENERIC_FORBIDDEN);
    expect((await reload(target.id)).disabledAt).toBeNull();
  });

  it("a label that says ADMIN on the context grants nothing (the actor's STORED roles decide)", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const target = await makeUser("target");
    await grantTenant(target.id, "VIEWER", w.tenantA.id);
    expect(await setUserDisabled(target.id, true, ctxOf(who.author.id, "ADMIN"))).toEqual(GENERIC_FORBIDDEN);
  });

  it("refuses a `disabled` that is not a boolean", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    expect(await setUserDisabled(who.viewer.id, "yes" as never, ctxOf(who.globalAdmin.id))).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
  });
});

describe("setUserDisabled: enabling, repeating, and what disabling takes with it", () => {
  it("enables a disabled user (same reach), audited USER_ENABLED; out of reach it is the not-found", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const mine = await makeUser("mine", { disabled: true });
    await grantTenant(mine.id, "VIEWER", w.tenantA.id);
    const theirs = await makeUser("theirs", { disabled: true });
    await grantTenant(theirs.id, "VIEWER", w.tenantB.id);

    expect(await setUserDisabled(theirs.id, false, ctxOf(who.tenantAdmin.id))).toEqual(USER_NOT_FOUND);
    expect((await reload(theirs.id)).disabledAt).not.toBeNull();
    expect(await setUserDisabled(mine.id, false, ctxOf(who.tenantAdmin.id))).toEqual({ success: true, data: { userId: mine.id, disabled: false, changed: true, revokedResetLinks: 0 } });
    expect((await reload(mine.id)).disabledAt).toBeNull();
    const [entry] = await auditOf("USER_ENABLED");
    expect(entry).toMatchObject({ entityId: mine.id, userId: who.tenantAdmin.id, tenantId: w.tenantA.id, afterState: { disabledAt: null } });
    expect((entry.beforeState as { disabledAt: string }).disabledAt).toEqual(expect.any(String));
  });

  it("doing what is already done changes and writes nothing", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const active = await makeUser("active");
    await grantTenant(active.id, "VIEWER", w.tenantA.id);
    expect(await setUserDisabled(active.id, false, ctxOf(who.tenantAdmin.id))).toEqual({ success: true, data: { userId: active.id, disabled: false, changed: false, revokedResetLinks: 0 } });
    expect((await setUserDisabled(active.id, true, ctxOf(who.tenantAdmin.id))).success).toBe(true);
    const stamp = (await reload(active.id)).disabledAt;
    expect(await setUserDisabled(active.id, true, ctxOf(who.tenantAdmin.id))).toMatchObject({ success: true, data: { changed: false } });
    expect((await reload(active.id)).disabledAt).toEqual(stamp);
    expect(await auditOf("USER_DISABLED")).toHaveLength(1);
    expect(await auditOf("USER_ENABLED")).toHaveLength(0);
  });

  it("disabling ends the user's outstanding reset links (and says how many); the links of others are untouched", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const target = await makeUser("target", { password: "x" });
    await grantTenant(target.id, "VIEWER", w.tenantA.id);
    const other = await makeUser("other", { password: "x" });
    await grantTenant(other.id, "VIEWER", w.tenantA.id);
    const first = await createResetLink(target.id, ctxOf(who.tenantAdmin.id));
    const otherLink = await createResetLink(other.id, ctxOf(who.tenantAdmin.id));
    if (!first.success || !otherLink.success) throw new Error("setup");
    // A second live link for the target made around the service (as an older version of the app could have): both must die.
    const extra = "B".repeat(43);
    await db().authToken.create({ data: { userId: target.id, kind: "RESET", tokenHash: hashToken(extra), expiresAt: new Date(Date.now() + 3_600_000) } });

    const result = await setUserDisabled(target.id, true, ctxOf(who.tenantAdmin.id));
    expect(result).toMatchObject({ success: true, data: { changed: true, revokedResetLinks: 2 } });
    expect(await db().authToken.count({ where: { userId: target.id, usedAt: null } })).toBe(0);
    expect(await consumeResetToken(first.data.token, PASSWORD)).toEqual({ success: false, error: { code: "INVALID_LINK", message: INVALID_LINK_MESSAGE } });
    expect(await consumeResetToken(extra, PASSWORD)).toMatchObject({ success: false, error: { code: "INVALID_LINK" } });
    expect(await db().authToken.count({ where: { userId: other.id, usedAt: null } })).toBe(1);
    expect((await auditOf("USER_DISABLED"))[0].afterState).toMatchObject({ revokedResetLinks: 2 });
  });
});

describe("setUserDisabled: takes effect on the next request, through the REAL principal loader", () => {
  it("a signed-in user who is disabled is nobody on their next request: no principal, authorize says not authenticated", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const target = await makeUser("target");
    await grantTenant(target.id, "VIEWER", w.tenantA.id);
    holder.session.current = { user: { id: target.id, email: target.email } }; // a session that is still valid (a signed token with 12 hours to run)

    expect(await getPrincipal()).toMatchObject({ userId: target.id, isGlobalAdmin: false });
    expect(await authorize("entity.read", { tenantId: w.tenantA.id })).toMatchObject({ success: true });

    expect((await setUserDisabled(target.id, true, ctxOf(who.tenantAdmin.id))).success).toBe(true);
    expect(await getPrincipal()).toBeNull();
    expect(await loadPrincipalById(target.id)).toBeNull();
    expect(await authorize("entity.read", { tenantId: w.tenantA.id })).toMatchObject({ success: false, error: { code: "UNAUTHORIZED" } });

    expect((await setUserDisabled(target.id, false, ctxOf(who.tenantAdmin.id))).success).toBe(true);
    expect(await getPrincipal()).toMatchObject({ userId: target.id });
  });

  it("a disabled administrator can no longer act: the services read the actor from the database each time", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const target = await makeUser("target");
    await grantTenant(target.id, "VIEWER", w.tenantA.id);
    expect((await setUserDisabled(who.tenantAdmin.id, true, ctxOf(who.globalAdmin.id))).success).toBe(true);
    expect(await setUserDisabled(target.id, true, ctxOf(who.tenantAdmin.id))).toEqual(GENERIC_FORBIDDEN);
  });
});

describe("setUserDisabled: audit and races", () => {
  it("the change and its entry commit together: when the entry cannot be written, the user stays enabled", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const target = await makeUser("target");
    await grantTenant(target.id, "VIEWER", w.tenantA.id);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await db().$executeRawUnsafe(`CREATE OR REPLACE FUNCTION refuse_disable_audit() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'audit refused'; END; $$ LANGUAGE plpgsql`);
    await db().$executeRawUnsafe(`CREATE TRIGGER refuse_disable_audit_trigger BEFORE INSERT ON audit_log FOR EACH ROW WHEN (NEW.action = 'USER_DISABLED') EXECUTE FUNCTION refuse_disable_audit()`);
    try {
      expect(await setUserDisabled(target.id, true, ctxOf(who.tenantAdmin.id))).toMatchObject({ success: false, error: { code: "INTERNAL_ERROR" } });
      expect((await reload(target.id)).disabledAt).toBeNull();
    } finally {
      await db().$executeRawUnsafe("DROP TRIGGER refuse_disable_audit_trigger ON audit_log");
    }
  });

  it("two platform administrators disabling each other at the same moment leave exactly one enabled", async () => {
    for (let round = 0; round < 5; round++) {
      await db().$executeRawUnsafe('TRUNCATE TABLE "audit_log"');
      await db().userRole.deleteMany();
      await db().user.deleteMany();
      const a = await makeUser("admin-a");
      const b = await makeUser("admin-b");
      await grantGlobalAdmin(a.id);
      await grantGlobalAdmin(b.id);
      const [aDisablesB, bDisablesA] = await Promise.all([setUserDisabled(b.id, true, ctxOf(a.id)), setUserDisabled(a.id, true, ctxOf(b.id))]);
      expect([aDisablesB.success, bDisablesA.success].filter(Boolean)).toHaveLength(1);
      expect(await db().user.count({ where: { disabledAt: null, roles: { some: { scopeKey: "G", role: "ADMIN" } } } })).toBe(1);
    }
  });

  it("a transaction that loses the race once is run again: one change, one entry (the faked P2034 retry)", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const target = await makeUser("target");
    await grantTenant(target.id, "VIEWER", w.tenantA.id);
    const original = db().$transaction.bind(db());
    let rounds = 0;
    const spy = vi.spyOn(db(), "$transaction").mockImplementation(((work: never, options: never) => {
      if (++rounds === 1) return Promise.reject(Object.assign(new Error("write conflict"), { code: "P2034" }));
      return original(work, options);
    }) as never);
    try {
      expect((await setUserDisabled(target.id, true, ctxOf(who.tenantAdmin.id))).success).toBe(true);
      expect(rounds).toBe(2);
    } finally {
      spy.mockRestore();
    }
    expect(await auditOf("USER_DISABLED")).toHaveLength(1);
  });
});

describe("accounts are never deleted", () => {
  it("a user who has acted cannot be deleted (their audit entries are immutable and point at them): the database refuses, so disabling is the only way", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const target = await makeUser("target");
    await grantTenant(target.id, "VIEWER", w.tenantA.id);
    await setUserDisabled(target.id, true, ctxOf(who.tenantAdmin.id));
    await expect(db().user.delete({ where: { id: who.tenantAdmin.id } })).rejects.toBeDefined();
    expect(await db().user.count({ where: { id: who.tenantAdmin.id } })).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// createResetLink
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("createResetLink", () => {
  it("every rung below tenant administrator gets the generic refusal; no link is made", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const target = await makeUser("target");
    await grantTenant(target.id, "VIEWER", w.tenantA.id);
    for (const name of BELOW_TENANT_ADMIN) expect(await createResetLink(target.id, ctxOf(who[name].id, "ADMIN")), name).toEqual(GENERIC_FORBIDDEN);
    expect(await db().authToken.count()).toBe(0);
  });

  it("a tenant administrator makes a one-hour link for a user of their tenant: it works once, only its hash is stored, and the entry is theirs, in the tenant", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const target = await makeUser("target", { password: "old-password-that-is-not-a-hash" });
    await grantTenant(target.id, "VIEWER", w.tenantA.id);

    const before = Date.now();
    const result = await createResetLink(target.id, ctxOf(who.tenantAdmin.id));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({ userId: target.id, path: `/reset/${result.data.token}`, invalidatedLinks: 0 });
    expect(result.data.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.data.expiresAt.getTime() - before).toBeGreaterThan(3_600_000 - 60_000);
    expect(result.data.expiresAt.getTime() - before).toBeLessThan(3_600_000 + 60_000);

    const [stored] = await db().authToken.findMany({ where: { userId: target.id } });
    expect(stored).toMatchObject({ kind: "RESET", tokenHash: hashToken(result.data.token), usedAt: null });
    expect(JSON.stringify(await db().authToken.findMany())).not.toContain(result.data.token);

    const [entry] = await auditOf("PASSWORD_RESET_ISSUED");
    expect(entry).toMatchObject({ entityType: "User", entityId: target.id, userId: who.tenantAdmin.id, tenantId: w.tenantA.id });
    expect(JSON.stringify(entry)).not.toContain(result.data.token);

    expect(await consumeResetToken(result.data.token, PASSWORD)).toMatchObject({ success: true, data: { userId: target.id } });
    expect(await consumeResetToken(result.data.token, PASSWORD)).toMatchObject({ success: false, error: { code: "INVALID_LINK" } });
  }, 60_000);

  it("a tenant administrator cannot reach the same users as for disabling: the one not-found, no link, no entry", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const out = await targetsOutOfReach(w);
    const as = ctxOf(who.tenantAdmin.id);
    const answers = [
      await createResetLink(out.inBoth.id, as),
      await createResetLink(out.platform.id, as),
      await createResetLink(out.platformAndA.id, as),
      await createResetLink(out.roleless.id, as),
      await createResetLink(out.inB.id, as),
      await createResetLink("no-such-user", as),
      await createResetLink("", as),
    ];
    for (const answer of answers) expect(answer).toEqual(USER_NOT_FOUND);
    expect(await db().authToken.count()).toBe(0);
    expect(await db().auditLog.count()).toBe(0);
  });

  it("a platform administrator makes a link for any user, themselves included", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const out = await targetsOutOfReach(w);
    for (const id of [out.roleless.id, out.inBoth.id, out.platform.id, who.globalAdmin.id]) expect((await createResetLink(id, ctxOf(who.globalAdmin.id))).success, id).toBe(true);
  });

  it("a new link replaces the old ones: only one is ever live, and the answer says how many stopped", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const target = await makeUser("target");
    const other = await makeUser("other");
    await grantTenant(target.id, "VIEWER", w.tenantA.id);
    await grantTenant(other.id, "VIEWER", w.tenantA.id);
    const first = await createResetLink(target.id, ctxOf(who.tenantAdmin.id));
    const otherLink = await createResetLink(other.id, ctxOf(who.tenantAdmin.id));
    const second = await createResetLink(target.id, ctxOf(who.tenantAdmin.id));
    if (!first.success || !second.success || !otherLink.success) throw new Error("setup");
    expect(second.data.invalidatedLinks).toBe(1);
    expect(await consumeResetToken(first.data.token, PASSWORD)).toMatchObject({ success: false, error: { code: "INVALID_LINK" } });
    expect(await db().authToken.count({ where: { userId: target.id, usedAt: null } })).toBe(1);
    expect(await db().authToken.count({ where: { userId: other.id, usedAt: null } })).toBe(1);
    expect(await consumeResetToken(second.data.token, PASSWORD)).toMatchObject({ success: true });
  }, 60_000);

  it("a disabled account cannot be reset: enable it first, and no link is made", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const target = await makeUser("target", { disabled: true });
    await grantTenant(target.id, "VIEWER", w.tenantA.id);
    expect(await createResetLink(target.id, ctxOf(who.tenantAdmin.id))).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
    expect(await db().authToken.count()).toBe(0);
  });

  it("two links for one user at the same moment leave exactly one live", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const target = await makeUser("target");
    await grantTenant(target.id, "VIEWER", w.tenantA.id);
    const results = await Promise.all([createResetLink(target.id, ctxOf(who.tenantAdmin.id)), createResetLink(target.id, ctxOf(who.globalAdmin.id))]);
    expect(results.some((r) => r.success)).toBe(true);
    expect(await db().authToken.count({ where: { userId: target.id, kind: "RESET", usedAt: null } })).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// listUsers
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("listUsers", () => {
  it("every rung below tenant administrator gets the generic refusal", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    for (const name of BELOW_TENANT_ADMIN) expect(await listUsers(ctxOf(who[name].id)), name).toEqual(GENERIC_FORBIDDEN);
  });

  it("a platform administrator lists every user, with status, last sign-in, and every role by the NAMES of its scope; pending invitations follow as `invited` rows", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const when = new Date("2026-10-20T10:00:00Z");
    const alice = await makeUser("alice", { name: "Alice", lastLoginAt: when });
    await grantTenant(alice.id, "VIEWER", w.tenantA.id);
    await grantDomain(alice.id, "AUTHOR", w.tenantA.id, w.domainA.id);
    await grant(alice.id, "STEWARD", { key: `P:${w.productA.id}`, tenantId: w.tenantA.id, domainId: w.domainA.id, productId: w.productA.id });
    const off = await makeUser("off", { disabled: true });
    await grantTenant(off.id, "VIEWER", w.tenantB.id);
    const { inviteUser } = await import("@/services/invitation.service");
    const invited = await inviteUser({ email: "new@example.test", roles: [{ role: "VIEWER", tenantId: w.tenantB.id }] }, ctxOf(who.globalAdmin.id));
    if (!invited.success) throw new Error("setup");

    const result = await listUsers(ctxOf(who.globalAdmin.id));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.truncated).toBe(false);
    const byEmail = Object.fromEntries(result.data.items.map((item) => [item.email, item]));
    expect(Object.keys(byEmail)).toEqual(expect.arrayContaining([alice.email, off.email, who.roleless.email, who.globalAdmin.email, "new@example.test"]));

    expect(byEmail[alice.email]).toMatchObject({ kind: "user", userId: alice.id, name: "Alice", status: "active", lastLoginAt: when, manageable: true, isSelf: false, invitationId: null, expiresAt: null });
    expect(byEmail[alice.email].roles.map((r) => [r.role, r.scope.kind, r.scope.label]).sort()).toEqual(
      [["VIEWER", "TENANT", w.tenantA.name], ["AUTHOR", "DOMAIN", `${w.tenantA.name} / Payments`], ["STEWARD", "PRODUCT", `${w.tenantA.name} / Payments / Checkout`]].sort()
    );
    const stored = await db().userRole.findMany({ where: { userId: alice.id } });
    expect(byEmail[alice.email].roles.map((r) => r.id).sort()).toEqual(stored.map((row) => row.id).sort());
    expect(byEmail[alice.email].roles.find((r) => r.role === "STEWARD")!.scope).toMatchObject({ tenantName: w.tenantA.name, domainName: "Payments", productName: "Checkout", productId: w.productA.id });
    expect(byEmail[off.email].status).toBe("disabled");
    expect(byEmail[who.roleless.email]).toMatchObject({ roles: [], status: "active" });
    expect(byEmail[who.globalAdmin.email].roles.map((r) => [r.role, r.scope.label])).toEqual([["ADMIN", "Platform"]]);
    expect(byEmail[who.globalAdmin.email].isSelf).toBe(true);

    expect(byEmail["new@example.test"]).toMatchObject({ kind: "invitation", userId: null, invitationId: invited.data.invitationId, status: "invited", manageable: false, name: null });
    expect(byEmail["new@example.test"].expiresAt).toEqual(invited.data.expiresAt);
    expect(byEmail["new@example.test"].roles.map((r) => [r.role, r.scope.label, r.id])).toEqual([["VIEWER", w.tenantB.name, null]]);
    // The users come first, in the order they were made; the invited rows after them.
    const kinds = result.data.items.map((item) => item.kind);
    expect(kinds.lastIndexOf("user")).toBeLessThan(kinds.indexOf("invitation"));
  });

  it("a tenant administrator lists only the users who hold a role in their tenant, with ONLY the roles held there, and nothing of any other tenant or the platform", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const out = await targetsOutOfReach(w);
    const mine = await makeUser("mine", { name: "Mine" });
    await grantDomain(mine.id, "AUTHOR", w.tenantA.id, w.domainA.id);

    const result = await listUsers(ctxOf(who.tenantAdmin.id));
    expect(result.success).toBe(true);
    if (!result.success) return;
    const emails = result.data.items.map((item) => item.email);
    // In: the people of tenant A (the callers' own tenant roles, the user above, and the two users who also hold roles elsewhere).
    for (const user of [who.viewer, who.author, who.steward, who.compliance, who.domainAdmin, who.tenantAdmin, mine, out.inBoth, out.platformAndA]) expect(emails, user.email).toContain(user.email);
    // Out: no role in tenant A at all (a roleless account, a user of tenant B only, a platform administrator with no tenant role).
    for (const user of [who.roleless, out.roleless, out.inB, out.platform, who.globalAdmin]) expect(emails, user.email).not.toContain(user.email);

    const both = result.data.items.find((item) => item.userId === out.inBoth.id)!;
    expect(both.roles.map((r) => r.scope.tenantId)).toEqual([w.tenantA.id]); // the role in tenant B is not shown, and not hinted at
    expect(both.manageable).toBe(false);
    const platformAndA = result.data.items.find((item) => item.userId === out.platformAndA.id)!;
    expect(platformAndA.roles.map((r) => r.role)).toEqual(["VIEWER"]); // the platform role is not shown
    expect(platformAndA.manageable).toBe(false);
    expect(result.data.items.find((item) => item.userId === mine.id)).toMatchObject({ manageable: true });
    expect(result.data.items.find((item) => item.userId === who.tenantAdmin.id)).toMatchObject({ isSelf: true });
    expect(JSON.stringify(result.data)).not.toContain(w.tenantB.name);
  });

  it("a tenant administrator sees the pending invitations of their tenant and not another's; a tenant filter they do not administer lists nothing", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const tenantAdminB = await makeUser("tadmin-b");
    await grantTenant(tenantAdminB.id, "ADMIN", w.tenantB.id);
    const { inviteUser } = await import("@/services/invitation.service");
    await inviteUser({ email: "in-a@example.test", roles: [{ role: "VIEWER", tenantId: w.tenantA.id }] }, ctxOf(who.tenantAdmin.id));
    await inviteUser({ email: "in-b@example.test", roles: [{ role: "VIEWER", tenantId: w.tenantB.id }] }, ctxOf(tenantAdminB.id));
    await inviteUser({ email: "platform@example.test", roles: [{ role: "ADMIN" }] }, ctxOf(who.globalAdmin.id));

    const mine = await listUsers(ctxOf(who.tenantAdmin.id));
    expect(mine.success && mine.data.items.filter((i) => i.kind === "invitation").map((i) => i.email)).toEqual(["in-a@example.test"]);
    const elsewhere = await listUsers(ctxOf(who.tenantAdmin.id), { tenantId: w.tenantB.id });
    expect(elsewhere).toEqual({ success: true, data: { items: [], truncated: false } });
    const missing = await listUsers(ctxOf(who.tenantAdmin.id), { tenantId: "no-such-tenant" });
    expect(missing).toEqual(elsewhere);
    const filtered = await listUsers(ctxOf(who.globalAdmin.id), { tenantId: w.tenantB.id });
    expect(filtered.success && filtered.data.items.map((i) => i.email).sort()).toEqual(["in-b@example.test", tenantAdminB.email].sort());
  });

  it("carries no secret: no password hash, no token", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const target = await makeUser("target", { password: "$2a$12$thisisnotarealhashbutlooksliekone0000000000000000000000" });
    await grantTenant(target.id, "VIEWER", w.tenantA.id);
    const link = await createResetLink(target.id, ctxOf(who.tenantAdmin.id));
    if (!link.success) throw new Error("setup");
    const text = JSON.stringify(await listUsers(ctxOf(who.globalAdmin.id)));
    expect(text).not.toContain("$2a$12$");
    expect(text).not.toContain(link.data.token);
    expect(text).not.toMatch(/password|tokenHash/i);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// getRoleMatrix
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("getRoleMatrix", () => {
  it("every rung below tenant administrator gets the generic refusal", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    for (const name of BELOW_TENANT_ADMIN) expect(await getRoleMatrix(w.tenantA.id, ctxOf(who[name].id)), name).toEqual(GENERIC_FORBIDDEN);
  });

  it("columns are the tenant, its domains and their products (with depth); a row for every user with a role in the tenant; each cell the highest role AT the scope and the role OVER it", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const viewer = await makeUser("viewer-all");
    await grantTenant(viewer.id, "VIEWER", w.tenantA.id);
    const mixed = await makeUser("mixed");
    await grantTenant(mixed.id, "VIEWER", w.tenantA.id);
    await grantTenant(mixed.id, "STEWARD", w.tenantA.id); // two roles at one scope: the highest is the cell
    await grantDomain(mixed.id, "AUTHOR", w.tenantA.id, w.domainA.id);
    const productOnly = await makeUser("product-only");
    await grant(productOnly.id, "VIEWER", { key: `P:${w.productA.id}`, tenantId: w.tenantA.id, domainId: w.domainA.id, productId: w.productA.id });

    const result = await getRoleMatrix(w.tenantA.id, ctxOf(who.tenantAdmin.id));
    expect(result.success).toBe(true);
    if (!result.success) return;
    const { data } = result;
    expect(data).toMatchObject({ tenantId: w.tenantA.id, tenantName: w.tenantA.name, truncated: false });
    expect(data.scopes.map((s) => [s.kind, s.depth, s.label])).toEqual([
      ["TENANT", 0, w.tenantA.name],
      ["DOMAIN", 1, `${w.tenantA.name} / Payments`],
      ["PRODUCT", 2, `${w.tenantA.name} / Payments / Checkout`],
      ["DOMAIN", 1, `${w.tenantA.name} / Risk`],
    ]);
    const key = { tenant: `T:${w.tenantA.id}`, payments: `D:${w.domainA.id}`, checkout: `P:${w.productA.id}`, risk: `D:${w.domainA2.id}` };
    const row = (id: string) => data.rows.find((r) => r.userId === id)!;

    expect(row(viewer.id).cells).toEqual({
      [key.tenant]: { direct: "VIEWER", effective: "VIEWER" },
      [key.payments]: { direct: null, effective: "VIEWER" },
      [key.checkout]: { direct: null, effective: "VIEWER" },
      [key.risk]: { direct: null, effective: "VIEWER" },
    });
    expect(row(mixed.id).cells).toEqual({
      [key.tenant]: { direct: "STEWARD", effective: "STEWARD" },
      [key.payments]: { direct: "AUTHOR", effective: "STEWARD" },
      [key.checkout]: { direct: null, effective: "STEWARD" },
      [key.risk]: { direct: null, effective: "STEWARD" },
    });
    expect(row(productOnly.id).cells).toEqual({
      [key.tenant]: { direct: null, effective: null },
      [key.payments]: { direct: null, effective: null },
      [key.checkout]: { direct: "VIEWER", effective: "VIEWER" },
      [key.risk]: { direct: null, effective: null },
    });
    // A user with no role in the tenant is not a row; the callers of the tenant are.
    expect(data.rows.map((r) => r.userId)).not.toContain(who.roleless.id);
    expect(data.rows.map((r) => r.userId)).not.toContain(who.globalAdmin.id);
    expect(data.rows.map((r) => r.userId)).toContain(who.tenantAdmin.id);
    expect(data.rows.every((r) => r.status === "active")).toBe(true);
  });

  it("another tenant, and a tenant that does not exist, are the SAME not-found for a tenant administrator; a platform administrator gets that answer only for a missing tenant", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const notFound = { success: false, error: { code: "NOT_FOUND", message: "Tenant not found", suggestedFix: "Verify the tenant and try again." } };
    expect(await getRoleMatrix(w.tenantB.id, ctxOf(who.tenantAdmin.id))).toEqual(notFound);
    expect(await getRoleMatrix("no-such-tenant", ctxOf(who.tenantAdmin.id))).toEqual(notFound);
    expect(await getRoleMatrix("", ctxOf(who.tenantAdmin.id))).toEqual(notFound);
    expect(await getRoleMatrix(undefined as never, ctxOf(who.tenantAdmin.id))).toEqual(notFound);
    expect(await getRoleMatrix("no-such-tenant", ctxOf(who.globalAdmin.id))).toEqual(notFound);
    expect((await getRoleMatrix(w.tenantB.id, ctxOf(who.globalAdmin.id))).success).toBe(true);
  });

  it("a tenant administrator sees only the roles held in the tenant, of a user who holds more; a platform administrator's `effective` also counts a platform role", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const shared = await makeUser("shared");
    await grantTenant(shared.id, "VIEWER", w.tenantA.id);
    await grantTenant(shared.id, "STEWARD", w.tenantB.id);
    await grantGlobalAdmin(shared.id);

    const asTenantAdmin = await getRoleMatrix(w.tenantA.id, ctxOf(who.tenantAdmin.id));
    const asPlatform = await getRoleMatrix(w.tenantA.id, ctxOf(who.globalAdmin.id));
    if (!asTenantAdmin.success || !asPlatform.success) throw new Error("setup");
    const tenantCell = `T:${w.tenantA.id}`;
    expect(asTenantAdmin.data.rows.find((r) => r.userId === shared.id)!.cells[tenantCell]).toEqual({ direct: "VIEWER", effective: "VIEWER" });
    expect(asPlatform.data.rows.find((r) => r.userId === shared.id)!.cells[tenantCell]).toEqual({ direct: "VIEWER", effective: "ADMIN" });
    // Nothing of the user's role in tenant B, nor of the platform role, reaches the tenant administrator.
    expect(JSON.stringify(asTenantAdmin.data.rows.find((r) => r.userId === shared.id))).not.toMatch(/STEWARD|ADMIN/);
  });

  it("a disabled user is a row marked disabled", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const off = await makeUser("off", { disabled: true });
    await grantTenant(off.id, "VIEWER", w.tenantA.id);
    const result = await getRoleMatrix(w.tenantA.id, ctxOf(who.tenantAdmin.id));
    expect(result.success && result.data.rows.find((r) => r.userId === off.id)!.status).toBe("disabled");
  });
});
