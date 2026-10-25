import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// In-memory store for the Prisma mock
// ---------------------------------------------------------------------------
let roleStore: Array<{
  id: string;
  userId: string;
  role: string;
  scopeKey: string;
  tenantId: string | null;
  domainId: string | null;
  grantedById: string | null;
  createdAt: Date;
}> = [];
let idCounter = 0;

vi.mock("@/lib/db", () => ({
  prisma: {
    userRole: {
      findMany: vi.fn(async (args?: { where?: Record<string, unknown> }) => {
        if (args?.where?.userId) {
          return roleStore.filter((r) => r.userId === args.where!.userId);
        }
        return [...roleStore];
      }),
      findFirst: vi.fn(
        async (args: { where: { userId: string; role: string; scopeKey: string } }) => {
          return (
            roleStore.find(
              (r) =>
                r.userId === args.where.userId &&
                r.role === args.where.role &&
                r.scopeKey === args.where.scopeKey
            ) ?? null
          );
        }
      ),
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        return roleStore.find((r) => r.id === args.where.id) ?? null;
      }),
      create: vi.fn(
        async (args: {
          data: { userId: string; role: string; scopeKey: string; tenantId: string | null; domainId: string | null; grantedById: string | null };
        }) => {
          const row = {
            id: `role-${++idCounter}`,
            userId: args.data.userId,
            role: args.data.role,
            scopeKey: args.data.scopeKey,
            tenantId: args.data.tenantId,
            domainId: args.data.domainId,
            grantedById: args.data.grantedById,
            createdAt: new Date(),
          };
          roleStore.push(row);
          return row;
        }
      ),
      delete: vi.fn(async (args: { where: { id: string } }) => {
        const idx = roleStore.findIndex((r) => r.id === args.where.id);
        if (idx !== -1) roleStore.splice(idx, 1);
      }),
      deleteMany: vi.fn(async () => {
        roleStore = [];
        idCounter = 0;
      }),
      count: vi.fn(async (args?: { where?: Record<string, unknown> }) => {
        const where = args?.where ?? {};
        return roleStore.filter(
          (r) => (where.role === undefined || r.role === where.role) && (where.scopeKey === undefined || r.scopeKey === where.scopeKey)
        ).length;
      }),
    },
    // The users that exist: every id but "ghost-user" (a role row has a foreign key to its user: an id that is nobody's used to throw P2003).
    user: {
      findUnique: vi.fn(async (args: { where: { id: string } }) => (args.where.id === "ghost-user" ? null : { id: args.where.id })),
    },
    // The domains that exist: the ones whose id starts with "dom-" (a role row has a foreign key to its domain), all in tenant "tenant-a".
    domain: {
      findUnique: vi.fn(async (args: { where: { id: string } }) => (args.where.id.startsWith("dom-") ? { id: args.where.id, tenantId: "tenant-a" } : null)),
    },
  },
}));

import {
  getUserRoles,
  assignRole,
  removeRole,
  getEffectiveRole,
  hasPermission,
  _resetRoleStore,
  _getRoleStore,
} from "@/services/rbac.service";
import { prisma } from "@/lib/db";
import type { ServiceContext } from "@/types/service-context";

const adminCtx: ServiceContext = {
  userId: "admin-1",
  userRole: "ADMIN",
  prisma: null as unknown as ServiceContext["prisma"],
};

const authorCtx: ServiceContext = {
  userId: "author-1",
  userRole: "AUTHOR",
  prisma: null as unknown as ServiceContext["prisma"],
};

const viewerCtx: ServiceContext = {
  userId: "viewer-1",
  userRole: "VIEWER",
  prisma: null as unknown as ServiceContext["prisma"],
};

describe("RBAC Service", () => {
  beforeEach(async () => {
    await _resetRoleStore();
  });

  describe("assignRole", () => {
    it("assigns a domain-scoped VIEWER role", async () => {
      const result = await assignRole(
        { userId: "user-1", role: "VIEWER", domainId: "dom-1" },
        adminCtx
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.role).toBe("VIEWER");
        expect(result.data.domainId).toBe("dom-1");
      }
    });

    it("refuses a domain that does not exist, with a message, and writes nothing", async () => {
      const result = await assignRole(
        { userId: "user-1", role: "VIEWER", domainId: "no-such-domain" },
        adminCtx
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("NOT_FOUND");
        expect(result.error.message).toBe('Domain "no-such-domain" not found');
      }
      expect(await _getRoleStore()).toEqual([]);
    });

    it("refuses a user that does not exist, with a message, and writes nothing (the foreign key used to throw P2003 out of the action)", async () => {
      for (const input of [
        { userId: "ghost-user", role: "VIEWER" as const, domainId: "dom-1" },
        { userId: "ghost-user", role: "ADMIN" as const },
      ]) {
        const result = await assignRole(input, adminCtx);
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.code).toBe("NOT_FOUND");
          expect(result.error.message).toBe('User "ghost-user" not found');
          expect(result.error.suggestedFix).toMatch(/existing user/i);
        }
      }
      expect(await _getRoleStore()).toEqual([]);
    });

    it("assigns a domain-scoped AUTHOR role", async () => {
      const result = await assignRole(
        { userId: "user-1", role: "AUTHOR", domainId: "dom-1" },
        adminCtx
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.role).toBe("AUTHOR");
      }
    });

    it("assigns a domain-scoped STEWARD role", async () => {
      const result = await assignRole(
        { userId: "user-1", role: "STEWARD", domainId: "dom-1" },
        adminCtx
      );
      expect(result.success).toBe(true);
    });

    it("assigns system-level ADMIN role", async () => {
      const result = await assignRole(
        { userId: "user-2", role: "ADMIN" },
        adminCtx
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.role).toBe("ADMIN");
        expect(result.data.domainId).toBeNull();
      }
    });

    it("assigns system-level COMPLIANCE_OFFICER role", async () => {
      const result = await assignRole(
        { userId: "user-3", role: "COMPLIANCE_OFFICER" },
        adminCtx
      );
      expect(result.success).toBe(true);
    });

    it("rejects ADMIN role with domainId (must be system-level)", async () => {
      const result = await assignRole(
        { userId: "user-1", role: "ADMIN", domainId: "dom-1" },
        adminCtx
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
        expect(result.error.message).toContain("system-level");
      }
    });

    it("rejects COMPLIANCE_OFFICER role with domainId", async () => {
      const result = await assignRole(
        { userId: "user-1", role: "COMPLIANCE_OFFICER", domainId: "dom-1" },
        adminCtx
      );
      expect(result.success).toBe(false);
    });

    it("rejects VIEWER role without domainId (requires domain)", async () => {
      const result = await assignRole(
        { userId: "user-1", role: "VIEWER" },
        adminCtx
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toContain("requires a domainId");
      }
    });

    it("rejects AUTHOR role without domainId", async () => {
      const result = await assignRole(
        { userId: "user-1", role: "AUTHOR" },
        adminCtx
      );
      expect(result.success).toBe(false);
    });

    it("rejects duplicate role assignment", async () => {
      await assignRole(
        { userId: "user-1", role: "VIEWER", domainId: "dom-1" },
        adminCtx
      );
      const result = await assignRole(
        { userId: "user-1", role: "VIEWER", domainId: "dom-1" },
        adminCtx
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("DUPLICATE");
      }
    });

    it("rejects non-Admin users", async () => {
      const result = await assignRole(
        { userId: "user-1", role: "VIEWER", domainId: "dom-1" },
        authorCtx
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("FORBIDDEN");
        expect(result.error.message).toContain("ADMIN");
      }
    });
  });

  describe("removeRole", () => {
    it("removes a role assignment", async () => {
      const assigned = await assignRole(
        { userId: "user-1", role: "VIEWER", domainId: "dom-1" },
        adminCtx
      );
      expect(assigned.success).toBe(true);
      if (!assigned.success) return;

      const result = await removeRole(assigned.data.id, adminCtx);
      expect(result.success).toBe(true);
      const store = await _getRoleStore();
      expect(store).toHaveLength(0);
    });

    it("admin cannot remove their own Admin role", async () => {
      const assigned = await assignRole(
        { userId: "admin-1", role: "ADMIN" },
        adminCtx
      );
      expect(assigned.success).toBe(true);
      if (!assigned.success) return;

      const result = await removeRole(assigned.data.id, adminCtx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toContain("Cannot remove your own admin role");
      }
    });

    it("cannot remove the last admin", async () => {
      // Assign ADMIN to a different user
      const assigned = await assignRole(
        { userId: "user-other", role: "ADMIN" },
        adminCtx
      );
      expect(assigned.success).toBe(true);
      if (!assigned.success) return;

      // Only one admin exists, try to remove
      const result = await removeRole(assigned.data.id, adminCtx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toContain("at least one admin");
      }
    });

    it("can remove admin when another admin exists", async () => {
      // First admin
      await assignRole({ userId: "admin-1", role: "ADMIN" }, adminCtx);
      // Second admin
      const second = await assignRole({ userId: "admin-2", role: "ADMIN" }, adminCtx);
      expect(second.success).toBe(true);
      if (!second.success) return;

      // Remove second admin (not self)
      const result = await removeRole(second.data.id, adminCtx);
      expect(result.success).toBe(true);
    });

    it("rejects non-Admin users", async () => {
      const result = await removeRole("some-id", authorCtx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("FORBIDDEN");
      }
    });
  });

  describe("getEffectiveRole", () => {
    it("returns null when user has no roles", async () => {
      const result = await getEffectiveRole("user-1", "dom-1", adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBeNull();
      }
    });

    it("returns domain-scoped role for matching domain", async () => {
      await assignRole(
        { userId: "user-1", role: "AUTHOR", domainId: "dom-1" },
        adminCtx
      );
      const result = await getEffectiveRole("user-1", "dom-1", adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe("AUTHOR");
      }
    });

    it("domain-scoped role does NOT apply to different domain", async () => {
      await assignRole(
        { userId: "user-1", role: "AUTHOR", domainId: "dom-1" },
        adminCtx
      );
      const result = await getEffectiveRole("user-1", "dom-2", adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBeNull();
      }
    });

    it("system-level roles apply globally (any domain)", async () => {
      await assignRole({ userId: "user-1", role: "ADMIN" }, adminCtx);
      const result = await getEffectiveRole("user-1", "dom-999", adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe("ADMIN");
      }
    });

    it("returns the most permissive role when user has multiple", async () => {
      await assignRole(
        { userId: "user-1", role: "VIEWER", domainId: "dom-1" },
        adminCtx
      );
      await assignRole(
        { userId: "user-1", role: "STEWARD", domainId: "dom-1" },
        adminCtx
      );
      const result = await getEffectiveRole("user-1", "dom-1", adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe("STEWARD");
      }
    });

    it("system ADMIN overrides domain VIEWER", async () => {
      await assignRole(
        { userId: "user-1", role: "VIEWER", domainId: "dom-1" },
        adminCtx
      );
      await assignRole({ userId: "user-1", role: "ADMIN" }, adminCtx);
      const result = await getEffectiveRole("user-1", "dom-1", adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe("ADMIN");
      }
    });
  });

  describe("hasPermission", () => {
    it("returns true when user has sufficient role", async () => {
      await assignRole(
        { userId: "user-1", role: "STEWARD", domainId: "dom-1" },
        adminCtx
      );
      const result = await hasPermission("user-1", "AUTHOR", "dom-1", adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(true);
      }
    });

    it("returns false when user has insufficient role", async () => {
      await assignRole(
        { userId: "user-1", role: "VIEWER", domainId: "dom-1" },
        adminCtx
      );
      const result = await hasPermission("user-1", "AUTHOR", "dom-1", adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(false);
      }
    });

    it("returns false when user has no roles", async () => {
      const result = await hasPermission("user-1", "VIEWER", "dom-1", adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(false);
      }
    });

    it("Viewer can read (has VIEWER permission)", async () => {
      await assignRole(
        { userId: "user-1", role: "VIEWER", domainId: "dom-1" },
        adminCtx
      );
      const result = await hasPermission("user-1", "VIEWER", "dom-1", adminCtx);
      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toBe(true);
    });

    it("Viewer cannot create (lacks AUTHOR permission)", async () => {
      await assignRole(
        { userId: "user-1", role: "VIEWER", domainId: "dom-1" },
        adminCtx
      );
      const result = await hasPermission("user-1", "AUTHOR", "dom-1", adminCtx);
      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toBe(false);
    });

    it("Author can create in their domain", async () => {
      await assignRole(
        { userId: "user-1", role: "AUTHOR", domainId: "dom-1" },
        adminCtx
      );
      const result = await hasPermission("user-1", "AUTHOR", "dom-1", adminCtx);
      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toBe(true);
    });

    it("Author cannot create in different domain", async () => {
      await assignRole(
        { userId: "user-1", role: "AUTHOR", domainId: "dom-1" },
        adminCtx
      );
      const result = await hasPermission("user-1", "AUTHOR", "dom-2", adminCtx);
      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toBe(false);
    });

    it("Admin has all permissions globally", async () => {
      await assignRole({ userId: "user-1", role: "ADMIN" }, adminCtx);
      const result = await hasPermission("user-1", "ADMIN", "any-domain", adminCtx);
      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toBe(true);
    });
  });

  describe("scope keys (the user_roles unique key since the access_control migration)", () => {
    it("writes the global key for a system-level role and the domain key, its tenant and the granter for a domain-scoped one", async () => {
      await assignRole({ userId: "user-1", role: "ADMIN" }, adminCtx);
      await assignRole({ userId: "user-1", role: "AUTHOR", domainId: "dom-1" }, adminCtx);

      const rows = (await prisma.userRole.findMany()) as unknown as Array<Record<string, unknown>>;
      const pick = (row: Record<string, unknown>) =>
        Object.fromEntries(["userId", "role", "scopeKey", "tenantId", "domainId", "grantedById"].map((key) => [key, row[key]]));
      expect(rows.map(pick)).toEqual([
        { userId: "user-1", role: "ADMIN", scopeKey: "G", tenantId: null, domainId: null, grantedById: "admin-1" },
        { userId: "user-1", role: "AUTHOR", scopeKey: "D:dom-1", tenantId: "tenant-a", domainId: "dom-1", grantedById: "admin-1" },
      ]);
    });

    it("no longer has a way to make a user the administrator because none exists (the first administrator is the seed's or admin:create's)", async () => {
      expect(await import("@/services/rbac.service")).not.toHaveProperty("bootstrapFirstAdmin");
      expect(await _getRoleStore()).toEqual([]);
    });

    it("a tenant-scoped or product-scoped row is not read by the legacy effective-role lookup (it knows the global and domain scopes only)", async () => {
      roleStore.push(
        { id: "t", userId: "user-1", role: "ADMIN", scopeKey: "T:tenant-a", tenantId: "tenant-a", domainId: null, grantedById: null, createdAt: new Date() },
        { id: "p", userId: "user-1", role: "STEWARD", scopeKey: "P:prod-1", tenantId: "tenant-a", domainId: "dom-1", grantedById: null, createdAt: new Date() }
      );
      const result = await getEffectiveRole("user-1", "dom-1", adminCtx);
      expect(result).toEqual({ success: true, data: null });
    });

    it("removing a tenant-scoped ADMIN row is not stopped by the last-global-admin rule, removing the last global one is", async () => {
      roleStore.push(
        { id: "t", userId: "someone", role: "ADMIN", scopeKey: "T:tenant-a", tenantId: "tenant-a", domainId: null, grantedById: null, createdAt: new Date() },
        { id: "g", userId: "the-only-global", role: "ADMIN", scopeKey: "G", tenantId: null, domainId: null, grantedById: null, createdAt: new Date() }
      );
      expect((await removeRole("t", adminCtx)).success).toBe(true);
      const last = await removeRole("g", adminCtx);
      expect(last.success).toBe(false);
      if (!last.success) expect(last.error.message).toContain("at least one admin");
    });
  });

  describe("getUserRoles", () => {
    it("returns all roles for a user", async () => {
      await assignRole(
        { userId: "user-1", role: "VIEWER", domainId: "dom-1" },
        adminCtx
      );
      await assignRole(
        { userId: "user-1", role: "AUTHOR", domainId: "dom-2" },
        adminCtx
      );

      const result = await getUserRoles("user-1", adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(2);
      }
    });

    it("returns empty array for user with no roles", async () => {
      const result = await getUserRoles("nobody", adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(0);
      }
    });
  });
});
