import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// In-memory store for the Prisma mock
// ---------------------------------------------------------------------------
let notifications: Array<{
  id: string;
  userId: string;
  type: string;
  title: string;
  body: string;
  entityId: string | null;
  read: boolean;
  createdAt: Date;
}> = [];
let idCounter = 0;

vi.mock("@/lib/db", () => ({
  prisma: {
    notification: {
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        const row = {
          id: `notif_${++idCounter}_${Date.now()}`,
          userId: args.data.userId as string,
          type: args.data.type as string,
          title: args.data.title as string,
          body: args.data.body as string,
          entityId: (args.data.entityId as string) ?? null,
          read: (args.data.read as boolean) ?? false,
          createdAt: new Date(),
        };
        notifications.push(row);
        return row;
      }),
      findMany: vi.fn(async (args?: { where?: Record<string, unknown>; orderBy?: Record<string, string>; skip?: number; take?: number }) => {
        let result = [...notifications];
        if (args?.where) {
          const w = args.where;
          if (w.userId) result = result.filter((n) => n.userId === w.userId);
          if (w.type && typeof w.type === "object" && "in" in w.type) {
            const types = (w.type as { in: string[] }).in;
            result = result.filter((n) => types.includes(n.type));
          }
          if (w.read !== undefined) result = result.filter((n) => n.read === w.read);
        }
        // Sort by createdAt desc by default
        result.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        if (args?.skip) result = result.slice(args.skip);
        if (args?.take) result = result.slice(0, args.take);
        return result;
      }),
      findUnique: vi.fn(async (args: { where: { id: string } }) => {
        return notifications.find((n) => n.id === args.where.id) ?? null;
      }),
      update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const n = notifications.find((n) => n.id === args.where.id);
        if (n) {
          Object.assign(n, args.data);
        }
        return n;
      }),
      updateMany: vi.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        notifications
          .filter((n) => {
            if (args.where.userId && n.userId !== args.where.userId) return false;
            if (args.where.read !== undefined && n.read !== args.where.read) return false;
            return true;
          })
          .forEach((n) => Object.assign(n, args.data));
      }),
      count: vi.fn(async (args?: { where?: Record<string, unknown> }) => {
        let result = [...notifications];
        if (args?.where) {
          if (args.where.userId) result = result.filter((n) => n.userId === args.where!.userId);
          if (args.where.read !== undefined) result = result.filter((n) => n.read === args.where!.read);
        }
        return result.length;
      }),
      deleteMany: vi.fn(async () => {
        notifications = [];
        idCounter = 0;
      }),
    },
  },
}));

import {
  createNotification,
  getNotificationsForUser,
  markAsRead,
  markAllAsRead,
  getUnreadCount,
  _resetStore,
} from "@/services/notification.service";
import type { ServiceContext } from "@/types/service-context";
import type { CreateNotificationInput } from "@/types/schemas/notification";

const mockCtx: ServiceContext = {
  userId: "user-1",
  userRole: "AUTHOR",
  prisma: {} as ServiceContext["prisma"],
};

const makeInput = (
  overrides: Partial<CreateNotificationInput> = {}
): CreateNotificationInput => ({
  userId: "user-1",
  type: "APPROVAL_REQUEST",
  title: "Test notification",
  body: "Test body content",
  entityRef: { entityId: "entity-1" },
  ...overrides,
});

describe("Notification Service", () => {
  beforeEach(async () => {
    await _resetStore();
  });

  describe("createNotification", () => {
    it("stores correct data with validated entityRef", async () => {
      const result = await createNotification(makeInput(), mockCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.userId).toBe("user-1");
        expect(result.data.type).toBe("APPROVAL_REQUEST");
        expect(result.data.title).toBe("Test notification");
        expect(result.data.body).toBe("Test body content");
        expect(result.data.entityRef).toEqual({ entityId: "entity-1" });
        expect(result.data.read).toBe(false);
        expect(result.data.id).toBeDefined();
        expect(result.data.createdAt).toBeInstanceOf(Date);
      }
    });

    it("stores entityRef with optional fieldId and versionId", async () => {
      const result = await createNotification(
        makeInput({
          entityRef: {
            entityId: "entity-1",
            fieldId: "field-1",
            versionId: "v2",
          },
        }),
        mockCtx
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.entityRef).toEqual({
          entityId: "entity-1",
          fieldId: "field-1",
          versionId: "v2",
        });
      }
    });

    it("returns validation error for missing title", async () => {
      const result = await createNotification(
        makeInput({ title: "" }),
        mockCtx
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
      }
    });

    it("returns validation error for missing userId", async () => {
      const result = await createNotification(
        makeInput({ userId: "" }),
        mockCtx
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
      }
    });

    it("returns validation error for invalid type", async () => {
      const result = await createNotification(
        makeInput({ type: "INVALID_TYPE" as never }),
        mockCtx
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("VALIDATION_ERROR");
      }
    });
  });

  describe("getNotificationsForUser", () => {
    it("returns user's notifications in reverse chronological order", async () => {
      // Use vi.useFakeTimers to guarantee distinct timestamps
      const now = new Date("2025-01-01T00:00:00Z").getTime();
      vi.useFakeTimers();

      vi.setSystemTime(now);
      await createNotification(makeInput({ title: "First" }), mockCtx);

      vi.setSystemTime(now + 1000);
      await createNotification(makeInput({ title: "Second" }), mockCtx);

      vi.setSystemTime(now + 2000);
      await createNotification(makeInput({ title: "Third" }), mockCtx);

      const result = await getNotificationsForUser("user-1", {}, { page: 1, pageSize: 25 }, mockCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.notifications).toHaveLength(3);
        expect(result.data.notifications[0].title).toBe("Third");
        expect(result.data.notifications[2].title).toBe("First");
      }

      vi.useRealTimers();
    });

    it("returns correct unreadCount", async () => {
      await createNotification(makeInput(), mockCtx);
      await createNotification(makeInput(), mockCtx);
      await createNotification(makeInput(), mockCtx);

      const result = await getNotificationsForUser("user-1", {}, { page: 1, pageSize: 25 }, mockCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.unreadCount).toBe(3);
      }
    });

    it("filters by notification type", async () => {
      await createNotification(
        makeInput({ type: "APPROVAL_REQUEST" }),
        mockCtx
      );
      await createNotification(
        makeInput({ type: "CHANGE_COMPLETE" }),
        mockCtx
      );

      const result = await getNotificationsForUser(
        "user-1",
        { types: ["APPROVAL_REQUEST"] },
        { page: 1, pageSize: 25 },
        mockCtx
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.notifications).toHaveLength(1);
        expect(result.data.notifications[0].type).toBe("APPROVAL_REQUEST");
      }
    });

    it("filters by read status", async () => {
      await createNotification(makeInput(), mockCtx);
      const r2 = await createNotification(makeInput(), mockCtx);
      if (r2.success) {
        await markAsRead(r2.data.id, mockCtx);
      }

      const result = await getNotificationsForUser(
        "user-1",
        { read: false },
        { page: 1, pageSize: 25 },
        mockCtx
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.notifications).toHaveLength(1);
        expect(result.data.notifications[0].read).toBe(false);
      }
    });

    it("only returns notifications for the specified user", async () => {
      await createNotification(makeInput({ userId: "user-1" }), mockCtx);
      await createNotification(makeInput({ userId: "user-2" }), mockCtx);

      const result = await getNotificationsForUser("user-1", {}, { page: 1, pageSize: 25 }, mockCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.notifications).toHaveLength(1);
        expect(result.data.notifications[0].userId).toBe("user-1");
      }
    });

    it("paginates results", async () => {
      for (let i = 0; i < 5; i++) {
        await createNotification(makeInput({ title: `Notif ${i}` }), mockCtx);
      }

      const result = await getNotificationsForUser(
        "user-1",
        {},
        { page: 1, pageSize: 2 },
        mockCtx
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.notifications).toHaveLength(2);
      }
    });
  });

  describe("markAsRead", () => {
    it("sets read=true and verifies ownership", async () => {
      const createResult = await createNotification(makeInput(), mockCtx);
      expect(createResult.success).toBe(true);
      if (!createResult.success) return;

      const result = await markAsRead(createResult.data.id, mockCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.read).toBe(true);
      }
    });

    it("rejects marking another user's notification", async () => {
      const createResult = await createNotification(
        makeInput({ userId: "user-2" }),
        mockCtx
      );
      expect(createResult.success).toBe(true);
      if (!createResult.success) return;

      const result = await markAsRead(createResult.data.id, mockCtx);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("FORBIDDEN");
      }
    });

    it("returns NOT_FOUND for non-existent notification", async () => {
      const result = await markAsRead("nonexistent-id", mockCtx);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe("NOT_FOUND");
      }
    });
  });

  describe("markAllAsRead", () => {
    it("updates all unread notifications for user", async () => {
      await createNotification(makeInput(), mockCtx);
      await createNotification(makeInput(), mockCtx);
      await createNotification(makeInput({ userId: "user-2" }), mockCtx);

      const result = await markAllAsRead("user-1", mockCtx);
      expect(result.success).toBe(true);

      const countResult = await getUnreadCount("user-1", mockCtx);
      expect(countResult.success).toBe(true);
      if (countResult.success) {
        expect(countResult.data).toBe(0);
      }

      // user-2's notification should still be unread
      const count2 = await getUnreadCount("user-2", mockCtx);
      if (count2.success) {
        expect(count2.data).toBe(1);
      }
    });
  });

  describe("getUnreadCount", () => {
    it("returns correct count", async () => {
      await createNotification(makeInput(), mockCtx);
      await createNotification(makeInput(), mockCtx);
      const r3 = await createNotification(makeInput(), mockCtx);
      if (r3.success) {
        await markAsRead(r3.data.id, mockCtx);
      }

      const result = await getUnreadCount("user-1", mockCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(2);
      }
    });

    it("returns 0 when no unread notifications", async () => {
      const result = await getUnreadCount("user-1", mockCtx);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe(0);
      }
    });
  });
});
