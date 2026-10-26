/**
 * Password sign-in under simultaneous attempts, on a real database (PGlite with every migration), through the real `authenticateWithPassword`:
 * however many requests arrive at the same moment for one e-mail, at most 5 passwords are TRIED (compared against the account's stored hash). The
 * bcrypt compare is replaced by a fake that takes a few milliseconds, as the real one does: that gap is the window the race lives in (a throttle
 * that is read before the compare and written after it lets every request through it).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "../../helpers/pglite-db";

const holder = vi.hoisted(() => ({ db: undefined as undefined | TestDb }));
const compared = vi.hoisted(() => ({ storedHash: 0, dummy: 0 }));
vi.mock("@/lib/db", async () => {
  holder.db = await (await import("../../helpers/pglite-db")).createPgliteDb();
  return { prisma: holder.db.prisma };
});
vi.mock("@/lib/auth/password-hash", () => ({
  verifyPassword: async (password: string, stored: string | null | undefined) => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    if (!stored) {
      compared.dummy++;
      return false;
    }
    compared.storedHash++;
    return stored === `hash:${password}`;
  },
}));

import { authenticateWithPassword } from "@/lib/auth/credentials";
import { THROTTLE_MAX_FAILURES, hashEmail } from "@/lib/auth/throttle";

const db = () => holder.db!.prisma;
const EMAIL = "bob@example.test";
const RIGHT = "the right password!";

let savedSecret: string | undefined;
beforeAll(async () => {
  savedSecret = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = "login-race-integration-secret-0123456789";
  expect(holder.db).toBeDefined();
}, 180_000);
afterAll(async () => {
  if (savedSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = savedSecret;
  await holder.db?.close();
});
beforeEach(async () => {
  compared.storedHash = 0;
  compared.dummy = 0;
  await db().authEvent.deleteMany();
  await db().user.deleteMany();
  await db().user.create({ data: { email: EMAIL, name: "Bob", password: `hash:${RIGHT}` } });
});

let attemptNumber = 0;
/** One attempt from its own address by default: a success resets the e-mail's count, never the address's. */
const guess = (password: string, ip = `203.0.113.${(++attemptNumber % 250) + 1}`) => authenticateWithPassword({ email: EMAIL, password, ip });
const outcomes = async () => (await db().authEvent.findMany({ where: { emailHash: hashEmail(EMAIL) } })).map((row) => row.outcome);

describe("simultaneous password attempts for one e-mail", () => {
  it("never try more than 5 passwords, however many arrive at the same moment, and every one is refused", async () => {
    const answers = await Promise.all(Array.from({ length: 25 }, (_, i) => guess(`wrong password ${i}`, `198.51.100.${i + 1}`)));
    expect(answers.every((answer) => answer === null)).toBe(true);
    expect(compared.storedHash).toBeLessThanOrEqual(THROTTLE_MAX_FAILURES);
    // everything that was not tried was compared against the dummy (the same work), and nothing is left undecided
    expect(compared.storedHash + compared.dummy).toBe(25);
    expect(await outcomes()).not.toContain("pending");
  }, 120_000);

  it("the right password in the middle of a flood is either signed in (one of the first 5) or refused, never tried as the sixth", async () => {
    const attempts = Array.from({ length: 12 }, (_, i) => (i === 8 ? guess(RIGHT, "198.51.100.99") : guess(`wrong ${i}`, `198.51.100.${i + 1}`)));
    await Promise.all(attempts);
    expect(compared.storedHash).toBeLessThanOrEqual(THROTTLE_MAX_FAILURES);
  }, 120_000);

  it("after five failures the right password is refused without being tried, and the account is not looked at", async () => {
    for (let i = 0; i < THROTTLE_MAX_FAILURES; i++) expect(await guess(`wrong ${i}`)).toBeNull();
    expect(compared.storedHash).toBe(THROTTLE_MAX_FAILURES);
    expect(await guess(RIGHT)).toBeNull();
    expect(compared.storedHash).toBe(THROTTLE_MAX_FAILURES);
    expect(await outcomes()).toEqual(expect.arrayContaining(["locked"]));
  }, 120_000);

  it("a sign-in settles its place as a success, which resets the count: four failures, the right password, then four more failures do not lock", async () => {
    for (let i = 0; i < 4; i++) await guess(`wrong ${i}`);
    expect(await guess(RIGHT)).toMatchObject({ email: EMAIL });
    for (let i = 0; i < 4; i++) await guess(`wrong again ${i}`);
    expect(await guess(RIGHT)).toMatchObject({ email: EMAIL });
    expect(await outcomes()).not.toContain("pending");
  }, 120_000);
});
