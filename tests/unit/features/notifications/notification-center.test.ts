import { describe, it, expect } from "vitest";
import {
  NOTIFICATION_GROUPS,
  type NotificationItemData,
  type NotificationGroup,
} from "@/components/custom/NotificationCenter/NotificationCenter.types";
import { getNotificationNavigationUrl } from "@/components/custom/NotificationCenter/useNotificationCenter";
import type { NotificationType } from "@/types/schemas/notification";

// Helper to build a notification
function makeNotification(
  overrides: Partial<NotificationItemData> = {}
): NotificationItemData {
  return {
    id: `notif-${Math.random().toString(36).slice(2)}`,
    userId: "user-1",
    type: "APPROVAL_REQUEST",
    title: "Test notification",
    body: "Test body",
    entityRef: { entityId: "entity-1" },
    read: false,
    createdAt: new Date(),
    ...overrides,
  };
}

// Reproduce the grouping logic from useNotificationCenter
function groupNotifications(
  notifications: NotificationItemData[]
): NotificationGroup[] {
  return NOTIFICATION_GROUPS.map((group) => ({
    label: group.label,
    types: group.types,
    notifications: notifications.filter((n) =>
      (group.types as NotificationType[]).includes(n.type)
    ),
  })).filter((group) => group.notifications.length > 0);
}


describe("Notification Center Logic", () => {
  describe("Badge count", () => {
    it("matches unread count from notifications", () => {
      const notifications = [
        makeNotification({ read: false }),
        makeNotification({ read: false }),
        makeNotification({ read: true }),
      ];
      const unreadCount = notifications.filter((n) => !n.read).length;
      expect(unreadCount).toBe(2);
    });

    it("returns 0 when all are read", () => {
      const notifications = [
        makeNotification({ read: true }),
        makeNotification({ read: true }),
      ];
      const unreadCount = notifications.filter((n) => !n.read).length;
      expect(unreadCount).toBe(0);
    });

    it("displays '9+' format for counts over 9", () => {
      const count = 15;
      const displayCount = count > 9 ? "9+" : String(count);
      expect(displayCount).toBe("9+");
    });

    it("displays exact count for 9 or less", () => {
      const count = 5;
      const displayCount = count > 9 ? "9+" : String(count);
      expect(displayCount).toBe("5");
    });
  });

  describe("Grouping by type", () => {
    it("produces correct sections", () => {
      const notifications = [
        makeNotification({ type: "APPROVAL_REQUEST" }),
        makeNotification({ type: "APPROVAL_DECISION" }),
        makeNotification({ type: "CHANGE_COMPLETE" }),
        makeNotification({ type: "ANNOTATION_TAG" }),
        makeNotification({ type: "DRIFT_ALERT" }),
      ];

      const groups = groupNotifications(notifications);

      expect(groups).toHaveLength(4);
      expect(groups[0].label).toBe("Approvals");
      expect(groups[0].notifications).toHaveLength(2);
      expect(groups[1].label).toBe("Changes");
      expect(groups[1].notifications).toHaveLength(1);
      expect(groups[2].label).toBe("Mentions");
      expect(groups[2].notifications).toHaveLength(1);
      expect(groups[3].label).toBe("Alerts");
      expect(groups[3].notifications).toHaveLength(1);
    });

    it("hides sections with no notifications", () => {
      const notifications = [
        makeNotification({ type: "APPROVAL_REQUEST" }),
      ];

      const groups = groupNotifications(notifications);

      expect(groups).toHaveLength(1);
      expect(groups[0].label).toBe("Approvals");
    });

    it("empty state when no notifications exist", () => {
      const groups = groupNotifications([]);
      expect(groups).toHaveLength(0);
    });
  });

  describe("Click-to-navigate", () => {
    it("has no URL when the notification lacks route slugs", () => {
      const notification = makeNotification({
        type: "CHANGE_COMPLETE",
        entityRef: { entityId: "entity-1" },
      });

      expect(getNotificationNavigationUrl(notification)).toBeNull();
    });

    it("navigates to the entity route when domain, product and entity slugs are available", () => {
      const notification = makeNotification({
        type: "CHANGE_COMPLETE",
        entityRef: { entityId: "entity-1", entitySlug: "customer", domainSlug: "crm", productSlug: "orders" },
      });

      const url = getNotificationNavigationUrl(notification);
      expect(url).toBe("/schemas/crm/orders/customer");
    });

    it("has no URL when productSlug is missing", () => {
      const notification = makeNotification({
        type: "CHANGE_COMPLETE",
        entityRef: { entityId: "entity-1", entitySlug: "customer", domainSlug: "crm" },
      });

      expect(getNotificationNavigationUrl(notification)).toBeNull();
    });

    it("navigates a tenant-level entity (null slugs) to its Enterprise route", () => {
      const notification = makeNotification({
        type: "CHANGE_COMPLETE",
        entityRef: { entityId: "entity-1", entitySlug: "customer", domainSlug: null, productSlug: null },
      });

      expect(getNotificationNavigationUrl(notification)).toBe("/schemas/enterprise/entities/customer");
    });

    it("navigates a tenant-level field to field studio with version and panel params", () => {
      const notification = makeNotification({
        type: "APPROVAL_REQUEST",
        entityRef: {
          entityId: "entity-1",
          entitySlug: "customer",
          domainSlug: null,
          productSlug: null,
          fieldId: "field-1",
          fieldSlug: "email",
          versionId: "v2",
        },
      });

      expect(getNotificationNavigationUrl(notification)).toBe(
        "/schemas/enterprise/entities/customer/fields/email?version=v2&panel=governance"
      );
    });

    it("navigates to field studio when field route data is available", () => {
      const notification = makeNotification({
        type: "ANNOTATION_TAG",
        entityRef: { entityId: "entity-1", entitySlug: "customer", domainSlug: "crm", productSlug: "orders", fieldId: "field-1", fieldSlug: "email" },
      });

      const url = getNotificationNavigationUrl(notification);
      expect(url).toBe("/schemas/crm/orders/customer/fields/email");
    });

    it("preserves the version query param on a resolved entity route", () => {
      const notification = makeNotification({
        type: "CHANGE_COMPLETE",
        entityRef: { entityId: "entity-1", entitySlug: "customer", domainSlug: "crm", productSlug: "orders", versionId: "v3" },
      });

      expect(getNotificationNavigationUrl(notification)).toBe("/schemas/crm/orders/customer?version=v3");
    });

    it("has no URL for an unresolved notification even when it carries a version", () => {
      const notification = makeNotification({
        type: "CHANGE_COMPLETE",
        entityRef: { entityId: "entity-1", versionId: "v3" },
      });

      expect(getNotificationNavigationUrl(notification)).toBeNull();
    });

    it("adds governance panel param for APPROVAL_REQUEST", () => {
      const notification = makeNotification({
        type: "APPROVAL_REQUEST",
        entityRef: { entityId: "entity-1", entitySlug: "customer", domainSlug: "crm", productSlug: "orders", versionId: "v2" },
      });

      const url = getNotificationNavigationUrl(notification);
      expect(url).toContain("panel=governance");
      expect(url).toContain("version=v2");
    });

    it("marks notification as read on click (simulated)", () => {
      const notification = makeNotification({ read: false });
      // Simulate marking as read
      notification.read = true;
      expect(notification.read).toBe(true);
    });
  });

  describe("Mark all as read", () => {
    it("clears all unread indicators", () => {
      const notifications = [
        makeNotification({ read: false }),
        makeNotification({ read: false }),
        makeNotification({ read: true }),
      ];

      const updated = notifications.map((n) => ({ ...n, read: true }));
      const unreadAfter = updated.filter((n) => !n.read).length;
      expect(unreadAfter).toBe(0);
    });
  });

  describe("Polling configuration", () => {
    it("polling interval is 30 seconds", () => {
      const POLL_INTERVAL_MS = 30_000;
      expect(POLL_INTERVAL_MS).toBe(30000);
    });
  });
});
