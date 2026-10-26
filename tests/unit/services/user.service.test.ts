import { describe, it, expect, beforeEach, vi } from "vitest";

// `withAudit` writes the audit row through the app's own client; here it is a pass-through that remembers how it was called.
vi.mock("@/lib/audit", () => ({
  AuditUserMissingError: class AuditUserMissingError extends Error {},
  withAudit: vi.fn(async ({ fn }: { fn: () => Promise<unknown> }) => fn()),
}));

// The service now also holds the life-cycle functions, which run their own transactions through the app's client (tested on a real database in
// tests/integration/db/user-lifecycle-pglite.test.ts): this file only reads and renames through the context's client, so the app's own is a stand-in.
vi.mock("@/lib/db", () => ({ prisma: {} }));

import { AuditUserMissingError, withAudit } from "@/lib/audit";
import { getUserById, updateUser } from "@/services/user.service";
import type { ServiceContext } from "@/types/service-context";
import { assign } from "../../helpers/access-mocks";

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
  tenantId?: string | null;
  createdAt: Date;
}

let users: UserRow[] = [];
let roles: RoleRow[] = [];
let domains: Array<{ id: string; name: string }> = [];

type Where = { userId?: { in: string[] } | string; id?: string; tenantId?: string };
type UserWhere = { id?: string; roles?: { some: { tenantId: string } } };

/** The database's reading of `where` for a user: by id and, for a tenant administrator, only users with a role in that tenant. */
const userMatches = (u: UserRow, where?: UserWhere) =>
  (where?.id === undefined || u.id === where.id) && (where?.roles === undefined || roles.some((r) => r.userId === u.id && r.tenantId === where.roles!.some.tenantId));

const fakePrisma = {
  user: {
    findMany: vi.fn(async (args?: { where?: UserWhere; orderBy?: { createdAt: "asc" | "desc" } }) => {
      const rows = users.filter((u) => userMatches(u, args?.where));
      if (args?.orderBy?.createdAt === "asc") rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      return rows;
    }),
    findUnique: vi.fn(async (args: { where: { id: string } }) => users.find((u) => u.id === args.where.id) ?? null),
    findFirst: vi.fn(async (args: { where?: UserWhere }) => {
      const found = users.find((u) => userMatches(u, args.where));
      // `select: { roles: { select: { scopeKey, tenantId } } }`: the scope key of a platform row is "G", of a tenant row "T:<id>"
      return found
        ? { ...found, roles: roles.filter((r) => r.userId === found.id).map((r) => ({ scopeKey: r.tenantId ? `T:${r.tenantId}` : "G", tenantId: r.tenantId ?? null })) }
        : null;
    }),
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
      const matches = roles.filter(
        (r) => (typeof wanted === "string" ? r.userId === wanted : wanted ? wanted.in.includes(r.userId) : true) && (args.where.tenantId === undefined || r.tenantId === args.where.tenantId),
      );
      return matches.map((r) => ({ ...r, domain: r.domainId ? { name: domains.find((d) => d.id === r.domainId)?.name ?? "" } : null }));
    }),
  },
};

const adminCtx: ServiceContext = { userId: "admin-1", userRole: "ADMIN", assignments: [assign.global()], prisma: fakePrisma as unknown as ServiceContext["prisma"] };
const viewerCtx: ServiceContext = { userId: "viewer-1", userRole: "VIEWER", assignments: [assign.tenant("VIEWER", "tenant-1")], prisma: fakePrisma as unknown as ServiceContext["prisma"] };

const row = (id: string, name: string | null, email: string, createdAt: string): UserRow => ({
  id,
  name,
  email,
  image: null,
  createdAt: new Date(createdAt),
  updatedAt: new Date(createdAt),
});

/** A tenant administrator of tenant-1 with that tenant in view. */
const tenantAdminCtx: ServiceContext = {
  userId: "tadmin-1",
  userRole: "VIEWER",
  assignments: [assign.tenant("ADMIN", "tenant-1")],
  tenantId: "tenant-1",
  prisma: fakePrisma as unknown as ServiceContext["prisma"],
};

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

  describe("who sees whom", () => {
    beforeEach(() => {
      // user-1 holds a role in tenant-1 (and a platform one); user-2 holds one in tenant-2 only; user-3 holds none.
      users.push(row("user-3", "Carol", "carol@example.com", "2026-01-05"));
      roles = [
        { id: "role-a", userId: "user-1", role: "AUTHOR", domainId: "dom-1", tenantId: "tenant-1", createdAt: new Date("2026-01-03") },
        { id: "role-g", userId: "user-1", role: "ADMIN", domainId: null, tenantId: null, createdAt: new Date("2026-01-04") },
        { id: "role-b", userId: "user-2", role: "VIEWER", domainId: null, tenantId: "tenant-2", createdAt: new Date("2026-01-05") },
        { id: "role-c", userId: "user-1", role: "VIEWER", domainId: null, tenantId: "tenant-2", createdAt: new Date("2026-01-06") },
      ];
    });

    it("a user outside the tenant reads exactly like a missing one, by id", async () => {
      const outside = await getUserById("user-2", tenantAdminCtx);
      const missing = await getUserById("nonexistent", tenantAdminCtx);
      expect(!outside.success && outside.error.code).toBe("NOT_FOUND");
      expect(!missing.success && missing.error.code).toBe("NOT_FOUND");
      expect((await getUserById("user-3", tenantAdminCtx)).success).toBe(false);
      expect((await getUserById("user-1", tenantAdminCtx)).success).toBe(true);
    });

    it("a tenant administrator renames a user whose every role is in the tenant, and cannot rename one outside it, or one with a role elsewhere (it reads as missing, nothing is written)", async () => {
      users.push(row("user-4", "Dave", "dave@example.com", "2026-01-07"));
      roles.push({ id: "role-d", userId: "user-4", role: "AUTHOR", domainId: "dom-1", tenantId: "tenant-1", createdAt: new Date("2026-01-07") });
      expect((await updateUser({ id: "user-4", name: "Dave B" }, tenantAdminCtx)).success).toBe(true);
      expect(users.find((u) => u.id === "user-4")!.name).toBe("Dave B");
      // outside the tenant
      const outside = await updateUser({ id: "user-2", name: "Nope" }, tenantAdminCtx);
      expect(!outside.success && outside.error.code).toBe("NOT_FOUND");
      expect(users.find((u) => u.id === "user-2")!.name).toBe("Bob");
      // user-1 holds a role in the tenant, but also a platform ADMIN row and a role in tenant-2: out of a tenant administrator's reach, like for disabling
      const reachedOut = await updateUser({ id: "user-1", name: "Alice B" }, tenantAdminCtx);
      expect(!reachedOut.success && reachedOut.error.code).toBe("NOT_FOUND");
      expect(users.find((u) => u.id === "user-1")!.name).toBe("Alice");
      // a platform administrator renames anyone
      expect((await updateUser({ id: "user-1", name: "Alice C" }, adminCtx)).success).toBe(true);
    });

    it("an administrator of another tenant, a domain-scoped administrator and a context with no tenant in view are refused", async () => {
      const elsewhere = { ...tenantAdminCtx, assignments: [assign.tenant("ADMIN", "tenant-9")] };
      const domainAdmin = { ...tenantAdminCtx, assignments: [assign.domain("ADMIN", "tenant-1", "dom-1")] };
      const noTenant = { ...tenantAdminCtx, tenantId: undefined };
      for (const ctx of [elsewhere, domainAdmin, noTenant]) {
        const read = await getUserById("user-1", ctx);
        expect(!read.success && read.error.code).toBe("FORBIDDEN");
        const rename = await updateUser({ id: "user-1", name: "X" }, ctx);
        expect(!rename.success && rename.error.code).toBe("FORBIDDEN");
      }
      expect(fakePrisma.user.findMany).not.toHaveBeenCalled();
      expect(fakePrisma.user.update).not.toHaveBeenCalled();
    });

    it("anybody changes their OWN name; nobody else's without user.manage", async () => {
      users.push(row("viewer-1", "Vera", "vera@example.com", "2026-01-06"));
      expect((await updateUser({ id: "viewer-1", name: "Vera B" }, viewerCtx)).success).toBe(true);
      const other = await updateUser({ id: "user-1", name: "Hacked" }, viewerCtx);
      expect(!other.success && other.error.code).toBe("FORBIDDEN");
      expect(users.find((u) => u.id === "user-1")!.name).toBe("Alice");
      // an invalid input is not described to somebody who may not change that name
      const probe = await updateUser({ id: "user-1", name: "" }, viewerCtx);
      expect(!probe.success && probe.error.code).toBe("FORBIDDEN");
    });
  });
});
