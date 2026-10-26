/**
 * Throttling and lockout against a real database (PGlite with every migration): 5 failures in 15 minutes per e-mail hash and, independently,
 * per client-address hash; a success resets the e-mail's count (not the address's); the answer for a locked e-mail is the one for an unknown
 * e-mail (the state is by hash, so it cannot tell); registration counts every attempt per address; rows hold hashes only; and rows older than
 * 24 hours are pruned in the transaction of an insert, a bounded batch at a time.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "../../helpers/pglite-db";

const holder = vi.hoisted(() => ({ db: undefined as undefined | TestDb }));
vi.mock("@/lib/db", async () => {
  holder.db = await (await import("../../helpers/pglite-db")).createPgliteDb();
  return { prisma: holder.db.prisma };
});

import {
  PRUNE_AFTER_MS,
  PRUNE_BATCH,
  THROTTLE_MAX_FAILURES,
  THROTTLE_WINDOW_MS,
  UNTRUSTED_IP,
  UNTRUSTED_IP_MAX_FAILURES,
  hashEmail,
  hashIp,
  isThrottled,
  recordAuthEvent,
} from "@/lib/auth/throttle";

const db = () => holder.db!.prisma;
const MINUTE = 60_000;
const NOW = new Date("2026-10-25T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

let savedSecret: string | undefined;
beforeAll(async () => {
  // `vi.mock` runs its factory at the first import above; the database is ready by now.
  savedSecret = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = "throttle-integration-secret-0123456789";
  expect(holder.db).toBeDefined();
}, 180_000);
afterAll(async () => {
  if (savedSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = savedSecret;
  await holder.db?.close();
});
beforeEach(async () => {
  await db().authEvent.deleteMany();
});

const fail = (email: string, ip: string, at: Date = NOW) => recordAuthEvent("login", { email, ip, outcome: "failure" }, at);
const failTimes = async (n: number, email: string, ip: string, at: Date = NOW) => {
  for (let i = 0; i < n; i++) await fail(email, ip, at);
};
const throttled = (email: string | undefined, ip: string | undefined, kind?: "login" | "register" | "invite_accept" | "reset_consume") =>
  isThrottled({ email, ip, kind }, NOW);

describe("the limit: 5 failures in 15 minutes", () => {
  it("constants", () => {
    expect([THROTTLE_MAX_FAILURES, THROTTLE_WINDOW_MS]).toEqual([5, 15 * MINUTE]);
  });

  it("four failures of one e-mail do not lock it, the fifth does", async () => {
    await failTimes(4, "a@example.test", "203.0.113.1");
    expect(await throttled("a@example.test", "203.0.113.99")).toEqual({ throttled: false });
    await fail("a@example.test", "203.0.113.2");
    const locked = await throttled("a@example.test", "203.0.113.99");
    expect(locked.throttled).toBe(true);
  }, 60_000);

  it("a lock reports when it lifts: a whole number of seconds, no more than the window", async () => {
    await failTimes(5, "a@example.test", "203.0.113.1", ago(10 * MINUTE));
    const locked = await throttled("a@example.test", "203.0.113.50");
    expect(locked.throttled).toBe(true);
    // Five minutes of the window are left: the oldest failures are 10 minutes old.
    expect(locked.retryAfterSeconds).toBeGreaterThan(4.9 * 60);
    expect(locked.retryAfterSeconds).toBeLessThanOrEqual(5 * 60);
    expect(Number.isInteger(locked.retryAfterSeconds)).toBe(true);
    expect((await throttled("b@example.test", "203.0.113.50")).retryAfterSeconds).toBeUndefined();
  }, 60_000);

  it("failures older than the window no longer count", async () => {
    await failTimes(5, "a@example.test", "203.0.113.1", ago(16 * MINUTE));
    expect(await throttled("a@example.test", "203.0.113.1")).toEqual({ throttled: false });
    // ... and a lock lifts as its failures age out: five at 14 minutes lock, five at 15m01s do not.
    await failTimes(5, "b@example.test", "203.0.113.2", ago(14 * MINUTE));
    expect((await throttled("b@example.test", undefined)).throttled).toBe(true);
    await failTimes(5, "c@example.test", "203.0.113.3", ago(THROTTLE_WINDOW_MS + 1000));
    expect((await throttled("c@example.test", undefined)).throttled).toBe(false);
  }, 60_000);

  it("an e-mail that has no account locks the same way as one that has (the state is by hash)", async () => {
    await db().user.create({ data: { email: "real@example.test" } });
    await failTimes(5, "real@example.test", "203.0.113.1");
    await failTimes(5, "ghost@example.test", "203.0.113.2");
    const real = await throttled("real@example.test", undefined);
    const ghost = await throttled("ghost@example.test", undefined);
    expect({ throttled: real.throttled }).toEqual({ throttled: ghost.throttled });
    expect(real.throttled).toBe(true);
  }, 60_000);

  it("treats the e-mail's letter case and padding as one e-mail", async () => {
    await failTimes(3, "  Alice@Example.TEST ", "203.0.113.1");
    await failTimes(2, "alice@example.test", "203.0.113.2");
    expect((await throttled("ALICE@example.test", undefined)).throttled).toBe(true);
  }, 60_000);

  it("attempts made WHILE locked are recorded as 'locked' and do not extend the lock", async () => {
    await failTimes(5, "a@example.test", "203.0.113.1", ago(14 * MINUTE));
    for (let i = 0; i < 10; i++) await recordAuthEvent("login", { email: "a@example.test", ip: "203.0.113.1", outcome: "locked" }, NOW);
    expect((await throttled("a@example.test", undefined)).retryAfterSeconds).toBeLessThanOrEqual(60);
    expect(await db().authEvent.count({ where: { outcome: "locked" } })).toBe(10);
  }, 60_000);
});

describe("a success resets the e-mail's counter, not the address's", () => {
  it("four failures, a success, four more failures: not locked", async () => {
    await failTimes(4, "a@example.test", "203.0.113.1", ago(5 * MINUTE));
    await recordAuthEvent("login", { email: "a@example.test", ip: "203.0.113.1", outcome: "success" }, ago(4 * MINUTE));
    await failTimes(4, "a@example.test", "203.0.113.1", ago(3 * MINUTE));
    expect((await throttled("a@example.test", undefined)).throttled).toBe(false);
    await fail("a@example.test", "203.0.113.1", ago(2 * MINUTE));
    expect((await throttled("a@example.test", undefined)).throttled).toBe(true);
  }, 60_000);

  it("the address keeps its count through a success (five failures from one address lock it even though one e-mail signed in)", async () => {
    const ip = "198.51.100.9";
    for (const email of ["a", "b", "c", "d"]) await fail(`${email}@example.test`, ip, ago(5 * MINUTE));
    await recordAuthEvent("login", { email: "a@example.test", ip, outcome: "success" }, ago(4 * MINUTE));
    expect((await throttled(undefined, ip)).throttled).toBe(false);
    await fail("e@example.test", ip, ago(3 * MINUTE));
    expect((await throttled(undefined, ip)).throttled).toBe(true);
    // The e-mail that signed in is not locked by it.
    expect((await throttled("a@example.test", undefined)).throttled).toBe(false);
  }, 60_000);

  it("a lock is lifted by nothing but time: a success of the right password cannot have happened while locked, and a later success resets", async () => {
    await failTimes(5, "a@example.test", "203.0.113.1", ago(3 * MINUTE));
    expect((await throttled("a@example.test", undefined)).throttled).toBe(true);
    await recordAuthEvent("login", { email: "a@example.test", ip: "203.0.113.1", outcome: "success" }, ago(1 * MINUTE));
    expect((await throttled("a@example.test", undefined)).throttled).toBe(false);
  }, 60_000);
});

describe("e-mail and address are independent", () => {
  it("five failures of one e-mail from five addresses lock the e-mail, not any of the addresses", async () => {
    for (let i = 1; i <= 5; i++) await fail("target@example.test", `203.0.113.${i}`);
    expect((await throttled("target@example.test", "203.0.113.200")).throttled).toBe(true);
    expect((await throttled("other@example.test", "203.0.113.1")).throttled).toBe(false);
    expect((await throttled(undefined, "203.0.113.1")).throttled).toBe(false);
  }, 60_000);

  it("five failures from one address (five e-mails) lock the address, not any of the e-mails", async () => {
    for (let i = 1; i <= 5; i++) await fail(`user${i}@example.test`, "203.0.113.77");
    expect((await throttled("fresh@example.test", "203.0.113.77")).throttled).toBe(true);
    expect((await throttled("fresh@example.test", "203.0.113.78")).throttled).toBe(false);
    expect((await throttled("user1@example.test", "203.0.113.78")).throttled).toBe(false);
  }, 60_000);

  it("throttled when EITHER dimension is over the limit, and it asks about the dimensions it is given", async () => {
    await failTimes(5, "a@example.test", "203.0.113.1");
    expect((await throttled("a@example.test", "203.0.113.2")).throttled).toBe(true);
    expect((await throttled(undefined, "203.0.113.2")).throttled).toBe(false);
    expect((await throttled("a@example.test", undefined)).throttled).toBe(true);
    expect((await throttled(undefined, undefined)).throttled).toBe(false);
  }, 60_000);
});

describe("without a trusted proxy every request shares one address bucket", () => {
  it("that bucket does not lock at 5 (five typos by five people would lock everybody out) but at 100, and the e-mail still locks at 5", async () => {
    expect(UNTRUSTED_IP_MAX_FAILURES).toBe(100);
    // 5 failures of five different e-mails in the shared bucket: nobody is locked.
    for (let i = 1; i <= 5; i++) await fail(`user${i}@example.test`, UNTRUSTED_IP);
    expect((await throttled("fresh@example.test", UNTRUSTED_IP)).throttled).toBe(false);
    // The e-mail dimension is unchanged.
    await failTimes(4, "victim@example.test", UNTRUSTED_IP);
    expect((await throttled("victim@example.test", UNTRUSTED_IP)).throttled).toBe(false);
    await fail("victim@example.test", UNTRUSTED_IP);
    expect((await throttled("victim@example.test", UNTRUSTED_IP)).throttled).toBe(true);
    // 100 failures in the bucket in all: now it locks, for everyone.
    await db().authEvent.createMany({
      data: Array.from({ length: UNTRUSTED_IP_MAX_FAILURES }, () => ({ kind: "login", ipHash: hashIp(UNTRUSTED_IP), outcome: "failure", createdAt: NOW })),
    });
    expect((await throttled("fresh@example.test", UNTRUSTED_IP)).throttled).toBe(true);
  }, 60_000);
});

describe("the other endpoints are throttled per address", () => {
  it("registration counts every attempt (a success too) from one address: 5 and the sixth is refused", async () => {
    const ip = "203.0.113.5";
    for (let i = 0; i < 4; i++) await recordAuthEvent("register", { ip, outcome: "attempt" }, NOW);
    expect((await throttled(undefined, ip, "register")).throttled).toBe(false);
    await recordAuthEvent("register", { ip, outcome: "attempt" }, NOW);
    expect((await throttled(undefined, ip, "register")).throttled).toBe(true);
    expect((await throttled(undefined, "203.0.113.6", "register")).throttled).toBe(false);
  }, 60_000);

  it.each(["invite_accept", "reset_consume"] as const)("%s counts failures per address, not successes", async (kind) => {
    const ip = "203.0.113.8";
    for (let i = 0; i < 5; i++) await recordAuthEvent(kind, { ip, outcome: "success" }, NOW);
    expect((await throttled(undefined, ip, kind)).throttled).toBe(false);
    for (let i = 0; i < 5; i++) await recordAuthEvent(kind, { ip, outcome: "failure" }, NOW);
    expect((await throttled(undefined, ip, kind)).throttled).toBe(true);
  }, 60_000);

  it("each kind has its own count: login failures do not lock registration, and the reverse", async () => {
    const ip = "203.0.113.9";
    await failTimes(5, "a@example.test", ip);
    expect((await throttled(undefined, ip, "login")).throttled).toBe(true);
    expect((await throttled(undefined, ip, "register")).throttled).toBe(false);
    expect((await throttled(undefined, ip, "invite_accept")).throttled).toBe(false);
    expect((await throttled(undefined, ip, "reset_consume")).throttled).toBe(false);
  }, 60_000);
});

describe("what is stored", () => {
  it("is a hash of the e-mail and of the address, and nothing else that identifies anybody", async () => {
    await recordAuthEvent("login", { email: "Visible.Name@Example.TEST", ip: "203.0.113.200", outcome: "failure" }, NOW);
    const rows = await db().authEvent.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "login", outcome: "failure", emailHash: hashEmail("visible.name@example.test"), ipHash: hashIp("203.0.113.200") });
    const whole = JSON.stringify(rows).toLowerCase();
    for (const raw of ["visible", "example.test", "203.0.113.200", "203"]) expect(whole, raw).not.toContain(raw);
    expect(rows[0].emailHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].ipHash).toMatch(/^[0-9a-f]{64}$/);
  }, 60_000);

  it("records an event with only the dimensions it was given (a registration has an address, no e-mail)", async () => {
    await recordAuthEvent("register", { ip: "203.0.113.200", outcome: "attempt" }, NOW);
    const [row] = await db().authEvent.findMany();
    expect(row.emailHash).toBeNull();
    expect(row.ipHash).toBe(hashIp("203.0.113.200"));
  }, 60_000);
});

describe("pruning", () => {
  it("deletes rows older than 24 hours in the same transaction as an insert, and keeps the rest", async () => {
    const old = Array.from({ length: 3 }, () => ({ kind: "login", emailHash: "old", outcome: "failure", createdAt: ago(PRUNE_AFTER_MS + MINUTE) }));
    const young = Array.from({ length: 2 }, () => ({ kind: "login", emailHash: "young", outcome: "failure", createdAt: ago(PRUNE_AFTER_MS - 5 * MINUTE) }));
    await db().authEvent.createMany({ data: [...old, ...young] });

    await recordAuthEvent("login", { email: "a@example.test", ip: "203.0.113.1", outcome: "failure" }, NOW);

    expect(await db().authEvent.count({ where: { emailHash: "old" } })).toBe(0);
    expect(await db().authEvent.count({ where: { emailHash: "young" } })).toBe(2);
    expect(await db().authEvent.count()).toBe(3);
  }, 60_000);

  it("is bounded: one insert removes at most PRUNE_BATCH old rows, so a large backlog is worked off over the next inserts", async () => {
    expect(PRUNE_BATCH).toBeGreaterThanOrEqual(50);
    expect(PRUNE_BATCH).toBeLessThanOrEqual(1000);
    const extra = 7;
    await db().authEvent.createMany({
      data: Array.from({ length: PRUNE_BATCH + extra }, () => ({ kind: "login", emailHash: "old", outcome: "failure", createdAt: ago(PRUNE_AFTER_MS + 2 * MINUTE) })),
    });

    await recordAuthEvent("login", { email: "a@example.test", ip: "203.0.113.1", outcome: "failure" }, NOW);
    expect(await db().authEvent.count({ where: { emailHash: "old" } })).toBe(extra);

    await recordAuthEvent("login", { email: "a@example.test", ip: "203.0.113.1", outcome: "failure" }, NOW);
    expect(await db().authEvent.count({ where: { emailHash: "old" } })).toBe(0);
  }, 60_000);

  it("is the same transaction: an insert that fails leaves the old rows in place", async () => {
    await db().authEvent.createMany({ data: [{ kind: "login", emailHash: "old", outcome: "failure", createdAt: ago(PRUNE_AFTER_MS + MINUTE) }] });
    // A missing `outcome` makes Prisma refuse the INSERT, which comes after the prune statements inside the transaction: they must be rolled back.
    await expect(recordAuthEvent("login", { email: "a@example.test", ip: "203.0.113.1", outcome: undefined as never }, NOW)).rejects.toThrow();
    expect(await db().authEvent.count({ where: { emailHash: "old" } })).toBe(1);
  }, 60_000);
});
