/**
 * Inviting, revoking and listing invitations against a real database (PGlite with every migration, behind the same driver adapter the app uses).
 * WHO may invite with which roles is decided from the actor's STORED rows; the answers for a target outside the actor's reach are the answers for one
 * that does not exist; every change writes its audit entry in its own transaction; and the link works: the invited person accepts it and holds exactly
 * the roles that were granted.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "../../helpers/pglite-db";

const holder = vi.hoisted(() => ({ db: undefined as undefined | TestDb }));
vi.mock("@/lib/db", async () => {
  holder.db = await (await import("../../helpers/pglite-db")).createPgliteDb();
  return { prisma: holder.db.prisma };
});

import { inviteUser, listPendingInvitations, revokeInvitation } from "@/services/invitation.service";
import { acceptInvitation, findValidInvitation, hashToken, INVALID_LINK_MESSAGE } from "@/lib/auth/tokens";
import type { ServiceContext } from "@/types/service-context";
import type { Role } from "@/types/schemas/rbac";

const db = () => holder.db!.prisma;
const ctxOf = (userId: string, userRole = "VIEWER"): ServiceContext => ({ userId, userRole, prisma: db() });
let counter = 0;
const fresh = (label: string) => `${label}-${++counter}`;
const PASSWORD = "tangerine-lantern-orbit-42";

afterAll(async () => {
  await holder.db?.close();
});

beforeEach(async () => {
  await db().$executeRawUnsafe('TRUNCATE TABLE "audit_log"');
  await db().invitation.deleteMany();
  await db().userRole.deleteMany();
  await db().user.deleteMany();
});

async function makeUser(label = "user", options: { disabled?: boolean; email?: string } = {}) {
  return db().user.create({ data: { email: options.email ?? `${fresh(label)}@example.test`, disabledAt: options.disabled ? new Date() : null } });
}
async function makeWorld() {
  const tenantA = await db().tenant.create({ data: { name: fresh("Tenant"), slug: fresh("tenant") } });
  const tenantB = await db().tenant.create({ data: { name: fresh("Tenant"), slug: fresh("tenant") } });
  const domainA = await db().domain.create({ data: { tenantId: tenantA.id, name: "Payments", slug: fresh("a") } });
  const domainB = await db().domain.create({ data: { tenantId: tenantB.id, name: "Billing", slug: fresh("b") } });
  const productA = await db().product.create({ data: { domainId: domainA.id, name: "Checkout", slug: fresh("p") } });
  return { tenantA, tenantB, domainA, domainB, productA };
}
type World = Awaited<ReturnType<typeof makeWorld>>;

const grant = (userId: string, role: string, scope: { key: string; tenantId?: string; domainId?: string; productId?: string }) =>
  db().userRole.create({ data: { userId, role, scopeKey: scope.key, tenantId: scope.tenantId ?? null, domainId: scope.domainId ?? null, productId: scope.productId ?? null } });
const grantGlobalAdmin = (userId: string) => grant(userId, "ADMIN", { key: "G" });
const grantTenant = (userId: string, role: string, tenantId: string) => grant(userId, role, { key: `T:${tenantId}`, tenantId });
const grantDomain = (userId: string, role: string, w: World) => grant(userId, role, { key: `D:${w.domainA.id}`, tenantId: w.tenantA.id, domainId: w.domainA.id });

const GENERIC_FORBIDDEN = { success: false, error: { code: "FORBIDDEN", message: "You do not have permission to do this", suggestedFix: "Contact your administrator" } };
const auditOf = (action: string) => db().auditLog.findMany({ where: { action }, orderBy: { timestamp: "asc" } });

/** The people who may call: a roleless user, each rung of the ladder at tenant A, a domain administrator, a tenant administrator, a global administrator. */
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
    domainAdmin: await make("dadmin", (id) => grantDomain(id, "ADMIN", w)),
    tenantAdmin: await make("tadmin", (id) => grantTenant(id, "ADMIN", w.tenantA.id)),
    globalAdmin: await make("gadmin", (id) => grantGlobalAdmin(id)),
  };
}

describe("inviteUser: who may invite with which roles", () => {
  it("into a whole tenant: only an administrator of that tenant and a platform administrator; every other rung gets the one generic refusal and nothing is created", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const allowed = new Set(["tenantAdmin", "globalAdmin"]);
    for (const [name, user] of Object.entries(who)) {
      const result = await inviteUser({ email: `${name}-invited@example.test`, roles: [{ role: "VIEWER", tenantId: w.tenantA.id }] }, ctxOf(user.id));
      if (allowed.has(name)) expect(result.success, name).toBe(true);
      else expect(result, name).toEqual(GENERIC_FORBIDDEN);
    }
    expect(await db().invitation.count()).toBe(2);
  });

  it("into a domain: a domain administrator too, and into its product; not into the sibling tenant's domain, not at tenant level, not at the platform", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const as = ctxOf(who.domainAdmin.id);
    expect((await inviteUser({ email: "one@example.test", roles: [{ role: "AUTHOR", domainId: w.domainA.id }] }, as)).success).toBe(true);
    expect((await inviteUser({ email: "two@example.test", roles: [{ role: "VIEWER", productId: w.productA.id }] }, as)).success).toBe(true);
    for (const roles of [[{ role: "VIEWER" as Role, tenantId: w.tenantA.id }], [{ role: "VIEWER" as Role, domainId: w.domainB.id }], [{ role: "ADMIN" as Role }]]) {
      expect(await inviteUser({ email: "three@example.test", roles }, as)).toEqual(GENERIC_FORBIDDEN);
    }
  });

  it("a tenant administrator invites into their tenant, its domains and products, and ADMIN at tenant level; never above their own role's reach", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const result = await inviteUser(
      {
        email: "many@example.test",
        roles: [
          { role: "ADMIN", tenantId: w.tenantA.id },
          { role: "AUTHOR", domainId: w.domainA.id },
          { role: "VIEWER", productId: w.productA.id },
        ],
      },
      ctxOf(who.tenantAdmin.id, "VIEWER") // the label of the context is not what counts
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    const row = await db().invitation.findUniqueOrThrow({ where: { id: result.data.invitationId }, include: { roles: true } });
    expect(row.roles.map((r) => `${r.role}@${r.scopeKey}`).sort()).toEqual([`ADMIN@T:${w.tenantA.id}`, `AUTHOR@D:${w.domainA.id}`, `VIEWER@P:${w.productA.id}`].sort());
    expect(row.createdById).toBe(who.tenantAdmin.id);
  });

  it("a tenant administrator cannot invite into another tenant, a domain of another tenant, the platform, or an id that names nothing: ONE answer, byte for byte", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const as = ctxOf(who.tenantAdmin.id);
    const attempts = [
      { role: "VIEWER" as Role, tenantId: w.tenantB.id },
      { role: "VIEWER" as Role, domainId: w.domainB.id },
      { role: "ADMIN" as Role },
      { role: "VIEWER" as Role, tenantId: "no-such-tenant" },
      { role: "VIEWER" as Role, domainId: "no-such-domain" },
      { role: "VIEWER" as Role, productId: "no-such-product" },
      { role: "VIEWER" as Role, tenantId: w.tenantB.id, domainId: w.domainA.id }, // ids that disagree
    ];
    const answers = [];
    for (const role of attempts) answers.push(await inviteUser({ email: "x@example.test", roles: [role] }, as));
    for (const answer of answers) expect(answer).toEqual(GENERIC_FORBIDDEN);
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(await db().invitation.count()).toBe(0);
  });

  it("a platform administrator invites to every scope and is told when a scope does not exist", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const as = ctxOf(who.globalAdmin.id);
    const ok = await inviteUser({ email: "root@example.test", roles: [{ role: "ADMIN" }, { role: "STEWARD", tenantId: w.tenantB.id }, { role: "AUTHOR", domainId: w.domainB.id }] }, as);
    expect(ok.success).toBe(true);
    expect(await inviteUser({ email: "x@example.test", roles: [{ role: "VIEWER", domainId: "no-such-domain" }] }, as)).toMatchObject({ success: false, error: { code: "NOT_FOUND", message: 'Domain "no-such-domain" not found' } });
  });

  it("one role the actor may not grant refuses the WHOLE invitation: no invitation row, no audit entry", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const result = await inviteUser(
      { email: "mixed@example.test", roles: [{ role: "VIEWER", tenantId: w.tenantA.id }, { role: "VIEWER", tenantId: w.tenantB.id }] },
      ctxOf(who.tenantAdmin.id)
    );
    expect(result).toEqual(GENERIC_FORBIDDEN);
    expect(await db().invitation.count()).toBe(0);
    expect(await auditOf("INVITATION_CREATED")).toEqual([]);
  });

  it("a platform role other than ADMIN is not a valid assignment, and says so", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    for (const role of ["VIEWER", "AUTHOR", "STEWARD", "COMPLIANCE_OFFICER"] as const) {
      expect(await inviteUser({ email: "x@example.test", roles: [{ role }] }, ctxOf(who.globalAdmin.id))).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
    }
  });

  it("a disabled administrator, and a user who does not exist, invite nobody", async () => {
    const w = await makeWorld();
    const gone = await makeUser("gone", { disabled: true });
    await grantGlobalAdmin(gone.id);
    expect(await inviteUser({ email: "x@example.test", roles: [{ role: "VIEWER", tenantId: w.tenantA.id }] }, ctxOf(gone.id))).toEqual(GENERIC_FORBIDDEN);
    expect(await inviteUser({ email: "x@example.test", roles: [{ role: "VIEWER", tenantId: w.tenantA.id }] }, ctxOf("no-such-user"))).toEqual(GENERIC_FORBIDDEN);
    expect(await db().invitation.count()).toBe(0);
  });
});

describe("inviteUser: the input", () => {
  async function admin() {
    const w = await makeWorld();
    const user = await makeUser("admin");
    await grantGlobalAdmin(user.id);
    return { w, as: ctxOf(user.id) };
  }

  it("normalizes the address (trim, lower case) and answers it normalized", async () => {
    const { w, as } = await admin();
    const result = await inviteUser({ email: "  New.Person@Example.TEST ", roles: [{ role: "VIEWER", tenantId: w.tenantA.id }] }, as);
    expect(result).toMatchObject({ success: true, data: { email: "new.person@example.test" } });
    if (result.success) expect((await db().invitation.findUniqueOrThrow({ where: { id: result.data.invitationId } })).emailLower).toBe("new.person@example.test");
  });

  it("refuses a bad address, no role, too many roles and a lifetime out of range, creating nothing", async () => {
    const { w, as } = await admin();
    const role = { role: "VIEWER" as Role, tenantId: w.tenantA.id };
    const bad = [
      await inviteUser({ email: "not-an-address", roles: [role] }, as),
      await inviteUser({ email: "", roles: [role] }, as),
      await inviteUser({ email: "a@example.test", roles: [] }, as),
      await inviteUser({ email: "a@example.test", roles: Array.from({ length: 51 }, () => role) }, as),
      await inviteUser({ email: "a@example.test", roles: [role], ttlHours: 0 }, as),
      await inviteUser({ email: "a@example.test", roles: [role], ttlHours: 24 * 31 }, as),
      await inviteUser({ email: "a@example.test", roles: [role], ttlHours: Number.NaN }, as),
      await inviteUser(null as never, as),
      await inviteUser({ email: 42, roles: "x" } as never, as),
    ];
    for (const answer of bad) expect(answer).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
    expect(await db().invitation.count()).toBe(0);
  });

  it("the lifetime defaults to seven days and takes a number of hours", async () => {
    const { w, as } = await admin();
    const role = { role: "VIEWER" as Role, tenantId: w.tenantA.id };
    const before = Date.now();
    const week = await inviteUser({ email: "week@example.test", roles: [role] }, as);
    const short = await inviteUser({ email: "short@example.test", roles: [role], ttlHours: 2 }, as);
    expect(week.success && short.success).toBe(true);
    if (!week.success || !short.success) return;
    expect(week.data.expiresAt.getTime() - before).toBeGreaterThan(7 * 24 * 3_600_000 - 60_000);
    expect(short.data.expiresAt.getTime() - before).toBeLessThan(2 * 3_600_000 + 60_000);
  });

  it("repeats of one role are folded", async () => {
    const { w, as } = await admin();
    const role = { role: "VIEWER" as Role, tenantId: w.tenantA.id };
    const result = await inviteUser({ email: "dup@example.test", roles: [role, role, { ...role }] }, as);
    expect(result.success).toBe(true);
    if (result.success) expect(await db().invitationRole.count({ where: { invitationId: result.data.invitationId } })).toBe(1);
  });
});

describe("inviteUser: an address that already has an account", () => {
  it("a platform administrator is told; so is a tenant administrator who can see that account (it holds a role in their tenant)", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const known = await makeUser("known", { email: "known@example.test" });
    await grantTenant(known.id, "VIEWER", w.tenantA.id);
    const roles = [{ role: "VIEWER" as Role, tenantId: w.tenantA.id }];
    expect(await inviteUser({ email: "known@example.test", roles }, ctxOf(who.globalAdmin.id))).toMatchObject({ success: false, error: { code: "ACCOUNT_EXISTS" } });
    expect(await inviteUser({ email: "KNOWN@example.test", roles }, ctxOf(who.tenantAdmin.id))).toMatchObject({ success: false, error: { code: "ACCOUNT_EXISTS" } });
    expect(await db().invitation.count()).toBe(0);
  });

  it("a tenant administrator who cannot see the account (no role of it in their tenant, or none at all) is told nothing: the hedged refusal, the same words for every such account", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const inB = await makeUser("inb", { email: "in-b@example.test" });
    await grantTenant(inB.id, "VIEWER", w.tenantB.id);
    await makeUser("none", { email: "none@example.test" });
    await makeUser("off", { email: "off@example.test", disabled: true });
    const roles = [{ role: "VIEWER" as Role, tenantId: w.tenantA.id }];
    const answers = [];
    for (const email of ["in-b@example.test", "none@example.test", "off@example.test"]) answers.push(await inviteUser({ email, roles }, ctxOf(who.tenantAdmin.id)));
    for (const answer of answers) {
      expect(answer).toMatchObject({ success: false, error: { code: "INVITATION_REFUSED" } });
      expect(JSON.stringify(answer)).not.toContain("example.test");
    }
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
    expect(await db().invitation.count()).toBe(0);
  });

  it("an address that has no account is invited (the lower-case rule: Known@ and known@ are one address)", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const result = await inviteUser({ email: "Fresh@Example.test", roles: [{ role: "VIEWER", tenantId: w.tenantA.id }] }, ctxOf(who.tenantAdmin.id));
    expect(result.success).toBe(true);
  });
});

describe("inviteUser: one pending invitation per address", () => {
  const roleIn = (tenantId: string) => [{ role: "VIEWER" as Role, tenantId }];
  const pending = (email: string) => db().invitation.findMany({ where: { emailLower: email, usedAt: null } });

  it("a second invitation replaces the first (the same administrator): the old link is dead, one row remains, the replacement is audited", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const as = ctxOf(who.tenantAdmin.id);
    const first = await inviteUser({ email: "again@example.test", roles: roleIn(w.tenantA.id) }, as);
    const second = await inviteUser({ email: "again@example.test", roles: roleIn(w.tenantA.id) }, as);
    expect(first.success && second.success).toBe(true);
    if (!first.success || !second.success) return;
    expect(first.data.replacedInvitations).toBe(0);
    expect(second.data.replacedInvitations).toBe(1);
    expect((await pending("again@example.test")).map((r) => r.id)).toEqual([second.data.invitationId]);
    expect(await findValidInvitation(first.data.token)).toBeNull();
    expect(await findValidInvitation(second.data.token)).toEqual({ email: "again@example.test" });
    const [entry] = await auditOf("INVITATION_REVOKED");
    expect(entry).toMatchObject({ entityType: "Invitation", entityId: first.data.invitationId, userId: who.tenantAdmin.id, tenantId: w.tenantA.id, afterState: { reason: "replaced", replacedBy: second.data.invitationId } });
  });

  it("another tenant administrator's invitation for the same address survives: a tenant cannot cancel another tenant's onboarding", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const tenantAdminB = await makeUser("tadmin-b");
    await grantTenant(tenantAdminB.id, "ADMIN", w.tenantB.id);
    const fromA = await inviteUser({ email: "shared@example.test", roles: roleIn(w.tenantA.id) }, ctxOf(who.tenantAdmin.id));
    const fromB = await inviteUser({ email: "shared@example.test", roles: roleIn(w.tenantB.id) }, ctxOf(tenantAdminB.id));
    expect(fromA.success && fromB.success).toBe(true);
    if (!fromA.success || !fromB.success) return;
    expect(fromB.data.replacedInvitations).toBe(0);
    expect(await pending("shared@example.test")).toHaveLength(2);
    expect(await findValidInvitation(fromA.data.token)).not.toBeNull();
  });

  it("a platform administrator replaces every earlier pending invitation for the address, whoever made it", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const a = await inviteUser({ email: "all@example.test", roles: roleIn(w.tenantA.id) }, ctxOf(who.tenantAdmin.id));
    const tenantAdminB = await makeUser("tadmin-b");
    await grantTenant(tenantAdminB.id, "ADMIN", w.tenantB.id);
    const b = await inviteUser({ email: "all@example.test", roles: roleIn(w.tenantB.id) }, ctxOf(tenantAdminB.id));
    const c = await inviteUser({ email: "all@example.test", roles: roleIn(w.tenantA.id) }, ctxOf(who.globalAdmin.id));
    expect(a.success && b.success && c.success).toBe(true);
    if (!c.success) return;
    expect(c.data.replacedInvitations).toBe(2);
    expect((await pending("all@example.test")).map((r) => r.id)).toEqual([c.data.invitationId]);
  });

  it("a used or expired earlier invitation is not touched (it is not pending)", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const expired = await inviteUser({ email: "old@example.test", roles: roleIn(w.tenantA.id) }, ctxOf(who.tenantAdmin.id));
    if (!expired.success) throw new Error("setup");
    await db().invitation.update({ where: { id: expired.data.invitationId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const fresh = await inviteUser({ email: "old@example.test", roles: roleIn(w.tenantA.id) }, ctxOf(who.tenantAdmin.id));
    expect(fresh).toMatchObject({ success: true, data: { replacedInvitations: 0 } });
    expect(await db().invitation.count({ where: { emailLower: "old@example.test" } })).toBe(2);
  });
});

describe("inviteUser: the link and the audit trail", () => {
  it("returns the one-time link: only its SHA-256 is stored, it is shown as a path (and an address when the origin is configured), and it works", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const result = await inviteUser(
      { email: "link@example.test", roles: [{ role: "AUTHOR", domainId: w.domainA.id }, { role: "VIEWER", tenantId: w.tenantA.id }] },
      ctxOf(who.tenantAdmin.id)
    );
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.data.path).toBe(`/invite/${result.data.token}`);
    expect(result.data.expiresAt).toBeInstanceOf(Date);
    const stored = await db().invitation.findUniqueOrThrow({ where: { id: result.data.invitationId } });
    expect(stored.tokenHash).toBe(hashToken(result.data.token));
    expect(JSON.stringify(await db().invitation.findMany())).not.toContain(result.data.token);

    // The invited person accepts it and holds exactly the roles that were granted, granted by the inviter.
    const accepted = await acceptInvitation(result.data.token, { name: "Link Person", password: PASSWORD });
    expect(accepted.success).toBe(true);
    if (!accepted.success) return;
    const rows = await db().userRole.findMany({ where: { userId: accepted.data.userId }, orderBy: { scopeKey: "asc" } });
    expect(rows.map((r) => [r.role, r.scopeKey, r.grantedById])).toEqual([
      ["AUTHOR", `D:${w.domainA.id}`, who.tenantAdmin.id],
      ["VIEWER", `T:${w.tenantA.id}`, who.tenantAdmin.id],
    ]);
  }, 60_000);

  it("writes one INVITATION_CREATED entry by the inviter, in the tenant of the roles, with no address and no token in it", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const result = await inviteUser({ email: "private.person@example.test", roles: [{ role: "VIEWER", tenantId: w.tenantA.id }] }, ctxOf(who.tenantAdmin.id));
    expect(result.success).toBe(true);
    if (!result.success) return;
    const entries = await auditOf("INVITATION_CREATED");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ entityType: "Invitation", entityId: result.data.invitationId, userId: who.tenantAdmin.id, tenantId: w.tenantA.id });
    const text = JSON.stringify(await db().auditLog.findMany());
    expect(text).not.toContain("private.person");
    expect(text).not.toContain(result.data.token);
  });

  it("the invitation and its entry commit together: when the entry cannot be written, no invitation is left", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await db().$executeRawUnsafe(`CREATE OR REPLACE FUNCTION refuse_invitation_audit() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'audit refused'; END; $$ LANGUAGE plpgsql`);
    await db().$executeRawUnsafe(`CREATE TRIGGER refuse_invitation_audit_trigger BEFORE INSERT ON audit_log FOR EACH ROW WHEN (NEW.action = 'INVITATION_CREATED') EXECUTE FUNCTION refuse_invitation_audit()`);
    try {
      const result = await inviteUser({ email: "atomic@example.test", roles: [{ role: "VIEWER", tenantId: w.tenantA.id }] }, ctxOf(who.tenantAdmin.id));
      expect(result).toMatchObject({ success: false, error: { code: "INTERNAL_ERROR" } });
      expect(await db().invitation.count()).toBe(0);
    } finally {
      await db().$executeRawUnsafe("DROP TRIGGER refuse_invitation_audit_trigger ON audit_log");
    }
  });

  it("a transaction that loses the race once is run again: exactly one invitation and one entry result (the faked P2034 retry)", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const original = db().$transaction.bind(db());
    let rounds = 0;
    const spy = vi.spyOn(db(), "$transaction").mockImplementation(((work: never, options: never) => {
      if (++rounds === 1) return Promise.reject(Object.assign(new Error("write conflict"), { code: "P2034" }));
      return original(work, options);
    }) as never);
    try {
      const result = await inviteUser({ email: "retry@example.test", roles: [{ role: "VIEWER", tenantId: w.tenantA.id }] }, ctxOf(who.tenantAdmin.id));
      expect(result.success).toBe(true);
      expect(rounds).toBe(2);
    } finally {
      spy.mockRestore();
    }
    expect(await db().invitation.count()).toBe(1);
    expect(await auditOf("INVITATION_CREATED")).toHaveLength(1);
  });

  it("two invitations for one address at the same moment leave ONE pending invitation", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const roles = [{ role: "VIEWER" as Role, tenantId: w.tenantA.id }];
    const results = await Promise.all([
      inviteUser({ email: "race@example.test", roles }, ctxOf(who.tenantAdmin.id)),
      inviteUser({ email: "race@example.test", roles }, ctxOf(who.globalAdmin.id)),
    ]);
    expect(results.some((r) => r.success)).toBe(true);
    for (const result of results) if (!result.success) expect(result.error.code).toBe("CONFLICT");
    expect(await db().invitation.count({ where: { emailLower: "race@example.test", usedAt: null } })).toBe(1);
  });
});

describe("revokeInvitation", () => {
  const invite = async (as: ServiceContext, email: string, roles: Array<{ role: Role; tenantId?: string; domainId?: string }>) => {
    const result = await inviteUser({ email, roles }, as);
    if (!result.success) throw new Error(`setup: ${result.error.message}`);
    return result.data;
  };

  it("an administrator of the tenant revokes a pending invitation: it is gone, its link answers like any dead link, the revocation is audited", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const made = await invite(ctxOf(who.tenantAdmin.id), "revoke@example.test", [{ role: "VIEWER", tenantId: w.tenantA.id }]);
    expect(await revokeInvitation(made.invitationId, ctxOf(who.tenantAdmin.id))).toEqual({ success: true, data: undefined });
    expect(await db().invitation.count()).toBe(0);
    expect(await db().invitationRole.count()).toBe(0);

    const dead = await acceptInvitation(made.token, { name: "N", password: PASSWORD });
    const unknown = await acceptInvitation("A".repeat(43), { name: "N", password: PASSWORD });
    expect(dead).toEqual({ success: false, error: { code: "INVALID_LINK", message: INVALID_LINK_MESSAGE } });
    expect(dead).toEqual(unknown);
    expect(await findValidInvitation(made.token)).toBeNull();

    const [entry] = await auditOf("INVITATION_REVOKED");
    expect(entry).toMatchObject({ entityId: made.invitationId, userId: who.tenantAdmin.id, tenantId: w.tenantA.id, afterState: { reason: "revoked" } });
    expect(JSON.stringify(entry)).not.toContain("revoke@example.test");
  });

  it("every rung below tenant administrator is refused with the generic answer; a platform administrator may revoke any", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const made = await invite(ctxOf(who.globalAdmin.id), "rungs@example.test", [{ role: "VIEWER", tenantId: w.tenantA.id }]);
    for (const name of ["roleless", "viewer", "author", "steward", "compliance"] as const) {
      expect(await revokeInvitation(made.invitationId, ctxOf(who[name].id)), name).toEqual(GENERIC_FORBIDDEN);
    }
    expect(await db().invitation.count()).toBe(1);
    expect((await revokeInvitation(made.invitationId, ctxOf(who.globalAdmin.id))).success).toBe(true);
  });

  it("an invitation of another tenant, a missing one, a used one and an expired one are the SAME not-found, and the foreign one is untouched", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const tenantAdminB = await makeUser("tadmin-b");
    await grantTenant(tenantAdminB.id, "ADMIN", w.tenantB.id);
    const foreign = await invite(ctxOf(tenantAdminB.id), "foreign@example.test", [{ role: "VIEWER", tenantId: w.tenantB.id }]);
    const used = await invite(ctxOf(who.tenantAdmin.id), "used@example.test", [{ role: "VIEWER", tenantId: w.tenantA.id }]);
    expect((await acceptInvitation(used.token, { name: "U", password: PASSWORD })).success).toBe(true);
    const expired = await invite(ctxOf(who.tenantAdmin.id), "expired@example.test", [{ role: "VIEWER", tenantId: w.tenantA.id }]);
    await db().invitation.update({ where: { id: expired.invitationId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const platform = await invite(ctxOf(who.globalAdmin.id), "platform@example.test", [{ role: "ADMIN" }]);

    const as = ctxOf(who.tenantAdmin.id);
    const answers = [
      await revokeInvitation(foreign.invitationId, as),
      await revokeInvitation("no-such-invitation", as),
      await revokeInvitation(used.invitationId, as),
      await revokeInvitation(expired.invitationId, as),
      await revokeInvitation(platform.invitationId, as), // a platform invitation is out of a tenant administrator's reach
      await revokeInvitation("", as),
      await revokeInvitation(undefined as never, as),
    ];
    for (const answer of answers) expect(answer).toEqual({ success: false, error: { code: "NOT_FOUND", message: "Invitation not found", suggestedFix: "Verify the invitation and try again." } });
    expect(await findValidInvitation(foreign.token)).not.toBeNull();
    expect(await findValidInvitation(platform.token)).not.toBeNull();
  }, 60_000);

  it("an invitation that spans a tenant the actor does not administer is out of their reach", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const spread = await invite(ctxOf(who.globalAdmin.id), "spread@example.test", [{ role: "VIEWER", tenantId: w.tenantA.id }, { role: "VIEWER", tenantId: w.tenantB.id }]);
    expect(await revokeInvitation(spread.invitationId, ctxOf(who.tenantAdmin.id))).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
    expect((await revokeInvitation(spread.invitationId, ctxOf(who.globalAdmin.id))).success).toBe(true);
  });

  it("two revocations at the same moment: one succeeds, the other is the not-found, one entry", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const made = await invite(ctxOf(who.tenantAdmin.id), "both@example.test", [{ role: "VIEWER", tenantId: w.tenantA.id }]);
    const results = await Promise.all([revokeInvitation(made.invitationId, ctxOf(who.tenantAdmin.id)), revokeInvitation(made.invitationId, ctxOf(who.globalAdmin.id))]);
    expect(results.filter((r) => r.success)).toHaveLength(1);
    expect((await auditOf("INVITATION_REVOKED")).length).toBe(1);
  });
});

describe("listPendingInvitations", () => {
  it("a tenant administrator sees the pending invitations of their tenant by name; a platform administrator sees all; used and expired ones are not listed", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const tenantAdminB = await makeUser("tadmin-b");
    await grantTenant(tenantAdminB.id, "ADMIN", w.tenantB.id);
    const a = await inviteUser({ email: "a@example.test", roles: [{ role: "AUTHOR", domainId: w.domainA.id }, { role: "VIEWER", productId: w.productA.id }] }, ctxOf(who.tenantAdmin.id));
    const b = await inviteUser({ email: "b@example.test", roles: [{ role: "VIEWER", tenantId: w.tenantB.id }] }, ctxOf(tenantAdminB.id));
    const root = await inviteUser({ email: "root@example.test", roles: [{ role: "ADMIN" }] }, ctxOf(who.globalAdmin.id));
    const used = await inviteUser({ email: "used@example.test", roles: [{ role: "VIEWER", tenantId: w.tenantA.id }] }, ctxOf(who.tenantAdmin.id));
    const expired = await inviteUser({ email: "expired@example.test", roles: [{ role: "VIEWER", tenantId: w.tenantA.id }] }, ctxOf(who.tenantAdmin.id));
    if (!a.success || !b.success || !root.success || !used.success || !expired.success) throw new Error("setup");
    await acceptInvitation(used.data.token, { name: "U", password: PASSWORD });
    await db().invitation.update({ where: { id: expired.data.invitationId }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const mine = await listPendingInvitations(ctxOf(who.tenantAdmin.id));
    expect(mine.success && mine.data.map((i) => i.email)).toEqual(["a@example.test"]);
    if (mine.success) {
      const entry = mine.data[0];
      expect(entry).toMatchObject({ id: a.data.invitationId, invitedById: who.tenantAdmin.id, expiresAt: a.data.expiresAt });
      expect(entry.roles.map((r) => [r.role, r.scope.label, r.id]).sort()).toEqual([["AUTHOR", `${w.tenantA.name} / Payments`, null], ["VIEWER", `${w.tenantA.name} / Payments / Checkout`, null]].sort());
    }
    const all = await listPendingInvitations(ctxOf(who.globalAdmin.id));
    expect(all.success && all.data.map((i) => i.email).sort()).toEqual(["a@example.test", "b@example.test", "root@example.test"]);
    if (all.success) expect(all.data.find((i) => i.email === "root@example.test")?.roles[0].scope.label).toBe("Platform");
  }, 60_000);

  it("every rung below tenant administrator is refused with the generic answer; nothing is listed for them", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    await inviteUser({ email: "a@example.test", roles: [{ role: "VIEWER", tenantId: w.tenantA.id }] }, ctxOf(who.tenantAdmin.id));
    for (const name of ["roleless", "viewer", "author", "steward", "compliance"] as const) expect(await listPendingInvitations(ctxOf(who[name].id)), name).toEqual(GENERIC_FORBIDDEN);
  });

  it("does not carry any token, hash or secret", async () => {
    const w = await makeWorld();
    const who = await callers(w);
    const made = await inviteUser({ email: "a@example.test", roles: [{ role: "VIEWER", tenantId: w.tenantA.id }] }, ctxOf(who.tenantAdmin.id));
    if (!made.success) throw new Error("setup");
    const text = JSON.stringify(await listPendingInvitations(ctxOf(who.globalAdmin.id)));
    expect(text).not.toContain(made.data.token);
    expect(text).not.toContain(hashToken(made.data.token));
  });
});
