// @vitest-environment node
/**
 * Identity resolution from a session: by the session's user id ONLY. The old fallback (find the user by the e-mail in the session when the
 * id was stale) let a session whose id belonged to nobody act as whoever owned that address; it is gone. A disabled user is nobody.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ prisma: { user: { findUnique: vi.fn(), findFirst: vi.fn() } } }));
vi.mock("@/lib/db", () => ({ prisma: mocks.prisma }));

import { resolveGlobalAdminAccess } from "@/lib/access-control";
import { AuditUserMissingError } from "@/lib/audit";
import { resolveCurrentUserId } from "@/lib/current-user";

/** The database: the one account exists under its id and its e-mail; a lookup by anything else finds nothing. */
function database(account: { id: string; email: string; disabledAt?: Date | null; roles?: Array<{ id: string }> }) {
  mocks.prisma.user.findUnique.mockImplementation(async (args: { where: { id?: string; email?: string } }) =>
    args.where.id === account.id || args.where.email === account.email
      ? { id: account.id, disabledAt: account.disabledAt ?? null, roles: account.roles ?? [] }
      : null
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  database({ id: "real-id", email: "admin@admin.com" });
});

describe("resolveCurrentUserId", () => {
  it("is the id of the user the session names", async () => {
    await expect(resolveCurrentUserId({ id: "real-id" })).resolves.toBe("real-id");
    expect(mocks.prisma.user.findUnique).toHaveBeenCalledTimes(1);
    expect(mocks.prisma.user.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "real-id" } }));
  });

  it("NEVER rescues a stale id by the session's e-mail: the account that owns the address is not the session's user", async () => {
    await expect(resolveCurrentUserId({ id: "stale-id", email: "admin@admin.com" } as never)).rejects.toBeInstanceOf(AuditUserMissingError);
    expect(mocks.prisma.user.findUnique).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.prisma.user.findUnique.mock.calls)).not.toContain("admin@admin.com");
  });

  it("refuses a disabled user the way it refuses a missing one (one uniform 'sign in again')", async () => {
    database({ id: "real-id", email: "admin@admin.com", disabledAt: new Date("2026-10-01T00:00:00Z") });
    const disabled = await resolveCurrentUserId({ id: "real-id" }).catch((e: unknown) => e);
    const missing = await resolveCurrentUserId({ id: "nobody" }).catch((e: unknown) => e);
    expect(disabled).toBeInstanceOf(AuditUserMissingError);
    expect((disabled as Error).message).toBe((missing as Error).message.replace("nobody", "real-id"));
  });

  it.each([undefined, null, ""])("refuses a session without a user id (%j) without a query", async (id) => {
    await expect(resolveCurrentUserId({ id })).rejects.toBeInstanceOf(AuditUserMissingError);
    expect(mocks.prisma.user.findUnique).not.toHaveBeenCalled();
  });
});

describe("resolveGlobalAdminAccess", () => {
  it("is the user of the session id and whether they hold a global ADMIN assignment", async () => {
    database({ id: "real-id", email: "admin@admin.com", roles: [{ id: "r1" }] });
    await expect(resolveGlobalAdminAccess({ id: "real-id" })).resolves.toEqual({ userId: "real-id", isAdmin: true });
  });

  it("NEVER falls back to the user found by e-mail: a stale id is nobody, not the administrator who owns the address", async () => {
    database({ id: "real-id", email: "admin@admin.com", roles: [{ id: "r1" }] });
    await expect(resolveGlobalAdminAccess({ id: "stale-id", email: "admin@admin.com" } as never)).resolves.toBeNull();
    expect(JSON.stringify(mocks.prisma.user.findUnique.mock.calls)).not.toContain("admin@admin.com");
  });

  it("a disabled administrator is nobody", async () => {
    database({ id: "real-id", email: "admin@admin.com", roles: [{ id: "r1" }], disabledAt: new Date() });
    await expect(resolveGlobalAdminAccess({ id: "real-id" })).resolves.toBeNull();
  });

  it.each([null, undefined, {}, { id: "" }, { id: null }])("is null for %j without a query", async (user) => {
    await expect(resolveGlobalAdminAccess(user as never)).resolves.toBeNull();
    expect(mocks.prisma.user.findUnique).not.toHaveBeenCalled();
  });
});
