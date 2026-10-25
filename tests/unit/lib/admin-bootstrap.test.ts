import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Prisma } from "@/generated/prisma/client";

const { hashMock, compareMock, mockPrisma } = vi.hoisted(() => ({
  hashMock: vi.fn(async (password: string) => `hashed:${password}`),
  compareMock: vi.fn(async (password: string, hashed: string) => hashed === `hashed:${password}`),
  mockPrisma: {
    user: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn() },
    userRole: { findFirst: vi.fn(), create: vi.fn() },
  },
}));

// A real bcrypt hash at cost 12 is a quarter of a second each; the hashing itself is not what is under test.
vi.mock("bcryptjs", () => ({ hash: hashMock, compare: compareMock, default: { hash: hashMock, compare: compareMock } }));
vi.mock("@/lib/db", () => ({ prisma: mockPrisma }));

import {
  BOOTSTRAP_PASSWORD_MAX_BYTES,
  BOOTSTRAP_PASSWORD_MIN_BYTES,
  ensureBootstrapAdmin,
  normalizeBootstrapEmail,
  planSeedAdmin,
  validateBootstrapPassword,
} from "@/lib/admin-bootstrap";
import { resolveGlobalAdminAccess } from "@/lib/access-control";

const findUser = vi.fn();
const createUser = vi.fn();
const findRole = vi.fn();
const createRole = vi.fn();

const db = {
  user: { findFirst: findUser, create: createUser },
  userRole: { findFirst: findRole, create: createRole },
} as unknown as Pick<Prisma.TransactionClient, "user" | "userRole">;

const GOOD = "correct horse battery";
const uniqueViolation = () => Object.assign(new Error("Unique constraint failed on the fields: (`email`)"), { code: "P2002" });

describe("ensureBootstrapAdmin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findUser.mockResolvedValue(null);
    createUser.mockResolvedValue({ id: "new-admin" });
    findRole.mockResolvedValue(null);
    createRole.mockResolvedValue({ id: "role-1" });
  });

  it("creates the user and exactly one global ADMIN assignment, with the e-mail trimmed and lower-cased and the password hashed", async () => {
    await expect(ensureBootstrapAdmin({ email: "  Admin@Example.COM ", password: GOOD }, db)).resolves.toEqual({ status: "created", userId: "new-admin" });

    expect(findUser).toHaveBeenCalledWith({ where: { email: "admin@example.com" }, select: { id: true, password: true } });
    expect(hashMock).toHaveBeenCalledWith(GOOD, 12);
    expect(createUser).toHaveBeenCalledTimes(1);
    expect(createUser).toHaveBeenCalledWith({ data: { email: "admin@example.com", name: "Admin", password: `hashed:${GOOD}` }, select: { id: true } });
    expect(createRole).toHaveBeenCalledTimes(1);
    expect(createRole).toHaveBeenCalledWith({ data: { userId: "new-admin", role: "ADMIN", scopeKey: "G" } });
  });

  it("is idempotent: a user that is already a global administrator is left exactly as it is (no write, no password compare or reset)", async () => {
    findUser.mockResolvedValue({ id: "admin-1", password: "hashed:whatever-it-is-now" });
    findRole.mockResolvedValue({ id: "role-1" });

    await expect(ensureBootstrapAdmin({ email: "admin@example.com", password: GOOD }, db)).resolves.toEqual({ status: "unchanged", userId: "admin-1" });

    expect(findRole).toHaveBeenCalledWith({ where: { userId: "admin-1", role: "ADMIN", scopeKey: "G" }, select: { id: true } });
    expect(createUser).not.toHaveBeenCalled();
    expect(createRole).not.toHaveBeenCalled();
    expect(compareMock).not.toHaveBeenCalled();
    expect(hashMock).not.toHaveBeenCalled();
  });

  it("gives the assignment to an existing non-administrator only when the password is that user's own", async () => {
    findUser.mockResolvedValue({ id: "user-1", password: `hashed:${GOOD}` });

    await expect(ensureBootstrapAdmin({ email: "user@example.com", password: GOOD }, db)).resolves.toEqual({ status: "granted", userId: "user-1" });

    expect(createUser).not.toHaveBeenCalled();
    expect(createRole).toHaveBeenCalledWith({ data: { userId: "user-1", role: "ADMIN", scopeKey: "G" } });
  });

  it.each([
    ["a different password", { id: "user-1", password: "hashed:somebody else's" }],
    ["no password at all (a Google account)", { id: "user-1", password: null }],
  ])("refuses to make an existing account with %s an administrator (nobody takes over an account by registering the e-mail first), changing nothing", async (_label, existing) => {
    findUser.mockResolvedValue(existing);

    const result = await ensureBootstrapAdmin({ email: "user@example.com", password: GOOD }, db);

    expect(result).toMatchObject({ status: "refused", reason: "password-mismatch" });
    expect(createUser).not.toHaveBeenCalled();
    expect(createRole).not.toHaveBeenCalled();
  });

  it("refuses an e-mail that is not an address", async () => {
    for (const email of ["", "   ", "not-an-email", "a b@example.com", `${"x".repeat(250)}@example.com`]) {
      expect(await ensureBootstrapAdmin({ email, password: GOOD }, db), email).toMatchObject({ status: "refused", reason: "invalid-email" });
    }
    expect(findUser).not.toHaveBeenCalled();
    expect(createUser).not.toHaveBeenCalled();
  });

  it("does not enforce the password policy itself (the development default `admin` has to pass through; the callers validate)", async () => {
    await expect(ensureBootstrapAdmin({ email: "admin@admin.com", password: "admin" }, db)).resolves.toEqual({ status: "created", userId: "new-admin" });
  });

  it("accepts the user a concurrent bootstrap created first, then gives it the assignment only on the same password rule", async () => {
    createUser.mockRejectedValue(uniqueViolation());
    findUser.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "winner", password: `hashed:${GOOD}` });

    await expect(ensureBootstrapAdmin({ email: "admin@example.com", password: GOOD }, db)).resolves.toEqual({ status: "granted", userId: "winner" });
    expect(createRole).toHaveBeenCalledWith({ data: { userId: "winner", role: "ADMIN", scopeKey: "G" } });
  });

  it("reports a conflict, and writes nothing, when the e-mail exists in a different letter case (the unique index is on lower(email))", async () => {
    createUser.mockRejectedValue(uniqueViolation());
    findUser.mockResolvedValue(null);

    expect(await ensureBootstrapAdmin({ email: "admin@example.com", password: GOOD }, db)).toMatchObject({ status: "refused", reason: "conflict" });
    expect(createRole).not.toHaveBeenCalled();
  });

  it("treats a concurrent grant of the same assignment as done, and any other failure as a failure", async () => {
    findUser.mockResolvedValue({ id: "user-1", password: `hashed:${GOOD}` });
    createRole.mockRejectedValueOnce(uniqueViolation());
    findRole.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "raced" });
    await expect(ensureBootstrapAdmin({ email: "user@example.com", password: GOOD }, db)).resolves.toEqual({ status: "granted", userId: "user-1" });

    createRole.mockRejectedValueOnce(new Error("connection lost"));
    findRole.mockResolvedValue(null);
    await expect(ensureBootstrapAdmin({ email: "user@example.com", password: GOOD }, db)).rejects.toThrow("connection lost");

    createUser.mockRejectedValueOnce(new Error("disk full"));
    findUser.mockResolvedValue(null);
    await expect(ensureBootstrapAdmin({ email: "other@example.com", password: GOOD }, db)).rejects.toThrow("disk full");
  });
});

describe("validateBootstrapPassword", () => {
  it("states the rule: 12 to 72 bytes", () => {
    expect([BOOTSTRAP_PASSWORD_MIN_BYTES, BOOTSTRAP_PASSWORD_MAX_BYTES]).toEqual([12, 72]);
  });

  it.each([
    ["admin", false],
    ["x".repeat(11), false],
    ["x".repeat(12), true],
    ["x".repeat(72), true],
    ["x".repeat(73), false],
    ["é".repeat(36), true], // 72 bytes in 36 characters
    ["é".repeat(37), false], // 74 bytes: bcrypt would cut it, so it is refused
    ["é".repeat(6), true], // 12 bytes in 6 characters
    ["é".repeat(5), false],
    ["", false],
  ])("%j -> ok: %s", (password, ok) => {
    const result = validateBootstrapPassword(password);
    expect(result.ok).toBe(ok);
    if (!result.ok) expect(result.message).toMatch(/too (short|long)/);
  });
});

describe("planSeedAdmin (which administrator the seed makes)", () => {
  const STRONG = "a strong enough password";

  it("makes the development default only when NODE_ENV is not production and nothing is configured", () => {
    for (const env of [{}, { NODE_ENV: "development" }, { NODE_ENV: "test" }, { NODE_ENV: "" }, { BOOTSTRAP_ADMIN_EMAIL: "", BOOTSTRAP_ADMIN_PASSWORD: "" }]) {
      expect(planSeedAdmin(env), JSON.stringify(env)).toEqual({ kind: "development-default", email: "admin@admin.com", password: "admin" });
    }
  });

  it("makes no administrator at all in production when nothing is configured (no default admin/admin there)", () => {
    expect(planSeedAdmin({ NODE_ENV: "production" })).toEqual({ kind: "none" });
    expect(planSeedAdmin({ NODE_ENV: "production", BOOTSTRAP_ADMIN_EMAIL: "  ", BOOTSTRAP_ADMIN_PASSWORD: "" })).toEqual({ kind: "none" });
  });

  it("uses the configured e-mail and password in every environment, instead of the development default", () => {
    for (const NODE_ENV of ["production", "development", undefined]) {
      expect(planSeedAdmin({ NODE_ENV, BOOTSTRAP_ADMIN_EMAIL: " Boss@Example.com ", BOOTSTRAP_ADMIN_PASSWORD: STRONG })).toEqual({
        kind: "configured",
        email: "Boss@Example.com",
        password: STRONG,
      });
    }
  });

  it("does not trim the password it is given", () => {
    expect(planSeedAdmin({ BOOTSTRAP_ADMIN_EMAIL: "a@example.com", BOOTSTRAP_ADMIN_PASSWORD: ` ${STRONG} ` })).toMatchObject({ kind: "configured", password: ` ${STRONG} ` });
  });

  it.each([
    ["only the e-mail", { BOOTSTRAP_ADMIN_EMAIL: "a@example.com" }],
    ["only the password", { BOOTSTRAP_ADMIN_PASSWORD: "a strong enough password" }],
    ["only the e-mail, in production", { NODE_ENV: "production", BOOTSTRAP_ADMIN_EMAIL: "a@example.com" }],
  ])("is an error, not a silent fallback, when %s is set", (_label, env) => {
    const plan = planSeedAdmin(env);
    expect(plan).toMatchObject({ kind: "invalid" });
    if (plan.kind === "invalid") expect(plan.message).toMatch(/must be set together/);
  });

  it("is an error when the configured password breaks the 12 to 72 byte rule, naming the rule and never echoing the password", () => {
    for (const password of ["Qz9!pw", "Qz9!".repeat(19)]) {
      const plan = planSeedAdmin({ BOOTSTRAP_ADMIN_EMAIL: "a@example.com", BOOTSTRAP_ADMIN_PASSWORD: password });
      expect(plan.kind).toBe("invalid");
      if (plan.kind === "invalid") {
        expect(plan.message).toMatch(/BOOTSTRAP_ADMIN_PASSWORD is not acceptable/);
        expect(plan.message).toMatch(/too (short|long)/);
        expect(plan.message).not.toContain(password);
      }
    }
  });
});

describe("normalizeBootstrapEmail", () => {
  it("trims and lower-cases", () => {
    expect(normalizeBootstrapEmail("  Foo.Bar@Example.COM\n")).toBe("foo.bar@example.com");
  });
});

describe("no bootstrap from a request path", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolveGlobalAdminAccess is a pure read: a user with no administrator in the database stays a non-administrator and nothing is written or looked up to elect one", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: "first-user", roles: [] });

    await expect(resolveGlobalAdminAccess({ id: "first-user" })).resolves.toEqual({ userId: "first-user", isAdmin: false });

    expect(mockPrisma.user.findUnique).toHaveBeenCalledTimes(1);
    expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: "first-user" },
      select: { id: true, roles: { where: { role: "ADMIN", scopeKey: "G" }, select: { id: true }, take: 1 } },
    });
    expect(mockPrisma.user.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
    expect(mockPrisma.userRole.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.userRole.create).not.toHaveBeenCalled();
  });

  it("reads the administrator by the global scope key, not by 'no domain' (a tenant-scoped assignment has no domain either)", async () => {
    mockPrisma.user.findUnique.mockResolvedValue({ id: "admin-1", roles: [{ id: "r1" }] });
    await expect(resolveGlobalAdminAccess({ id: "admin-1" })).resolves.toEqual({ userId: "admin-1", isAdmin: true });
  });

  it("only the seed and the admin:create script import the bootstrap module: no file under src/ does", () => {
    const importers: string[] = [];
    const importsBootstrap = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'][^"']*admin-bootstrap["']/;
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "generated" || name === "node_modules") continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx|mjs|cjs|js)$/.test(name) && importsBootstrap.test(readFileSync(full, "utf8"))) importers.push(full);
      }
    };
    walk("src");
    expect(importers).toEqual([]);
  });
});
