/**
 * Hashing and checking a password. `verifyPassword` ALWAYS runs a bcrypt compare, including for an account that does not exist (against a
 * precomputed hash of nothing anybody knows), so the time a sign-in takes does not tell a visitor whether an e-mail has an account. The cost is
 * 12 (what every existing hash was made with), and a hash made at another cost, or with another bcrypt prefix, still verifies.
 */
import bcrypt from "bcryptjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BCRYPT_COST, DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from "@/lib/auth/password-hash";

afterEach(() => vi.restoreAllMocks());

describe("hashPassword", () => {
  it("is bcrypt at cost 12, and what it makes verifies", async () => {
    expect(BCRYPT_COST).toBe(12);
    const hash = await hashPassword("a long enough pass phrase");
    expect(hash).toMatch(/^\$2[aby]\$12\$[./A-Za-z0-9]{53}$/);
    expect(await verifyPassword("a long enough pass phrase", hash)).toBe(true);
    expect(await verifyPassword("a long enough pass phrasE", hash)).toBe(false);
  }, 30_000);

  it("makes a different hash every time (a random salt)", async () => {
    const [a, b] = await Promise.all([hashPassword("same password, twice"), hashPassword("same password, twice")]);
    expect(a).not.toBe(b);
  }, 30_000);
});

describe("verifyPassword accepts every hash an existing account can have", () => {
  it.each([
    ["$2a$", () => bcrypt.hashSync("legacy password", 4).replace(/^\$2b\$/, "$2a$")],
    ["$2b$", () => bcrypt.hashSync("legacy password", 4)],
    ["$2y$", () => bcrypt.hashSync("legacy password", 4).replace(/^\$2b\$/, "$2y$")],
  ])("a %s hash at another cost", async (_prefix, make) => {
    const hash = make();
    expect(await verifyPassword("legacy password", hash)).toBe(true);
    expect(await verifyPassword("another password", hash)).toBe(false);
  });

  it("a hash of the seed administrator's password at cost 12", async () => {
    const hash = bcrypt.hashSync("admin", 12);
    expect(await verifyPassword("admin", hash)).toBe(true);
  }, 30_000);

  it("a password longer than 72 bytes matches by its first 72 (bcrypt's own rule, kept for accounts made before the length rule)", async () => {
    const stored = bcrypt.hashSync("p".repeat(100), 4);
    expect(await verifyPassword("p".repeat(100), stored)).toBe(true);
    expect(await verifyPassword("p".repeat(72), stored)).toBe(true);
    expect(await verifyPassword("p".repeat(71), stored)).toBe(false);
  });
});

describe("verifyPassword does the same work for an account that does not exist", () => {
  it("the dummy hash is a real bcrypt hash at the same cost, and nothing a visitor could know matches it", async () => {
    expect(DUMMY_PASSWORD_HASH).toMatch(/^\$2b\$12\$[./A-Za-z0-9]{53}$/);
    expect(bcrypt.getRounds(DUMMY_PASSWORD_HASH)).toBe(BCRYPT_COST);
    for (const guess of ["", "password", "admin", "dummy", "x".repeat(40)]) expect(bcrypt.compareSync(guess, DUMMY_PASSWORD_HASH)).toBe(false);
  }, 30_000);

  it.each([
    ["no hash at all (null)", null],
    ["no hash at all (undefined)", undefined],
    ["an empty hash (an account made by Google has no password)", ""],
    ["something that is not a bcrypt hash", "not-a-bcrypt-hash"],
    ["a hash cut short", "$2b$12$abc"],
  ])("still runs bcrypt.compare, against the dummy hash: %s", async (_name, stored) => {
    const compare = vi.spyOn(bcrypt, "compare");
    expect(await verifyPassword("any password at all", stored as string | null | undefined)).toBe(false);
    expect(compare).toHaveBeenCalledTimes(1);
    expect(compare).toHaveBeenCalledWith("any password at all", DUMMY_PASSWORD_HASH);
  }, 30_000);

  it("runs bcrypt.compare against the stored hash when there is one", async () => {
    const stored = bcrypt.hashSync("right password!!", 4);
    const compare = vi.spyOn(bcrypt, "compare");
    expect(await verifyPassword("right password!!", stored)).toBe(true);
    expect(compare).toHaveBeenCalledTimes(1);
    expect(compare).toHaveBeenCalledWith("right password!!", stored);
  });

  it("never answers true for the dummy, even for the password the dummy was made from (unknown to everyone)", async () => {
    expect(await verifyPassword("anything", null)).toBe(false);
  }, 30_000);

  it("does not throw for a password that is not a string, or absurdly long, and still compares", async () => {
    const stored = bcrypt.hashSync("right password!!", 4);
    const compare = vi.spyOn(bcrypt, "compare");
    expect(await verifyPassword(undefined as unknown as string, stored)).toBe(false);
    expect(await verifyPassword(12345 as unknown as string, stored)).toBe(false);
    expect(await verifyPassword("z".repeat(2_000_000), stored)).toBe(false);
    expect(compare).toHaveBeenCalledTimes(3);
    // The long one is cut before it reaches bcrypt (which reads 72 bytes anyway): no multi-megabyte string is walked.
    expect((compare.mock.calls[2][0] as string).length).toBeLessThanOrEqual(1024);
  });
});
