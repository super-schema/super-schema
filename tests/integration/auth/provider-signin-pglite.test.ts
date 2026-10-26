/**
 * The sign-in callback for an identity provider against a real database (PGlite with every migration; the real policy, the real registry, the real
 * throttle and the real principal loader; only Next's request headers are replaced): a refusal creates nothing and writes one hashed `auth_events` row,
 * a success writes `lastLoginAt`, the refusals of one client address lock it, and a user disabled AFTER signing in is nobody for the next request
 * (the principal loader), so a live provider session cannot outlast the disabling.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "../../helpers/pglite-db";

const holder = vi.hoisted(() => ({ db: undefined as undefined | TestDb, forwardedFor: "203.0.113.10" }));
vi.mock("@/lib/db", async () => {
  holder.db = await (await import("../../helpers/pglite-db")).createPgliteDb();
  return { prisma: holder.db.prisma };
});
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-forwarded-for": holder.forwardedFor }) }));
// Auth.js's entry points cannot be loaded outside Next; the principal loader reaches them only through `getPrincipal`, which this test does not call.
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));

import { authorizeProviderSignIn } from "@/lib/auth/provider-callback";
import { resetProviderProblemLog } from "@/lib/auth/providers";
import { hashEmail, hashIp } from "@/lib/auth/throttle";
import { loadPrincipalById } from "@/lib/access/principal";

const db = () => holder.db!.prisma;
const ACCOUNT = { provider: "keycloak", providerAccountId: "kc-ada" };
const PROFILE = { sub: "kc-ada", name: "Ada", email: "ada@example.com", email_verified: true };

afterAll(async () => {
  await holder.db?.close();
});

async function seed() {
  await db().authEvent.deleteMany();
  await db().account.deleteMany();
  await db().userRole.deleteMany();
  await db().user.deleteMany();
  const ada = await db().user.create({ data: { email: "ada@example.com", name: "Ada" } });
  await db().account.create({ data: { userId: ada.id, type: "oidc", provider: "keycloak", providerAccountId: "kc-ada" } });
  const grace = await db().user.create({ data: { email: "grace@example.com", name: "Grace" } }); // a local user who never used the provider
  return { ada, grace };
}

beforeEach(() => {
  resetProviderProblemLog();
  vi.unstubAllEnvs();
  vi.stubEnv("AUTH_SECRET", "provider-integration-secret-0123456789");
  vi.stubEnv("AUTH_TRUST_PROXY", "1");
  vi.stubEnv("AUTH_PROVIDERS", "keycloak");
  vi.stubEnv("AUTH_PROVIDER_KEYCLOAK_CLIENT_ID", "client");
  vi.stubEnv("AUTH_PROVIDER_KEYCLOAK_CLIENT_SECRET", "secret");
  vi.stubEnv("AUTH_PROVIDER_KEYCLOAK_ISSUER", "https://idp.example.test/realms/acme");
  holder.forwardedFor = "203.0.113.10";
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("a refusal", () => {
  it("creates no user (the count is the same), writes ONE auth_events row with the reason in its kind and only hashes, and says false", async () => {
    await seed();
    const before = await db().user.count();

    expect(await authorizeProviderSignIn({ account: { provider: "keycloak", providerAccountId: "kc-stranger" }, profile: { ...PROFILE, sub: "kc-stranger", email: "Stranger@Example.COM" } })).toBe(false);

    expect(await db().user.count()).toBe(before);
    expect(await db().account.count()).toBe(1);
    const rows = await db().authEvent.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "provider_refused:no-account", outcome: "refused", emailHash: hashEmail("stranger@example.com"), ipHash: hashIp("203.0.113.10") });
    expect(JSON.stringify(rows)).not.toMatch(/stranger|203\.0\.113/i);
  }, 120_000);

  it("an existing local user who never used the provider is not-linked (flag off), and gets nothing written (no lastLoginAt, no account row)", async () => {
    const { grace } = await seed();
    expect(await authorizeProviderSignIn({ account: { provider: "keycloak", providerAccountId: "kc-grace" }, profile: { ...PROFILE, sub: "kc-grace", email: "grace@example.com" } })).toBe(false);
    expect((await db().user.findUnique({ where: { id: grace.id } }))!.lastLoginAt).toBeNull();
    expect(await db().account.count({ where: { userId: grace.id } })).toBe(0);
    expect((await db().authEvent.findMany()).map((r) => r.kind)).toEqual(["provider_refused:not-linked"]);
  }, 120_000);

  it("with the provider's flag on, that same user is let through (Auth.js then links the account), still only with a verified e-mail", async () => {
    const { grace } = await seed();
    vi.stubEnv("AUTH_PROVIDER_KEYCLOAK_LINK_EXISTING_USERS", "1");
    const account = { provider: "keycloak", providerAccountId: "kc-grace" };
    expect(await authorizeProviderSignIn({ account, profile: { sub: "kc-grace", email: "grace@example.com", email_verified: false } })).toBe(false);
    expect(await authorizeProviderSignIn({ account, profile: { sub: "kc-grace", email: " Grace@Example.com", email_verified: true } })).toBe(true);
    expect((await db().user.findUnique({ where: { id: grace.id } }))!.lastLoginAt).toBeInstanceOf(Date);
  }, 120_000);

  it("a disabled user is refused, with a live provider account", async () => {
    const { ada } = await seed();
    await db().user.update({ where: { id: ada.id }, data: { disabledAt: new Date() } });
    expect(await authorizeProviderSignIn({ account: ACCOUNT, profile: PROFILE })).toBe(false);
    expect((await db().authEvent.findMany()).map((r) => r.kind)).toEqual(["provider_refused:disabled"]);
    expect((await db().user.findUnique({ where: { id: ada.id } }))!.lastLoginAt).toBeNull();
  }, 120_000);
});

describe("a success", () => {
  it("writes lastLoginAt and a provider_login event by hash", async () => {
    const { ada } = await seed();
    expect(await authorizeProviderSignIn({ account: ACCOUNT, profile: PROFILE })).toBe(true);
    expect((await db().user.findUnique({ where: { id: ada.id } }))!.lastLoginAt).toBeInstanceOf(Date);
    const rows = await db().authEvent.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "provider_login", outcome: "success", emailHash: hashEmail("ada@example.com") });
    expect(JSON.stringify(rows)).not.toMatch(/ada@example/i);
  }, 120_000);
});

describe("throttling by client address", () => {
  it("five refusals from one address lock it: the sixth attempt is refused even for a user who may sign in, and another address is not affected", async () => {
    await seed();
    const stranger = { account: { provider: "keycloak", providerAccountId: "kc-x" }, profile: { sub: "kc-x", email: "nobody@example.com", email_verified: true } };
    for (let i = 0; i < 5; i++) expect(await authorizeProviderSignIn(stranger)).toBe(false);

    expect(await authorizeProviderSignIn({ account: ACCOUNT, profile: PROFILE })).toBe(false);
    const kinds = (await db().authEvent.findMany({ orderBy: { createdAt: "asc" } })).map((r) => `${r.kind}/${r.outcome}`);
    expect(kinds).toEqual([...Array(5).fill("provider_refused:no-account/refused"), "provider_refused:throttled/locked"]);

    holder.forwardedFor = "203.0.113.99";
    expect(await authorizeProviderSignIn({ account: ACCOUNT, profile: PROFILE })).toBe(true);
  }, 120_000);

  it("the lock is the provider family's: the password login of the same address is not locked by it", async () => {
    await seed();
    const { isThrottled } = await import("@/lib/auth/throttle");
    const stranger = { account: { provider: "keycloak", providerAccountId: "kc-x" }, profile: { sub: "kc-x", email: "nobody@example.com", email_verified: true } };
    for (let i = 0; i < 5; i++) await authorizeProviderSignIn(stranger);
    expect((await isThrottled({ ip: "203.0.113.10", kind: "provider_refused" })).throttled).toBe(true);
    expect((await isThrottled({ ip: "203.0.113.10", kind: "login" })).throttled).toBe(false);
  }, 120_000);
});

describe("both layers: a user disabled after a provider sign-in", () => {
  it("is let in by the callback, and is nobody for the next request once disabled (the principal loader), and refused by the callback again", async () => {
    const { ada } = await seed();
    expect(await authorizeProviderSignIn({ account: ACCOUNT, profile: PROFILE })).toBe(true);
    expect((await loadPrincipalById(ada.id))?.userId).toBe(ada.id);

    await db().user.update({ where: { id: ada.id }, data: { disabledAt: new Date() } });

    // the session cookie that was issued is still a valid JWT, but the user it names is nobody: every guard asks the principal loader
    expect(await loadPrincipalById(ada.id)).toBeNull();
    expect(await authorizeProviderSignIn({ account: ACCOUNT, profile: PROFILE })).toBe(false);
  }, 120_000);
});
