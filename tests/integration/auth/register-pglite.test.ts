/**
 * `registerAction` against a real database (PGlite with every migration, real throttle and real tokens; only Next's request helpers are replaced):
 * registering makes an account with NO role of any kind (nobody becomes the administrator by registering first, an empty database included), an
 * address that already has an account (in any letter case) is answered exactly like a new one and makes no second account and no change, the limit
 * per client address holds, and `invite` and `closed` make nothing.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import type { TestDb } from "../../helpers/pglite-db";

const holder = vi.hoisted(() => ({ db: undefined as undefined | TestDb, forwardedFor: "203.0.113.10" }));
vi.mock("@/lib/db", async () => {
  holder.db = await (await import("../../helpers/pglite-db")).createPgliteDb();
  return { prisma: holder.db.prisma };
});
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-forwarded-for": holder.forwardedFor }) }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { redirectTo: to });
  },
}));
// Auth.js's entry points cannot be loaded outside Next; the register action reaches them only through the invitation action it forwards to.
vi.mock("@/lib/auth", () => ({ signIn: vi.fn() }));
vi.mock("next-auth", () => ({ AuthError: class AuthError extends Error {} }));

import { registerAction } from "@/app/(auth)/register/actions";
import { INVALID_LINK_MESSAGE, REGISTRATION_CLOSED_MESSAGE } from "@/lib/auth/messages";

const db = () => holder.db!.prisma;
const GOOD = "tangerine-lantern-orbit-42";

afterAll(async () => {
  await holder.db?.close();
});

beforeEach(async () => {
  vi.unstubAllEnvs();
  vi.stubEnv("AUTH_SECRET", "register-integration-secret-0123456789");
  vi.stubEnv("AUTH_TRUST_PROXY", "1");
  vi.stubEnv("AUTH_REGISTRATION", "open");
  holder.forwardedFor = "203.0.113.10";
  await db().authEvent.deleteMany();
  await db().userRole.deleteMany();
  await db().user.deleteMany();
});

function registration(email: string, password = GOOD) {
  const data = new FormData();
  data.set("email", email);
  data.set("password", password);
  data.set("confirmPassword", password);
  return data;
}

async function register(email: string, password = GOOD): Promise<unknown> {
  try {
    return { state: await registerAction(undefined, registration(email, password)) };
  } catch (error) {
    if (error instanceof Error && error.message === "NEXT_REDIRECT") return { redirectTo: (error as Error & { redirectTo: string }).redirectTo };
    throw error;
  }
}

describe("registering in open mode", () => {
  it("makes an account with no role of any kind, the first user of an empty database included (nobody becomes the administrator by registering first)", async () => {
    expect(await db().user.count()).toBe(0);
    expect(await register("First.Person@Example.COM")).toEqual({ redirectTo: "/login?notice=registered" });

    const [user] = await db().user.findMany();
    expect(user.email).toBe("first.person@example.com");
    expect(await bcrypt.compare(GOOD, user.password!)).toBe(true);
    expect(user.password).toMatch(/^\$2[aby]\$12\$/);
    expect(await db().userRole.count()).toBe(0);

    // The second and third registrants have none either, and nobody holds a global role.
    await register("second@example.com");
    await register("third@example.com");
    expect(await db().user.count()).toBe(3);
    expect(await db().userRole.count()).toBe(0);
    expect(await db().userRole.count({ where: { scopeKey: "G" } })).toBe(0);
  }, 60_000);

  it("writes no audit row (audit rows are immutable and point at their user: one would make the account impossible to delete), and the account can be deleted", async () => {
    await register("deletable@example.com");
    const user = await db().user.findUniqueOrThrow({ where: { email: "deletable@example.com" } });
    expect(await db().auditLog.count({ where: { userId: user.id } })).toBe(0);
    await db().user.delete({ where: { id: user.id } });
    expect(await db().user.count()).toBe(0);
  }, 60_000);

  it("answers an address that already has an account exactly like a new one: the same redirect, no second account, nobody's password changed", async () => {
    const original = await db().user.create({ data: { email: "taken@example.com", password: await bcrypt.hash("the original password", 4) } });
    const before = await db().user.findUniqueOrThrow({ where: { id: original.id } });

    const fresh = await register("brand.new@example.com");
    const sameCase = await register("taken@example.com", "another-passphrase-99");
    const otherCase = await register("  TAKEN@Example.com ", "yet-another-passphrase-7");

    expect(sameCase).toEqual(fresh);
    expect(otherCase).toEqual(fresh);
    expect(await db().user.count({ where: { email: { equals: "taken@example.com", mode: "insensitive" } } })).toBe(1);
    expect(await db().user.count()).toBe(2);
    const after = await db().user.findUniqueOrThrow({ where: { id: original.id } });
    expect(after.password).toBe(before.password);
    expect(await bcrypt.compare("the original password", after.password!)).toBe(true);
    // No role for the refused repeats.
    expect(await db().userRole.count()).toBe(0);
  }, 60_000);

  it("two registrations of one address at the same moment end with ONE account, and both are answered the same", async () => {
    const results = await Promise.all([register("race@example.com"), register("race@example.com"), register("Race@Example.com")]);
    for (const result of results) expect(result).toEqual({ redirectTo: "/login?notice=registered" });
    expect(await db().user.count({ where: { email: "race@example.com" } })).toBe(1);
  }, 120_000);

  it("limits registration per client address: the sixth attempt of one address is refused and creates nothing, another address is not affected", async () => {
    for (let i = 0; i < 5; i++) expect(await register(`user${i}@example.com`)).toEqual({ redirectTo: "/login?notice=registered" });
    expect(await register("sixth@example.com")).toEqual({ state: { error: "Too many attempts. Try again in a few minutes." } });
    expect(await db().user.count({ where: { email: "sixth@example.com" } })).toBe(0);

    holder.forwardedFor = "203.0.113.99";
    expect(await register("sixth@example.com")).toEqual({ redirectTo: "/login?notice=registered" });
  }, 120_000);

  it("keeps only hashes of the address and of the e-mail in the throttle rows", async () => {
    await register("hashed@example.com");
    const rows = await db().authEvent.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "register", outcome: "attempt", emailHash: null });
    expect(rows[0].ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toContain("203.0.113.10");
  }, 60_000);

  it("refuses what the visitor can fix without making anything or recording an attempt", async () => {
    const weak = (await register("weak@example.com", "password1234")) as { state: { fieldErrors: { password: string } } };
    expect(weak.state.fieldErrors.password).toMatch(/too easy to guess/);
    const bad = (await register("not an address")) as { state: { fieldErrors: { email: string } } };
    expect(bad.state.fieldErrors.email).toBeTruthy();
    expect(await db().user.count()).toBe(0);
    expect(await db().authEvent.count()).toBe(0);
  }, 60_000);
});

describe("the other modes make nothing", () => {
  it("closed: refused, nothing created, nothing recorded", async () => {
    vi.stubEnv("AUTH_REGISTRATION", "closed");
    expect(await register("nobody@example.com")).toEqual({ state: { error: REGISTRATION_CLOSED_MESSAGE } });
    expect(await db().user.count()).toBe(0);
    expect(await db().authEvent.count()).toBe(0);
  }, 60_000);

  it.each([["the default (nothing set)", ""], ["invite", "invite"], ["an unknown value", "everyone"]])("%s: no account without an invitation, and the answer is the dead-link message", async (_name, mode) => {
    vi.stubEnv("AUTH_REGISTRATION", mode);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await register("nobody@example.com")).toEqual({ state: { error: INVALID_LINK_MESSAGE } });
    expect(await db().user.count()).toBe(0);
  }, 60_000);
});
