// @vitest-environment node
/**
 * The principal loader: who the request is, from the session user id ALONE. No session, no such user and a disabled user are all "nobody"
 * (null); there is no look-up by e-mail (a stale session id must not be rescued by an address); the assignments come from the stored rows
 * (their columns, checked against their scope key); the same user is read once per request.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assign, roleRowOf, sessionOf, userRow } from "../../../helpers/access-mocks";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  prisma: { user: { findUnique: vi.fn(), findFirst: vi.fn() } },
}));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/db", () => ({ prisma: mocks.prisma }));

import { getPrincipal, loadPrincipalById } from "@/lib/access/principal";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue(sessionOf("user-1"));
  mocks.prisma.user.findUnique.mockResolvedValue(userRow([assign.tenant("AUTHOR", "t1")]));
});

describe("getPrincipal: nobody", () => {
  it.each([
    ["no session", null],
    ["a session without a user", { expires: "2999-01-01" }],
    ["a session user without an id", { user: { email: "a@b.c" }, expires: "2999-01-01" }],
    ["an empty id", { user: { id: "", email: "a@b.c" }, expires: "2999-01-01" }],
    ["a non-string id", { user: { id: 5 }, expires: "2999-01-01" }],
  ])("is null for %s, and reads nothing", async (_name, session) => {
    mocks.auth.mockResolvedValue(session);
    await expect(getPrincipal()).resolves.toBeNull();
    expect(mocks.prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("is null for a user that does not exist (a stale session id after a database reset)", async () => {
    mocks.prisma.user.findUnique.mockResolvedValue(null);
    await expect(getPrincipal()).resolves.toBeNull();
  });

  it("is null for a disabled user, whatever roles they hold", async () => {
    mocks.prisma.user.findUnique.mockResolvedValue(userRow([assign.global()], { disabledAt: new Date("2026-10-01T00:00:00Z") }));
    await expect(getPrincipal()).resolves.toBeNull();
  });

  it("NEVER falls back to a user found by the session's e-mail: a stale id is nobody even when the address is a real account", async () => {
    mocks.auth.mockResolvedValue(sessionOf("stale-id", "admin@admin.com"));
    mocks.prisma.user.findUnique.mockImplementation(async (args: { where: Record<string, unknown> }) => {
      // The real account exists under its e-mail, not under the stale id: a fallback would find it.
      return args.where.email === "admin@admin.com" ? userRow([assign.global()], { id: "real-admin", email: "admin@admin.com" }) : null;
    });

    await expect(getPrincipal()).resolves.toBeNull();

    expect(mocks.prisma.user.findUnique).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "stale-id" } }));
    expect(JSON.stringify(mocks.prisma.user.findUnique.mock.calls)).not.toContain("admin@admin.com");
    expect(mocks.prisma.user.findFirst).not.toHaveBeenCalled();
  });
});

describe("getPrincipal: who", () => {
  it("is the user of the session id, with the e-mail the DATABASE holds (not the session's claim) and one read", async () => {
    mocks.auth.mockResolvedValue(sessionOf("user-1", "stale-claim@example.test"));
    mocks.prisma.user.findUnique.mockResolvedValue(userRow([assign.tenant("AUTHOR", "t1")], { email: "real@example.test" }));

    const principal = await getPrincipal();

    expect(principal).toMatchObject({ userId: "user-1", email: "real@example.test", isGlobalAdmin: false });
    expect(principal?.assignments).toEqual([assign.tenant("AUTHOR", "t1")]);
    expect(mocks.prisma.user.findUnique).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "user-1" } }));
  });

  it("builds every kind of scope from the stored columns", async () => {
    const stored = [assign.global(), assign.tenant("VIEWER", "t1"), assign.domain("AUTHOR", "t1", "d1"), assign.product("STEWARD", "t1", "d1", "p1")];
    mocks.prisma.user.findUnique.mockResolvedValue(userRow(stored));
    const principal = await getPrincipal();
    expect(principal?.assignments).toEqual(stored);
  });

  it("a user with no roles is a principal with no assignments (signed in, nothing granted)", async () => {
    mocks.prisma.user.findUnique.mockResolvedValue(userRow([]));
    await expect(getPrincipal()).resolves.toMatchObject({ userId: "user-1", assignments: [], isGlobalAdmin: false });
  });

  it("is a global administrator only through a GLOBAL ADMIN assignment: a tenant ADMIN is not one", async () => {
    mocks.prisma.user.findUnique.mockResolvedValue(userRow([assign.tenant("ADMIN", "t1")]));
    await expect(getPrincipal()).resolves.toMatchObject({ isGlobalAdmin: false });
    mocks.prisma.user.findUnique.mockResolvedValue(userRow([assign.global()]));
    await expect(getPrincipal()).resolves.toMatchObject({ isGlobalAdmin: true });
  });

  it("skips a stored row that is not a valid assignment, and never lets it grant anything", async () => {
    mocks.prisma.user.findUnique.mockResolvedValue({
      ...userRow([assign.tenant("VIEWER", "t1")]),
      roles: [
        roleRowOf(assign.tenant("VIEWER", "t1")),
        { ...roleRowOf(assign.global()), role: "SUPERUSER" }, // a role that is not on the ladder
        { ...roleRowOf(assign.global("VIEWER")) }, // GLOBAL is for ADMIN only
        { role: "ADMIN", scopeKey: "D:d1", tenantId: "t1", domainId: "other", productId: null }, // key and columns disagree
        { role: "ADMIN", scopeKey: "T:t2", tenantId: null, domainId: null, productId: null }, // the tenant column is missing
        { role: "ADMIN", scopeKey: "garbage", tenantId: null, domainId: null, productId: null },
        { role: "ADMIN", scopeKey: "P:p1", tenantId: "t1", domainId: null, productId: "p1" }, // a product scope needs its domain
        null,
      ],
    });
    const principal = await getPrincipal();
    expect(principal?.assignments).toEqual([assign.tenant("VIEWER", "t1")]);
    expect(principal?.isGlobalAdmin).toBe(false);
  });

  it("freezes what it hands out, so a caller cannot widen the cached principal", async () => {
    const principal = await getPrincipal();
    expect(Object.isFrozen(principal)).toBe(true);
    expect(Object.isFrozen(principal?.assignments)).toBe(true);
  });

  it("lets a database failure propagate (a lost connection is not 'signed out')", async () => {
    mocks.prisma.user.findUnique.mockRejectedValue(new Error("connection lost"));
    await expect(getPrincipal()).rejects.toThrow("connection lost");
  });
});

describe("loadPrincipalById", () => {
  it("is the same decision for an id the caller already holds", async () => {
    await expect(loadPrincipalById("user-1")).resolves.toMatchObject({ userId: "user-1" });
    mocks.prisma.user.findUnique.mockResolvedValue(null);
    await expect(loadPrincipalById("gone")).resolves.toBeNull();
    for (const bad of ["", "   ", 5, null, undefined, {}]) await expect(loadPrincipalById(bad as never)).resolves.toBeNull();
  });
});
