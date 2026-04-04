import { describe, it, expect, beforeEach } from "vitest";
import {
  getUserRoles,
  assignRole,
  removeRole,
  getEffectiveRole,
  hasPermission,
  bootstrapFirstAdmin,
  _resetRoleStore,
  _getRoleStore,
} from "@/services/rbac.service";
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
  beforeEach(() => {
    _resetRoleStore();
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
      expect(_getRoleStore()).toHaveLength(0);
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

  describe("bootstrapFirstAdmin", () => {
    it("assigns ADMIN to first user when no admins exist", async () => {
      const result = await bootstrapFirstAdmin("first-user", adminCtx);
      expect(result.success).toBe(true);

      const roles = _getRoleStore();
      expect(roles).toHaveLength(1);
      expect(roles[0].role).toBe("ADMIN");
      expect(roles[0].userId).toBe("first-user");
      expect(roles[0].domainId).toBeNull();
    });

    it("does not assign ADMIN when one already exists", async () => {
      await assignRole({ userId: "existing-admin", role: "ADMIN" }, adminCtx);
      const result = await bootstrapFirstAdmin("second-user", adminCtx);
      expect(result.success).toBe(true);

      const roles = _getRoleStore();
      const adminRoles = roles.filter((r) => r.role === "ADMIN");
      expect(adminRoles).toHaveLength(1);
      expect(adminRoles[0].userId).toBe("existing-admin");
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
