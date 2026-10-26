/**
 * The password sign-in decision (`authenticateWithPassword`, what Auth.js's credentials `authorize` calls): one answer, `null`, for an unknown
 * e-mail, a wrong password, a disabled account and a locked e-mail or address, and the SAME work for all of them: a bcrypt compare always runs (the
 * dummy hash for an account that is not there, a disabled one is compared too, a locked one is compared against the dummy so the lock does not
 * show in the time), and every outcome is written down by hash: the attempt takes its place in the count BEFORE the compare and is settled after it
 * (the race itself is tested on a real database in tests/integration/auth/login-race-pglite.test.ts).
 */
import bcrypt from "bcryptjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findUnique: vi.fn(), reserveLoginAttempt: vi.fn(), settleAuthEvent: vi.fn(), recordAuthEvent: vi.fn() }));
vi.mock("@/lib/db", () => ({ prisma: { user: { findUnique: mocks.findUnique } } }));
vi.mock("@/lib/auth/throttle", () => ({ reserveLoginAttempt: mocks.reserveLoginAttempt, settleAuthEvent: mocks.settleAuthEvent, recordAuthEvent: mocks.recordAuthEvent }));

import { authenticateWithPassword } from "@/lib/auth/credentials";
import { DUMMY_PASSWORD_HASH } from "@/lib/auth/password-hash";

const IP = "203.0.113.7";
const PASSWORD = "the right password!";
let storedHash: string;
const userRow = (overrides: Record<string, unknown> = {}) => ({ id: "u1", email: "bob@example.test", name: "Bob", password: storedHash, disabledAt: null, ...overrides });

beforeEach(() => {
  storedHash = bcrypt.hashSync(PASSWORD, 4);
  vi.clearAllMocks();
  mocks.findUnique.mockResolvedValue(userRow());
  mocks.reserveLoginAttempt.mockResolvedValue({ id: "reservation-1", locked: false });
  mocks.settleAuthEvent.mockResolvedValue(undefined);
  mocks.recordAuthEvent.mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

const login = (email: unknown, password: unknown, ip = IP) => authenticateWithPassword({ email, password, ip });

describe("a correct password for a live account", () => {
  it("signs in: the id, the e-mail and the name, nothing else (never the hash)", async () => {
    expect(await login("bob@example.test", PASSWORD)).toEqual({ id: "u1", email: "bob@example.test", name: "Bob" });
  });

  it("looks the account up by the NORMALIZED e-mail", async () => {
    await login("  Bob@Example.TEST ", PASSWORD);
    expect(mocks.findUnique).toHaveBeenCalledWith({ where: { email: "bob@example.test" } });
  });

  it("takes its place with the normalized e-mail and the address BEFORE the account is looked up, and settles it as a success after", async () => {
    await login("  Bob@Example.TEST ", PASSWORD);
    expect(mocks.reserveLoginAttempt).toHaveBeenCalledWith({ email: "bob@example.test", ip: IP });
    expect(mocks.reserveLoginAttempt.mock.invocationCallOrder[0]).toBeLessThan(mocks.findUnique.mock.invocationCallOrder[0]);
    expect(mocks.settleAuthEvent).toHaveBeenCalledWith("reservation-1", "success");
    expect(mocks.settleAuthEvent.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.findUnique.mock.invocationCallOrder[0]);
    expect(mocks.recordAuthEvent).not.toHaveBeenCalled();
  });

  it("is still signed in when the success cannot be settled (best effort: the log never blocks a sign-in)", async () => {
    mocks.settleAuthEvent.mockRejectedValue(new Error("database is busy"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await login("bob@example.test", PASSWORD)).toMatchObject({ id: "u1" });
  });
});

describe("every refusal is the same answer, null, and the same work", () => {
  const compare = () => vi.spyOn(bcrypt, "compare");

  it("an unknown e-mail: null, and a bcrypt compare ran against the dummy hash", async () => {
    mocks.findUnique.mockResolvedValue(null);
    const spy = compare();
    expect(await login("nobody@example.test", PASSWORD)).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(PASSWORD, DUMMY_PASSWORD_HASH);
    expect(mocks.settleAuthEvent).toHaveBeenCalledWith("reservation-1", "failure");
  });

  it("a wrong password: null, a compare against the stored hash, a failure written down", async () => {
    const spy = compare();
    expect(await login("bob@example.test", "not the password")).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("not the password", storedHash);
    expect(mocks.settleAuthEvent).toHaveBeenCalledWith("reservation-1", "failure");
  });

  it("an account with no password (made by Google): null, and a compare against the dummy", async () => {
    mocks.findUnique.mockResolvedValue(userRow({ password: null }));
    const spy = compare();
    expect(await login("bob@example.test", PASSWORD)).toBeNull();
    expect(spy).toHaveBeenCalledWith(PASSWORD, DUMMY_PASSWORD_HASH);
  });

  it("a DISABLED account with the right password: null, the stored hash was compared (same work as a live account), a failure written down", async () => {
    mocks.findUnique.mockResolvedValue(userRow({ disabledAt: new Date() }));
    const spy = compare();
    expect(await login("bob@example.test", PASSWORD)).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(PASSWORD, storedHash);
    expect(mocks.settleAuthEvent).toHaveBeenCalledWith("reservation-1", "failure");
    expect(mocks.settleAuthEvent).not.toHaveBeenCalledWith(expect.anything(), "success");
  });

  it("a LOCKED e-mail or address with the right password: null, the account is not even looked up, a compare against the dummy ran, the attempt is written down as locked", async () => {
    mocks.reserveLoginAttempt.mockResolvedValue({ id: "reservation-1", locked: true, retryAfterSeconds: 600 });
    const spy = compare();
    expect(await login("bob@example.test", PASSWORD)).toBeNull();
    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(PASSWORD, DUMMY_PASSWORD_HASH);
    expect(mocks.settleAuthEvent).toHaveBeenCalledWith("reservation-1", "locked");
  });

  it("when no place can be taken in the throttle the answer is a refusal too (fail closed): the right password is not tried, with the same work", async () => {
    mocks.reserveLoginAttempt.mockRejectedValue(new Error("database is down"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const spy = compare();
    expect(await login("bob@example.test", PASSWORD)).toBeNull();
    expect(mocks.findUnique).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(PASSWORD, DUMMY_PASSWORD_HASH);
    expect(mocks.settleAuthEvent).not.toHaveBeenCalled();
  });

  it("is null for a refusal even when the failure cannot be settled", async () => {
    mocks.settleAuthEvent.mockRejectedValue(new Error("database is busy"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await login("bob@example.test", "wrong password!!")).toBeNull();
  });

  it("the answers for unknown, wrong, disabled and locked are one value, not four shapes", async () => {
    const answers: unknown[] = [];
    mocks.findUnique.mockResolvedValueOnce(null);
    answers.push(await login("nobody@example.test", PASSWORD));
    answers.push(await login("bob@example.test", "wrong password!!"));
    mocks.findUnique.mockResolvedValueOnce(userRow({ disabledAt: new Date() }));
    answers.push(await login("bob@example.test", PASSWORD));
    mocks.reserveLoginAttempt.mockResolvedValueOnce({ id: "reservation-2", locked: true });
    answers.push(await login("bob@example.test", PASSWORD));
    expect(answers).toEqual([null, null, null, null]);
  });

  it("a missing or non-string e-mail or password: null, one compare, and the failure is counted against the address", async () => {
    for (const [email, password] of [
      [undefined, PASSWORD],
      ["", PASSWORD],
      ["bob@example.test", undefined],
      ["bob@example.test", ""],
      [{ not: "a string" }, PASSWORD],
      ["bob@example.test", 12345],
    ] as const) {
      mocks.recordAuthEvent.mockClear();
      const spy = compare();
      expect(await login(email, password), JSON.stringify([email, password])).toBeNull();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(expect.any(String), DUMMY_PASSWORD_HASH);
      expect(mocks.recordAuthEvent).toHaveBeenCalledWith("login", expect.objectContaining({ ip: IP, outcome: "failure" }));
      spy.mockRestore();
    }
  });
});
