import { describe, it, expect, beforeEach, vi } from "vitest";

// `withAudit` writes the audit row through the app's own client; here it is a pass-through that remembers how it was called.
vi.mock("@/lib/audit", () => ({
  AuditUserMissingError: class AuditUserMissingError extends Error {},
  withAudit: vi.fn(async ({ fn }: { fn: () => Promise<unknown> }) => fn()),
}));

import { AuditUserMissingError, withAudit } from "@/lib/audit";
import { getUsers, getUserById, updateUser } from "@/services/user.service";
import type { ServiceContext } from "@/types/service-context";

// ---------------------------------------------------------------------------
// A small stateful stand-in for the three Prisma delegates the service reads: `user`, `userRole`, and the `domain` a role names.
// It keeps its rows in this module (the "database"), not in the service: a service that held its own store would fail these tests.
// ---------------------------------------------------------------------------
interface UserRow {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
  createdAt: Date;
  updatedAt: Date;
}
interface RoleRow {
  id: string;
  userId: string;
  role: string;
  domainId: string | null;
  createdAt: Date;
}

let users: UserRow[] = [];
let roles: RoleRow[] = [];
let domains: Array<{ id: string; name: string }> = [];

type Where = { userId?: { in: string[] } | string; id?: string };

const fakePrisma = {
  user: {
    findMany: vi.fn(async (args?: { orderBy?: { createdAt: "asc" | "desc" } }) => {
      const rows = [...users];
      if (args?.orderBy?.createdAt === "asc") rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      return rows;
    }),
    findUnique: vi.fn(async (args: { where: { id: string } }) => users.find((u) => u.id === args.where.id) ?? null),
    update: vi.fn(async (args: { where: { id: string }; data: { name?: string } }) => {
      const row = users.find((u) => u.id === args.where.id);
      if (!row) throw Object.assign(new Error("Record to update not found."), { code: "P2025" });
      if (args.data.name !== undefined) row.name = args.data.name;
      row.updatedAt = new Date();
      return row;
    }),
  },
  userRole: {
    findMany: vi.fn(async (args: { where: Where }) => {
      const wanted = args.where.userId;
      const matches = roles.filter((r) =>
        typeof wanted === "string" ? r.userId === wanted : wanted ? wanted.in.includes(r.userId) : true,
      );
      return matches.map((r) => ({ ...r, domain: r.domainId ? { name: domains.find((d) => d.id === r.domainId)?.name ?? "" } : null }));
    }),
  },
};

const adminCtx: ServiceContext = { userId: "admin-1", userRole: "ADMIN", prisma: fakePrisma as unknown as ServiceContext["prisma"] };
const viewerCtx: ServiceContext = { userId: "viewer-1", userRole: "VIEWER", prisma: fakePrisma as unknown as ServiceContext["prisma"] };

const row = (id: string, name: string | null, email: string, createdAt: string): UserRow => ({
  id,
  name,
  email,
  image: null,
  createdAt: new Date(createdAt),
  updatedAt: new Date(createdAt),
});

describe("User Service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    users = [row("user-2", "Bob", "bob@example.com", "2026-01-02"), row("user-1", "Alice", "alice@example.com", "2026-01-01")];
    domains = [{ id: "dom-1", name: "Payments" }];
    roles = [
      { id: "role-1", userId: "user-1", role: "VIEWER", domainId: "dom-1", createdAt: new Date("2026-01-03") },
      { id: "role-2", userId: "user-1", role: "ADMIN", domainId: null, createdAt: new Date("2026-01-04") },
    ];
  });

  describe("getUsers", () => {
    it("lists the users of the database (oldest first) with their roles and the name of each role's domain", async () => {
      const result = await getUsers(adminCtx);
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.map((u) => u.email)).toEqual(["alice@example.com", "bob@example.com"]);
      const alice = result.data.find((u) => u.id === "user-1")!;
      expect(alice.roles).toEqual([
        { id: "role-1", role: "VIEWER", domainId: "dom-1", domainName: "Payments" },
        { id: "role-2", role: "ADMIN", domainId: null, domainName: undefined },
      ]);
      expect(result.data.find((u) => u.id === "user-2")!.roles).toEqual([]);
    });

    it("sees a user that was added to the database after an earlier call (no store of its own)", async () => {
      await getUsers(adminCtx);
      users.push(row("user-3", null, "carol@example.com", "2026-02-01"));
      const result = await getUsers(adminCtx);
      expect(result.success && result.data.map((u) => u.email)).toContain("carol@example.com");
    });

    it("asks the role table only for the listed users", async () => {
      await getUsers(adminCtx);
      expect(fakePrisma.userRole.findMany).toHaveBeenCalledTimes(1);
      expect(fakePrisma.userRole.findMany.mock.calls[0][0].where).toEqual({ userId: { in: ["user-1", "user-2"] } });
    });

    it("never selects the password hash", async () => {
      await getUsers(adminCtx);
      const select = (fakePrisma.user.findMany.mock.calls[0][0] as { select: Record<string, boolean> }).select;
      expect(select).toBeDefined();
      expect(select.password).toBeUndefined();
      expect(Object.keys(select).sort()).toEqual(["createdAt", "email", "id", "image", "name"]);
    });

    it("rejects non-Admin users", async () => {
      const result = await getUsers(viewerCtx);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe("FORBIDDEN");
      expect(fakePrisma.user.findMany).not.toHaveBeenCalled();
    });
  });

  describe("getUserById", () => {
    it("returns the single user with roles", async () => {
      const result = await getUserById("user-1", adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe("user-1");
        expect(result.data.name).toBe("Alice");
        expect(result.data.email).toBe("alice@example.com");
        expect(result.data.roles.map((r) => r.role)).toEqual(["VIEWER", "ADMIN"]);
        expect(result.data.roles[0].domainName).toBe("Payments");
      }
    });

    it("returns NOT_FOUND for a missing user", async () => {
      const result = await getUserById("nonexistent", adminCtx);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe("NOT_FOUND");
    });

    it("rejects non-Admin users", async () => {
      const result = await getUserById("user-1", viewerCtx);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe("FORBIDDEN");
    });
  });

  describe("updateUser", () => {
    it("writes the name to the database", async () => {
      const result = await updateUser({ id: "user-1", name: "Alice Updated" }, adminCtx);
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.name).toBe("Alice Updated");
      expect(users.find((u) => u.id === "user-1")!.name).toBe("Alice Updated");
      const again = await getUserById("user-1", adminCtx);
      expect(again.success && again.data.name).toBe("Alice Updated");
    });

    it("returns NOT_FOUND for a missing user", async () => {
      const result = await updateUser({ id: "nonexistent", name: "Test" }, adminCtx);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe("NOT_FOUND");
    });

    it("rejects an empty name", async () => {
      const result = await updateUser({ id: "user-1", name: "" }, adminCtx);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe("VALIDATION_ERROR");
      expect(fakePrisma.user.update).not.toHaveBeenCalled();
    });

    it("rejects non-Admin users and writes nothing", async () => {
      const result = await updateUser({ id: "user-1", name: "Hacked" }, viewerCtx);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe("FORBIDDEN");
      expect(users.find((u) => u.id === "user-1")!.name).toBe("Alice");
    });

    it("writes one audit entry for the admin who made the change, carrying the name as it was", async () => {
      await updateUser({ id: "user-1", name: "Alice Updated" }, adminCtx);

      expect(withAudit).toHaveBeenCalledTimes(1);
      const call = vi.mocked(withAudit).mock.calls[0][0];
      expect(call).toMatchObject({ action: "UPDATE", entityType: "User", entityId: "user-1", userId: "admin-1", beforeState: { name: "Alice" } });
    });

    it("writes no audit entry for a call it refuses (a role, a blank name, a missing user)", async () => {
      await updateUser({ id: "user-1", name: "Hacked" }, viewerCtx);
      await updateUser({ id: "user-1", name: "" }, adminCtx);
      await updateUser({ id: "nonexistent", name: "Test" }, adminCtx);

      expect(withAudit).not.toHaveBeenCalled();
    });

    it("tells an admin whose own user no longer exists to sign in again, and changes nothing", async () => {
      vi.mocked(withAudit).mockRejectedValueOnce(new AuditUserMissingError("gone"));

      const result = await updateUser({ id: "user-1", name: "Never Saved" }, adminCtx);

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe("UNAUTHORIZED");
      expect(users.find((u) => u.id === "user-1")!.name).toBe("Alice");
    });

    it("a user deleted between the read and the write (P2025) is NOT_FOUND", async () => {
      fakePrisma.user.update.mockRejectedValueOnce(Object.assign(new Error("Record to update not found."), { code: "P2025" }));

      const result = await updateUser({ id: "user-1", name: "Late" }, adminCtx);

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe("NOT_FOUND");
    });

    it("passes an unrelated database error on as a failure, never as NOT_FOUND", async () => {
      fakePrisma.user.update.mockRejectedValueOnce(Object.assign(new Error("connection lost"), { code: "P1001" }));
      await expect(updateUser({ id: "user-1", name: "X" }, adminCtx)).rejects.toThrow("connection lost");
    });
  });
});
