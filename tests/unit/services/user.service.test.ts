import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// In-memory store for the Prisma mock (used by rbac.service)
// ---------------------------------------------------------------------------
let roleStore: Array<{
  id: string;
  userId: string;
  role: string;
  domainId: string | null;
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
        async (args: { where: { userId: string; role: string; domainId: string | null } }) => {
          return (
            roleStore.find(
              (r) =>
                r.userId === args.where.userId &&
                r.role === args.where.role &&
                r.domainId === args.where.domainId
            ) ?? null
          );
        }
      ),
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        return roleStore.find((r) => r.id === args.where.id) ?? null;
      }),
      create: vi.fn(
        async (args: {
          data: { userId: string; role: string; domainId: string | null };
        }) => {
          const row = {
            id: `role-${++idCounter}`,
            userId: args.data.userId,
            role: args.data.role,
            domainId: args.data.domainId,
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
        if (args?.where?.role) {
          return roleStore.filter((r) => r.role === args.where!.role).length;
        }
        return roleStore.length;
      }),
    },
  },
}));

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
  beforeEach(async () => {
    _resetUserStore();
    await _resetRoleStore();
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
