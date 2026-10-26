/**
 * Invitation and password-reset tokens against a real database (PGlite with every migration): 32 random bytes, only their SHA-256 stored,
 * single use enforced by ONE atomic UPDATE (two concurrent uses cannot both succeed), a wrong, an expired and a used token all answer the same
 * words, an invitation grants its role rows to an account bound to the invited e-mail, and a reset invalidates the user's other reset tokens.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import type { TestDb } from "../../helpers/pglite-db";

const holder = vi.hoisted(() => ({ db: undefined as undefined | TestDb }));
vi.mock("@/lib/db", async () => {
  holder.db = await (await import("../../helpers/pglite-db")).createPgliteDb();
  return { prisma: holder.db.prisma };
});

import {
  INVALID_LINK_MESSAGE,
  INVITATION_TTL_HOURS,
  RESET_TTL_HOURS,
  acceptInvitation,
  consumeResetToken,
  createInvitation,
  createResetToken,
  findValidInvitation,
  findValidResetToken,
  generateToken,
  hashToken,
  isTokenShape,
} from "@/lib/auth/tokens";
import type { Assignment } from "@/lib/access";

const db = () => holder.db!.prisma;
const HOUR = 3_600_000;
const GOOD = "tangerine-lantern-orbit-42";
const OTHER = "marble-window-harvest-77";

afterAll(async () => {
  await holder.db?.close();
});

let n = 0;
const fresh = (prefix: string) => `${prefix}-${++n}`;

async function fixtures() {
  const tenant = await db().tenant.create({ data: { name: fresh("Tenant"), slug: fresh("tenant") } });
  const domain = await db().domain.create({ data: { tenantId: tenant.id, name: "Payments", slug: fresh("payments") } });
  const product = await db().product.create({ data: { domainId: domain.id, name: "Ledger", slug: fresh("ledger") } });
  const creator = await db().user.create({ data: { email: `${fresh("creator")}@example.test`, name: "Creator" } });
  // The creator is a platform administrator: acceptance judges what they may still grant (`grantAllowed`), and an ADMIN may grant everything.
  await db().userRole.create({ data: { userId: creator.id, role: "ADMIN", scopeKey: "G" } });
  const scopes = {
    global: { kind: "GLOBAL" } as const,
    tenant: { kind: "TENANT", tenantId: tenant.id } as const,
    domain: { kind: "DOMAIN", tenantId: tenant.id, domainId: domain.id } as const,
    product: { kind: "PRODUCT", tenantId: tenant.id, domainId: domain.id, productId: product.id } as const,
  };
  return { tenant, domain, product, creator, scopes };
}

beforeEach(async () => {
  // Every test brings its own rows; only the tables under test are emptied between tests.
  await db().authToken.deleteMany();
  await db().invitation.deleteMany();
});

const INVALID = { success: false, error: { code: "INVALID_LINK", message: INVALID_LINK_MESSAGE } } as const;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

describe("the token itself", () => {
  it("is 32 random bytes as base64url (43 characters), and what is stored is its SHA-256", () => {
    const { token, tokenHash } = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    expect(tokenHash).toBe(sha256(token));
    expect(tokenHash).toBe(hashToken(token));
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenHash).not.toContain(token);
  });

  it("is not guessable: 2,000 tokens are all different", () => {
    expect(new Set(Array.from({ length: 2000 }, () => generateToken().token)).size).toBe(2000);
  });

  it("is recognised by its shape before anything is looked up", () => {
    expect(isTokenShape(generateToken().token)).toBe(true);
    for (const bad of ["", "short", "a".repeat(42), "a".repeat(44), `${"a".repeat(42)}!`, `${"a".repeat(42)} `, undefined, null, 42, {}, ["a".repeat(43)]]) {
      expect(isTokenShape(bad), String(bad)).toBe(false);
    }
  });

  it("the lifetimes: an invitation 7 days, a reset 1 hour", () => {
    expect([INVITATION_TTL_HOURS, RESET_TTL_HOURS]).toEqual([168, 1]);
  });
});

describe("createInvitation", () => {
  it("stores the hash and never the token, with the e-mail normalized and the roles as scope keys", async () => {
    const f = await fixtures();
    const roles: Assignment[] = [
      { role: "AUTHOR", scope: f.scopes.domain },
      { role: "VIEWER", scope: f.scopes.tenant },
    ];
    const before = Date.now();
    const result = await createInvitation({ email: "  New.Person@Example.TEST ", roles, createdById: f.creator.id });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const row = await db().invitation.findUniqueOrThrow({ where: { id: result.data.invitationId }, include: { roles: true } });
    expect(row.tokenHash).toBe(sha256(result.data.token));
    expect(row.emailLower).toBe("new.person@example.test");
    expect(row.createdById).toBe(f.creator.id);
    expect(row.usedAt).toBeNull();
    expect(row.roles.map((r) => `${r.role}@${r.scopeKey}`).sort()).toEqual([`AUTHOR@D:${f.domain.id}`, `VIEWER@T:${f.tenant.id}`].sort());
    // Seven days from now, give or take the test's own runtime.
    expect(row.expiresAt.getTime() - before).toBeGreaterThan(7 * 24 * HOUR - 60_000);
    expect(row.expiresAt.getTime() - before).toBeLessThan(7 * 24 * HOUR + 60_000);
    expect(result.data.expiresAt.getTime()).toBe(row.expiresAt.getTime());
    // The plaintext is nowhere in the database.
    const everything = JSON.stringify([await db().invitation.findMany(), await db().invitationRole.findMany(), await db().auditLog.findMany()]);
    expect(everything).not.toContain(result.data.token);
  }, 60_000);

  it("honours ttlHours and refuses one that is not a sensible number of hours", async () => {
    const f = await fixtures();
    const ok = await createInvitation({ email: "ttl@example.test", roles: [], createdById: f.creator.id, ttlHours: 2 });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(2 * HOUR);
    for (const ttlHours of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 24 * 31, 0.5 - 1]) {
      const bad = await createInvitation({ email: "ttl@example.test", roles: [], createdById: f.creator.id, ttlHours });
      expect(bad, String(ttlHours)).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
    }
  }, 60_000);

  it("refuses an invalid assignment (a global role other than ADMIN), a bad e-mail and an unknown creator, creating nothing", async () => {
    const f = await fixtures();
    const cases: Array<[string, Parameters<typeof createInvitation>[0]]> = [
      ["global VIEWER", { email: "a@example.test", roles: [{ role: "VIEWER", scope: f.scopes.global }], createdById: f.creator.id }],
      ["an unknown role", { email: "a@example.test", roles: [{ role: "SUPERUSER" as never, scope: f.scopes.tenant }], createdById: f.creator.id }],
      ["a scope with no tenant id", { email: "a@example.test", roles: [{ role: "VIEWER", scope: { kind: "TENANT" } as never }], createdById: f.creator.id }],
      ["no e-mail", { email: "", roles: [], createdById: f.creator.id }],
      ["not an e-mail", { email: "not an address", roles: [], createdById: f.creator.id }],
      ["an unknown creator", { email: "a@example.test", roles: [], createdById: "nobody" }],
    ];
    for (const [name, input] of cases) {
      expect(await createInvitation(input), name).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
    }
    expect(await db().invitation.count()).toBe(0);
    expect(await db().invitationRole.count()).toBe(0);
  }, 60_000);

  it("collapses a repeated (role, scope) and writes an audit entry by the creator, with the tenant when every role is in one, and no e-mail or token", async () => {
    const f = await fixtures();
    const result = await createInvitation({
      email: "audit@example.test",
      roles: [
        { role: "VIEWER", scope: f.scopes.tenant },
        { role: "VIEWER", scope: f.scopes.tenant },
        { role: "AUTHOR", scope: f.scopes.product },
      ],
      createdById: f.creator.id,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(await db().invitationRole.count({ where: { invitationId: result.data.invitationId } })).toBe(2);

    const [entry] = await db().auditLog.findMany({ where: { action: "INVITATION_CREATED", entityId: result.data.invitationId } });
    expect(entry).toMatchObject({ entityType: "Invitation", entityId: result.data.invitationId, userId: f.creator.id, tenantId: f.tenant.id });
    const text = JSON.stringify(entry);
    expect(text).not.toContain("audit@example.test");
    expect(text).not.toContain(result.data.token);
    expect(text).toContain(`T:${f.tenant.id}`);
  }, 60_000);

  it("the audit entry has no tenant when the roles span tenants or are global", async () => {
    const f = await fixtures();
    const other = await db().tenant.create({ data: { name: fresh("Tenant"), slug: fresh("tenant") } });
    const result = await createInvitation({
      email: "spread@example.test",
      roles: [
        { role: "VIEWER", scope: f.scopes.tenant },
        { role: "VIEWER", scope: { kind: "TENANT", tenantId: other.id } },
      ],
      createdById: f.creator.id,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const [entry] = await db().auditLog.findMany({ where: { action: "INVITATION_CREATED", entityId: result.data.invitationId } });
    expect(entry.tenantId).toBeNull();
  }, 60_000);
});

describe("acceptInvitation", () => {
  async function invite(email: string, roles: (f: Awaited<ReturnType<typeof fixtures>>) => Assignment[], ttlHours?: number) {
    const f = await fixtures();
    const created = await createInvitation({ email, roles: roles(f), createdById: f.creator.id, ttlHours });
    if (!created.success) throw new Error(`invitation not created: ${created.error.message}`);
    return { f, ...created.data };
  }

  it("creates the account bound to the invited e-mail, grants every role row with the creator as granter, marks the token used, and writes an audit entry", async () => {
    const { f, token, invitationId } = await invite("Invited@Example.TEST", (f) => [
      { role: "ADMIN", scope: f.scopes.tenant },
      { role: "AUTHOR", scope: f.scopes.domain },
      { role: "VIEWER", scope: f.scopes.product },
    ]);

    const result = await acceptInvitation(token, { name: "  Ivy Invited ", password: GOOD });
    expect(result).toMatchObject({ success: true, data: { email: "invited@example.test" } });
    if (!result.success) return;

    const user = await db().user.findUniqueOrThrow({ where: { id: result.data.userId } });
    expect(user).toMatchObject({ email: "invited@example.test", name: "Ivy Invited", disabledAt: null });
    expect(await bcrypt.compare(GOOD, user.password!)).toBe(true);
    expect(user.password).toMatch(/^\$2[aby]\$12\$/);

    const roles = await db().userRole.findMany({ where: { userId: user.id }, orderBy: { scopeKey: "asc" } });
    const byKey = Object.fromEntries(roles.map((r) => [r.scopeKey.charAt(0), r]));
    expect(roles).toHaveLength(3);
    // The columns agree with the key (the table's CHECK), completed from the database for a domain and a product.
    expect(byKey.T).toMatchObject({ role: "ADMIN", scopeKey: `T:${f.tenant.id}`, tenantId: f.tenant.id, domainId: null, productId: null });
    expect(byKey.D).toMatchObject({ role: "AUTHOR", scopeKey: `D:${f.domain.id}`, tenantId: f.tenant.id, domainId: f.domain.id, productId: null });
    expect(byKey.P).toMatchObject({ role: "VIEWER", scopeKey: `P:${f.product.id}`, tenantId: f.tenant.id, domainId: f.domain.id, productId: f.product.id });
    for (const row of roles) expect(row.grantedById).toBe(f.creator.id);

    const invitation = await db().invitation.findUniqueOrThrow({ where: { id: invitationId } });
    expect(invitation.usedAt).not.toBeNull();

    const [entry] = await db().auditLog.findMany({ where: { action: "INVITATION_ACCEPTED", entityId: user.id } });
    expect(entry).toMatchObject({ entityType: "User", entityId: user.id, userId: user.id, tenantId: f.tenant.id });
    expect(JSON.stringify(entry)).not.toContain(token);
  }, 60_000);

  it("grants a global ADMIN invitation as a global row with no ids, and nothing else is granted a global scope", async () => {
    const { token } = await invite("root@example.test", (f) => [{ role: "ADMIN", scope: f.scopes.global }]);
    const result = await acceptInvitation(token, { name: "Root", password: GOOD });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const [row] = await db().userRole.findMany({ where: { userId: result.data.userId } });
    expect(row).toMatchObject({ role: "ADMIN", scopeKey: "G", tenantId: null, domainId: null, productId: null });
  }, 60_000);

  it("an invitation with no roles makes a roleless account", async () => {
    const { token } = await invite("plain@example.test", () => []);
    const result = await acceptInvitation(token, { name: "", password: GOOD });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(await db().userRole.count({ where: { userId: result.data.userId } })).toBe(0);
    expect((await db().user.findUniqueOrThrow({ where: { id: result.data.userId } })).name).toBeNull();
  }, 60_000);

  it("a wrong token, a malformed one, an expired one and a used one all answer with the SAME error, word for word", async () => {
    const { token, invitationId } = await invite("same@example.test", (f) => [{ role: "VIEWER", scope: f.scopes.tenant }]);
    const expired = await invite("expired@example.test", () => []);
    await db().invitation.update({ where: { id: expired.invitationId }, data: { expiresAt: new Date(Date.now() - 1000) } });

    const first = await acceptInvitation(token, { name: "N", password: GOOD });
    expect(first.success).toBe(true);
    const answers = [
      await acceptInvitation(generateToken().token, { name: "N", password: GOOD }), // wrong (right shape, no such token)
      await acceptInvitation("not-a-token", { name: "N", password: GOOD }), // malformed
      await acceptInvitation(undefined as never, { name: "N", password: GOOD }), // not a string
      await acceptInvitation(expired.token, { name: "N", password: GOOD }), // expired
      await acceptInvitation(token, { name: "N", password: GOOD }), // used
      await acceptInvitation(token, { name: "N", password: "x" }), // used, with a weak password: the token's state is answered first
      await acceptInvitation(hashToken(token), { name: "N", password: GOOD }), // the stored hash is not the token
    ];
    for (const answer of answers) expect(answer).toEqual(INVALID);
    // The used one did not change anything.
    expect(await db().user.count({ where: { email: "same@example.test" } })).toBe(1);
    expect(await db().userRole.count({ where: { grantedById: (await db().invitation.findUniqueOrThrow({ where: { id: invitationId } })).createdById, scopeKey: { startsWith: "T:" } } })).toBe(1);
    expect(await db().user.count({ where: { email: "expired@example.test" } })).toBe(0);
  }, 60_000);

  it("refuses a weak password with the policy's words and leaves the token valid for another try", async () => {
    const { token, invitationId } = await invite("weak@example.test", () => []);
    for (const password of ["short", "password1234", "weak@example.test", "weak-anything-123456"]) {
      const result = await acceptInvitation(token, { name: "W", password });
      expect(result, password).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
    }
    expect((await db().invitation.findUniqueOrThrow({ where: { id: invitationId } })).usedAt).toBeNull();
    expect(await db().user.count({ where: { email: "weak@example.test" } })).toBe(0);
    expect((await acceptInvitation(token, { name: "W", password: GOOD })).success).toBe(true);
  }, 60_000);

  it("when the invited e-mail already has an account (any letter case) nothing is created, no role is granted, and the token is NOT spent", async () => {
    const { token, invitationId } = await invite("Taken@Example.test", (f) => [{ role: "ADMIN", scope: f.scopes.tenant }]);
    const existing = await db().user.create({ data: { email: "taken@example.test", password: await bcrypt.hash("their own password", 4) } });

    const result = await acceptInvitation(token, { name: "Intruder", password: GOOD });
    expect(result).toMatchObject({ success: false, error: { code: "ACCOUNT_EXISTS" } });
    expect(await db().user.count({ where: { email: "taken@example.test" } })).toBe(1);
    expect((await db().user.findUniqueOrThrow({ where: { id: existing.id } })).password).not.toBeNull();
    expect(await bcrypt.compare(GOOD, (await db().user.findUniqueOrThrow({ where: { id: existing.id } })).password!)).toBe(false);
    expect(await db().userRole.count({ where: { userId: existing.id } })).toBe(0);
    expect((await db().invitation.findUniqueOrThrow({ where: { id: invitationId } })).usedAt).toBeNull();
  }, 60_000);

  it("two concurrent uses of one token: exactly one account is made, the other answers the invalid-link error", async () => {
    const { token } = await invite("race@example.test", (f) => [{ role: "VIEWER", scope: f.scopes.tenant }]);

    const results = await Promise.all(Array.from({ length: 4 }, (_, i) => acceptInvitation(token, { name: `Racer ${i}`, password: GOOD })));

    expect(results.filter((r) => r.success)).toHaveLength(1);
    for (const loser of results.filter((r) => !r.success)) expect(loser).toEqual(INVALID);
    expect(await db().user.count({ where: { email: "race@example.test" } })).toBe(1);
    const user = await db().user.findUniqueOrThrow({ where: { email: "race@example.test" } });
    expect(await db().userRole.count({ where: { userId: user.id } })).toBe(1);
  }, 120_000);

  it("skips a role whose tenant, domain or product has been deleted since, and one that is not a valid assignment, and grants the rest", async () => {
    const { f, token, invitationId } = await invite("skip@example.test", (f) => [
      { role: "VIEWER", scope: f.scopes.tenant },
      { role: "AUTHOR", scope: f.scopes.domain },
      { role: "VIEWER", scope: f.scopes.product },
    ]);
    // A key the application never writes (a global VIEWER) and one for something that never existed, put in directly.
    await db().invitationRole.createMany({
      data: [
        { invitationId, role: "VIEWER", scopeKey: "G" },
        { invitationId, role: "VIEWER", scopeKey: "D:never-existed" },
        { invitationId, role: "NOT_A_ROLE", scopeKey: `T:${f.tenant.id}` },
      ],
    });
    await db().product.delete({ where: { id: f.product.id } });
    await db().domain.delete({ where: { id: f.domain.id } });

    const result = await acceptInvitation(token, { name: "S", password: GOOD });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const roles = await db().userRole.findMany({ where: { userId: result.data.userId } });
    expect(roles.map((r) => `${r.role}@${r.scopeKey}`)).toEqual([`VIEWER@T:${f.tenant.id}`]);
  }, 60_000);

  it("a reset token is not an invitation token, and an invitation token is not a reset token", async () => {
    const { token: inviteToken } = await invite("cross@example.test", () => []);
    const user = await db().user.create({ data: { email: "cross-user@example.test", password: await bcrypt.hash("old password!!", 4) } });
    const reset = await createResetToken(user.id);
    expect(reset.success).toBe(true);
    if (!reset.success) return;
    expect(await acceptInvitation(reset.data.token, { name: "X", password: GOOD })).toEqual(INVALID);
    expect(await consumeResetToken(inviteToken, GOOD)).toEqual(INVALID);
  }, 60_000);

  it("findValidInvitation answers the invited e-mail for a live token and null for every other", async () => {
    const live = await invite("peek@example.test", () => []);
    const used = await invite("peeked@example.test", () => []);
    const expired = await invite("peekold@example.test", () => []);
    await acceptInvitation(used.token, { name: "U", password: GOOD });
    await db().invitation.update({ where: { id: expired.invitationId }, data: { expiresAt: new Date(Date.now() - 1000) } });

    expect(await findValidInvitation(live.token)).toEqual({ email: "peek@example.test" });
    for (const token of [used.token, expired.token, generateToken().token, "garbage", undefined as never]) expect(await findValidInvitation(token)).toBeNull();
  }, 60_000);
});

describe("acceptInvitation judges the creator AGAIN (Task 4 ruling d): what they can no longer grant is skipped and listed, nothing else", () => {
  /** An invitation by a creator who holds `creatorRoles` NOW (the roles they held when they made it are whatever the test then changes). */
  async function invitedBy(
    creatorRoles: (f: Awaited<ReturnType<typeof fixtures>>) => Array<{ role: string; scopeKey: string; tenantId?: string; domainId?: string }>,
    roles: (f: Awaited<ReturnType<typeof fixtures>>) => Assignment[],
    email = `${fresh("invited")}@example.test`
  ) {
    const f = await fixtures();
    // The fixture's creator is a platform administrator; the test decides what they are at acceptance.
    await db().userRole.deleteMany({ where: { userId: f.creator.id } });
    const created = await createInvitation({ email, roles: roles(f), createdById: f.creator.id });
    if (!created.success) throw new Error(`invitation not created: ${created.error.message}`);
    for (const row of creatorRoles(f)) await db().userRole.create({ data: { userId: f.creator.id, ...row } });
    return { f, ...created.data };
  }
  const rolesOf = (userId: string) => db().userRole.findMany({ where: { userId }, orderBy: { scopeKey: "asc" } });
  const entryOf = (userId: string) => db().auditLog.findFirstOrThrow({ where: { action: "INVITATION_ACCEPTED", entityId: userId } });

  it("a creator who has since LOST their administrator role: the account is made, roleless, and every skipped role is in the audit entry", async () => {
    const { f, token } = await invitedBy(
      () => [],
      (f) => [
        { role: "AUTHOR", scope: f.scopes.domain },
        { role: "VIEWER", scope: f.scopes.tenant },
      ]
    );
    const result = await acceptInvitation(token, { name: "Late", password: GOOD });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(await rolesOf(result.data.userId)).toEqual([]);
    const entry = await entryOf(result.data.userId);
    expect(entry.afterState).toMatchObject({
      roles: [],
      skipped: expect.arrayContaining([
        { role: "AUTHOR", scopeKey: `D:${f.domain.id}`, reason: "creator-cannot-grant" },
        { role: "VIEWER", scopeKey: `T:${f.tenant.id}`, reason: "creator-cannot-grant" },
      ]),
    });
    expect(((entry.afterState as { skipped: unknown[] }).skipped)).toHaveLength(2);
  }, 60_000);

  it("a creator who was a platform administrator and is now the administrator of ONE tenant: that tenant's roles are given, a platform role and another tenant's are skipped", async () => {
    const { f, token } = await invitedBy(
      (f) => [{ role: "ADMIN", scopeKey: `T:${f.tenant.id}`, tenantId: f.tenant.id }],
      (f) => [
        { role: "AUTHOR", scope: f.scopes.domain },
        { role: "ADMIN", scope: f.scopes.global },
      ]
    );
    const result = await acceptInvitation(token, { name: "Partly", password: GOOD });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const rows = await rolesOf(result.data.userId);
    expect(rows.map((r) => [r.role, r.scopeKey, r.grantedById])).toEqual([["AUTHOR", `D:${f.domain.id}`, f.creator.id]]);
    expect((await entryOf(result.data.userId)).afterState).toMatchObject({
      roles: [{ role: "AUTHOR", scopeKey: `D:${f.domain.id}` }],
      skipped: [{ role: "ADMIN", scopeKey: "G", reason: "creator-cannot-grant" }],
    });
  }, 60_000);

  it("a creator who is still a platform administrator: everything is given, and no `skipped` key is written", async () => {
    const { f, token } = await invitedBy(
      () => [{ role: "ADMIN", scopeKey: "G" }],
      (f) => [
        { role: "ADMIN", scope: f.scopes.tenant },
        { role: "VIEWER", scope: f.scopes.product },
      ]
    );
    const result = await acceptInvitation(token, { name: "Whole", password: GOOD });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(await rolesOf(result.data.userId)).toHaveLength(2);
    expect((await entryOf(result.data.userId)).afterState).not.toHaveProperty("skipped");
    expect(f.creator.id).toBeTruthy();
  }, 60_000);

  it("a creator who is DISABLED grants nothing; enabled again before the link is used, they grant it all", async () => {
    const { f, token } = await invitedBy(
      () => [{ role: "ADMIN", scopeKey: "G" }],
      (f) => [{ role: "VIEWER", scope: f.scopes.tenant }]
    );
    await db().user.update({ where: { id: f.creator.id }, data: { disabledAt: new Date() } });
    const first = await acceptInvitation(token, { name: "A", password: GOOD });
    expect(first.success).toBe(true);
    if (!first.success) return;
    expect(await rolesOf(first.data.userId)).toEqual([]);

    const again = await invitedBy(
      () => [{ role: "ADMIN", scopeKey: "G" }],
      (f) => [{ role: "VIEWER", scope: f.scopes.tenant }]
    );
    await db().user.update({ where: { id: again.f.creator.id }, data: { disabledAt: new Date() } });
    await db().user.update({ where: { id: again.f.creator.id }, data: { disabledAt: null } });
    const second = await acceptInvitation(again.token, { name: "B", password: GOOD });
    expect(second.success && (await rolesOf(second.data.userId))).toHaveLength(1);
  }, 120_000);

  it("a domain administrator who made an invitation for their domain and for a sibling: only their domain is given", async () => {
    const { f, token } = await invitedBy(
      (f) => [{ role: "ADMIN", scopeKey: `D:${f.domain.id}`, tenantId: f.tenant.id, domainId: f.domain.id }],
      (f) => [{ role: "AUTHOR", scope: f.scopes.domain }]
    );
    const sibling = await db().domain.create({ data: { tenantId: f.tenant.id, name: "Sibling", slug: fresh("sibling") } });
    await db().invitationRole.create({ data: { invitationId: (await db().invitation.findFirstOrThrow({ where: { createdById: f.creator.id } })).id, role: "VIEWER", scopeKey: `D:${sibling.id}` } });
    const result = await acceptInvitation(token, { name: "Sib", password: GOOD });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect((await rolesOf(result.data.userId)).map((r) => r.scopeKey)).toEqual([`D:${f.domain.id}`]);
    expect((await entryOf(result.data.userId)).afterState).toMatchObject({ skipped: [{ role: "VIEWER", scopeKey: `D:${sibling.id}`, reason: "creator-cannot-grant" }] });
  }, 60_000);

  it("a role whose domain has since been deleted is skipped with its own reason (scope-gone), and the rest is still given", async () => {
    const { f, token } = await invitedBy(
      () => [{ role: "ADMIN", scopeKey: "G" }],
      (f) => [
        { role: "VIEWER", scope: f.scopes.tenant },
        { role: "AUTHOR", scope: f.scopes.domain },
      ]
    );
    await db().domain.delete({ where: { id: f.domain.id } });
    const result = await acceptInvitation(token, { name: "Gone", password: GOOD });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect((await rolesOf(result.data.userId)).map((r) => r.scopeKey)).toEqual([`T:${f.tenant.id}`]);
    expect((await entryOf(result.data.userId)).afterState).toMatchObject({ skipped: [{ role: "AUTHOR", scopeKey: `D:${f.domain.id}`, reason: "scope-gone" }] });
  }, 60_000);

  it("the audit entry of a skipped acceptance names no e-mail and no token", async () => {
    const email = "private.person@example.test";
    const { token } = await invitedBy(
      () => [],
      (f) => [{ role: "VIEWER", scope: f.scopes.tenant }],
      email
    );
    const result = await acceptInvitation(token, { name: "Private", password: GOOD });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const text = JSON.stringify(await entryOf(result.data.userId));
    expect(text).not.toContain(email);
    expect(text).not.toContain(token);
  }, 60_000);
});

describe("password reset", () => {
  async function userWithPassword(email = `${fresh("reset")}@example.test`) {
    return db().user.create({ data: { email, password: await bcrypt.hash("the old password", 4) } });
  }

  it("createResetToken stores the hash, lasts an hour, and is audited; an unknown user gets nothing", async () => {
    const user = await userWithPassword();
    const admin = await userWithPassword();
    const before = Date.now();
    const result = await createResetToken(user.id, { issuedById: admin.id });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const row = await db().authToken.findUniqueOrThrow({ where: { tokenHash: sha256(result.data.token) } });
    expect(row).toMatchObject({ userId: user.id, kind: "RESET", usedAt: null });
    expect(row.expiresAt.getTime() - before).toBeGreaterThan(HOUR - 60_000);
    expect(row.expiresAt.getTime() - before).toBeLessThan(HOUR + 60_000);
    expect(JSON.stringify(await db().authToken.findMany())).not.toContain(result.data.token);
    const [entry] = await db().auditLog.findMany({ where: { action: "PASSWORD_RESET_ISSUED", entityId: user.id } });
    expect(entry).toMatchObject({ entityType: "User", userId: admin.id });
    expect(JSON.stringify(entry)).not.toContain(result.data.token);

    expect(await createResetToken("nobody")).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
    expect(await createResetToken(undefined as never)).toMatchObject({ success: false, error: { code: "NOT_FOUND" } });
  }, 60_000);

  it("consuming a token sets the new password, spends the token, invalidates the user's OTHER outstanding reset tokens (not another user's), and audits", async () => {
    const user = await userWithPassword();
    const bystander = await userWithPassword();
    const tokens = await Promise.all([createResetToken(user.id), createResetToken(user.id), createResetToken(user.id), createResetToken(bystander.id)]);
    const [t1, t2, t3, theirs] = tokens.map((t) => (t.success ? t.data.token : ""));
    expect([t1, t2, t3, theirs].every(Boolean)).toBe(true);

    const result = await consumeResetToken(t1, GOOD);
    expect(result).toEqual({ success: true, data: { userId: user.id } });

    const updated = await db().user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await bcrypt.compare(GOOD, updated.password!)).toBe(true);
    expect(await bcrypt.compare("the old password", updated.password!)).toBe(false);
    expect(updated.password).toMatch(/^\$2[aby]\$12\$/);

    // The others of that user are dead, the used one too, the bystander's lives.
    expect(await consumeResetToken(t2, OTHER)).toEqual(INVALID);
    expect(await consumeResetToken(t3, OTHER)).toEqual(INVALID);
    expect(await consumeResetToken(t1, OTHER)).toEqual(INVALID);
    expect(await bcrypt.compare(GOOD, (await db().user.findUniqueOrThrow({ where: { id: user.id } })).password!)).toBe(true);
    expect(await db().authToken.count({ where: { userId: user.id, usedAt: null } })).toBe(0);
    expect(await db().authToken.count({ where: { userId: bystander.id, usedAt: null } })).toBe(1);
    expect((await consumeResetToken(theirs, OTHER)).success).toBe(true);

    const [entry] = await db().auditLog.findMany({ where: { action: "PASSWORD_RESET", entityId: user.id } });
    expect(entry).toMatchObject({ entityType: "User", userId: user.id });
  }, 60_000);

  it("a wrong, a malformed, an expired and a used token answer with the same error as an invitation's, word for word", async () => {
    const user = await userWithPassword();
    const live = await createResetToken(user.id);
    const old = await createResetToken(user.id);
    if (!live.success || !old.success) throw new Error("tokens not created");
    await db().authToken.update({ where: { tokenHash: sha256(old.data.token) }, data: { expiresAt: new Date(Date.now() - 1000) } });

    expect((await consumeResetToken(live.data.token, GOOD)).success).toBe(true);
    for (const attempt of [generateToken().token, "not-a-token", undefined as never, old.data.token, live.data.token]) {
      expect(await consumeResetToken(attempt, OTHER)).toEqual(INVALID);
    }
  }, 60_000);

  it("a weak password is refused with the policy's words and the token stays valid", async () => {
    const user = await userWithPassword("weak.reset@example.test");
    const made = await createResetToken(user.id);
    if (!made.success) throw new Error("no token");
    for (const password of ["short", "password1234", "weak.reset@example.test", "weak.reset-anything!"]) {
      expect(await consumeResetToken(made.data.token, password), password).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
    }
    expect(await findValidResetToken(made.data.token)).toEqual({ valid: true });
    expect((await consumeResetToken(made.data.token, GOOD)).success).toBe(true);
  }, 60_000);

  it("a disabled user's link is no link: the generic error, the password unchanged", async () => {
    const user = await userWithPassword();
    const made = await createResetToken(user.id);
    if (!made.success) throw new Error("no token");
    await db().user.update({ where: { id: user.id }, data: { disabledAt: new Date() } });
    expect(await findValidResetToken(made.data.token)).toBeNull();
    expect(await consumeResetToken(made.data.token, GOOD)).toEqual(INVALID);
    expect(await bcrypt.compare("the old password", (await db().user.findUniqueOrThrow({ where: { id: user.id } })).password!)).toBe(true);
  }, 60_000);

  it("two concurrent uses of one token with different passwords: exactly one wins and its password is the one that is set", async () => {
    const user = await userWithPassword();
    const made = await createResetToken(user.id);
    if (!made.success) throw new Error("no token");

    const results = await Promise.all([consumeResetToken(made.data.token, GOOD), consumeResetToken(made.data.token, OTHER), consumeResetToken(made.data.token, "a third passphrase!")]);

    const winners = results.filter((r) => r.success);
    expect(winners).toHaveLength(1);
    for (const loser of results.filter((r) => !r.success)) expect(loser).toEqual(INVALID);
    const stored = (await db().user.findUniqueOrThrow({ where: { id: user.id } })).password!;
    const winningIndex = results.findIndex((r) => r.success);
    const winningPassword = [GOOD, OTHER, "a third passphrase!"][winningIndex];
    expect(await bcrypt.compare(winningPassword, stored)).toBe(true);
    expect(await db().auditLog.count({ where: { action: "PASSWORD_RESET", entityId: user.id } })).toBe(1);
  }, 120_000);

  it("findValidResetToken says only whether the link is live (it names no user)", async () => {
    const user = await userWithPassword();
    const made = await createResetToken(user.id);
    if (!made.success) throw new Error("no token");
    expect(await findValidResetToken(made.data.token)).toEqual({ valid: true });
    await consumeResetToken(made.data.token, GOOD);
    expect(await findValidResetToken(made.data.token)).toBeNull();
    expect(await findValidResetToken("garbage")).toBeNull();
  }, 60_000);
});
