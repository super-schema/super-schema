/**
 * Password sign-in without a client address (`AUTH_TRUST_PROXY` not "1"), on a real database (PGlite with every migration), through the real
 * `authenticateWithPassword`. Every such request shares one address, so a guesser spreading attempts over many e-mails must not be able to lock
 * the sign-in of an account that is not being guessed: the answer is a slower sign-in (src/lib/auth/login-backoff.ts), never a refusal.
 * The wait itself is replaced by a spy (its size is unit-tested in tests/unit/lib/auth/login-backoff.test.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "../../helpers/pglite-db";

const holder = vi.hoisted(() => ({ db: undefined as undefined | TestDb }));
const waits = vi.hoisted(() => ({ waitFor: vi.fn<(ms: number) => Promise<void>>(async () => undefined) }));
vi.mock("@/lib/db", async () => {
  holder.db = await (await import("../../helpers/pglite-db")).createPgliteDb();
  return { prisma: holder.db.prisma };
});
vi.mock("@/lib/auth/login-backoff", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/login-backoff")>()),
  waitFor: waits.waitFor,
}));
vi.mock("@/lib/auth/password-hash", () => ({
  verifyPassword: async (password: string, stored: string | null | undefined) => (stored ? stored === `hash:${password}` : false),
}));

import { authenticateWithPassword } from "@/lib/auth/credentials";
import { UNTRUSTED_IP } from "@/lib/auth/throttle";

const db = () => holder.db!.prisma;
const VICTIM = "victim@example.test";
const RIGHT = "the victim's password";

let savedSecret: string | undefined;
beforeAll(async () => {
  savedSecret = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = "login-unaddressed-integration-secret-0123456789";
  expect(holder.db).toBeDefined();
}, 180_000);
afterAll(async () => {
  if (savedSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = savedSecret;
  await holder.db?.close();
});
beforeEach(async () => {
  waits.waitFor.mockClear();
  await db().authEvent.deleteMany();
  await db().user.deleteMany();
  await db().user.create({ data: { email: VICTIM, name: "Vic", password: `hash:${RIGHT}` } });
});

describe("sign-ins without a client address", () => {
  it("a spread-out guessing run locks no account: the victim still signs in with the right password", async () => {
    // 150 wrong passwords, each for an e-mail of its own, all from the one unaddressed client
    for (let i = 0; i < 150; i += 1) {
      expect(await authenticateWithPassword({ email: `nobody${i}@example.test`, password: "wrong", ip: UNTRUSTED_IP })).toBeNull();
    }
    expect(await authenticateWithPassword({ email: VICTIM, password: RIGHT, ip: UNTRUSTED_IP })).toMatchObject({ email: VICTIM });
  }, 120_000);

  it("waits before it answers, once failures pile up, and a sign-in from a client address does not wait", async () => {
    for (let i = 0; i < 30; i += 1) await authenticateWithPassword({ email: `again${i}@example.test`, password: "wrong", ip: UNTRUSTED_IP });
    waits.waitFor.mockClear();
    await authenticateWithPassword({ email: VICTIM, password: RIGHT, ip: UNTRUSTED_IP });
    expect(waits.waitFor).toHaveBeenCalledTimes(1);
    expect(waits.waitFor.mock.calls[0][0]).toBeGreaterThan(0);

    waits.waitFor.mockClear();
    await authenticateWithPassword({ email: VICTIM, password: RIGHT, ip: "203.0.113.50" });
    expect(waits.waitFor).not.toHaveBeenCalled();
  }, 120_000);
});
