import { describe, it, expect, beforeEach } from "vitest";
import {
  getUsers,
  getUserById,
  updateUser,
  _resetUserStore,
  _seedUsers,
  type UserRecord,
} from "@/services/user.service";
import { assignRole, _resetRoleStore } from "@/services/rbac.service";
import type { ServiceContext } from "@/types/service-context";

const adminCtx: ServiceContext = {
  userId: "admin-1",
  userRole: "ADMIN",
  prisma: null as unknown as ServiceContext["prisma"],
};

const viewerCtx: ServiceContext = {
  userId: "viewer-1",
  userRole: "VIEWER",
  prisma: null as unknown as ServiceContext["prisma"],
};

const testUsers: UserRecord[] = [
  {
    id: "user-1",
    name: "Alice",
    email: "alice@example.com",
    image: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastLogin: null,
    status: "active",
  },
  {
    id: "user-2",
    name: "Bob",
    email: "bob@example.com",
    image: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    lastLogin: null,
    status: "active",
  },
];

describe("User Service", () => {
  beforeEach(() => {
    _resetUserStore();
    _resetRoleStore();
    _seedUsers(testUsers);
  });

  describe("getUsers", () => {
    it("returns all users with roles (Admin only)", async () => {
      await assignRole(
        { userId: "user-1", role: "VIEWER", domainId: "dom-1" },
        adminCtx
      );

      const result = await getUsers(adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(2);
        const alice = result.data.find((u) => u.id === "user-1");
        expect(alice).toBeDefined();
        expect(alice!.roles).toHaveLength(1);
        expect(alice!.roles[0].role).toBe("VIEWER");
      }
    });

    it("rejects non-Admin users", async () => {
      const result = await getUsers(viewerCtx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("FORBIDDEN");
      }
    });
  });

  describe("getUserById", () => {
    it("returns single user with roles", async () => {
      const result = await getUserById("user-1", adminCtx);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe("user-1");
        expect(result.data.name).toBe("Alice");
        expect(result.data.email).toBe("alice@example.com");
      }
    });

    it("returns NOT_FOUND for missing user", async () => {
      const result = await getUserById("nonexistent", adminCtx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });

    it("rejects non-Admin users", async () => {
      const result = await getUserById("user-1", viewerCtx);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("FORBIDDEN");
      }
    });
  });

  describe("updateUser", () => {
    it("updates user name", async () => {
      const result = await updateUser(
        { id: "user-1", name: "Alice Updated" },
        adminCtx
      );
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe("Alice Updated");
      }
    });

    it("returns NOT_FOUND for missing user", async () => {
      const result = await updateUser(
        { id: "nonexistent", name: "Test" },
        adminCtx
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });

    it("rejects non-Admin users", async () => {
      const result = await updateUser(
        { id: "user-1", name: "Hacked" },
        viewerCtx
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("FORBIDDEN");
      }
    });
  });
});
