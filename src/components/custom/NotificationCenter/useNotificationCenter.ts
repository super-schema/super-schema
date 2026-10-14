"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import type {
  NotificationItemData,
  NotificationGroup,
} from "./NotificationCenter.types";
import { NOTIFICATION_GROUPS } from "./NotificationCenter.types";
import type { NotificationType } from "@/types/schemas/notification";
import { assetHref } from "@/lib/navigation/asset-href";

const POLL_INTERVAL_MS = 30_000;
const MAX_NOTIFICATIONS = 50;

/**
 * The entity (or field) URL a notification opens, or `null` when it was never
 * resolved to route slugs. There is no route that locates an entity by id alone,
 * so an unresolved notification is not navigable.
 */
export function getNotificationNavigationUrl(
  notification: NotificationItemData
): string | null {
  const { entityRef, type } = notification;
  const query: Record<string, string> = {};
  if (entityRef.versionId) query.version = entityRef.versionId;
  if (type === "APPROVAL_REQUEST") query.panel = "governance";

  const { domainSlug, productSlug } = entityRef;
  // undefined = the notification was never resolved to route slugs (null is a
  // resolved tenant-level entity), so there is no entity route to build.
  if (domainSlug === undefined || productSlug === undefined) return null;

  const entitySlug = entityRef.entitySlug ?? entityRef.entityId;
  if (entityRef.fieldId) {
    return assetHref(
      {
        kind: "field",
        entitySlug,
        fieldId: entityRef.fieldSlug ?? entityRef.fieldId,
        domainSlug,
        productSlug,
      },
      { query }
    );
  }
  return assetHref({ kind: "entity", slug: entitySlug, domainSlug, productSlug }, { query });
}

/**
 * Hook that manages notification center state, polling, and actions.
 *
 * For MVP this uses the in-memory notification service via API routes.
 * In production this would use TanStack Query with oRPC.
 */
export function useNotificationCenter() {
  const [notifications, setNotifications] = useState<NotificationItemData[]>(
    []
  );
  const [unreadCount, setUnreadCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // -------------------------------------------------------------------------
  // Fetch notifications
  // -------------------------------------------------------------------------

  const fetchNotifications = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/v1/notifications?pageSize=${MAX_NOTIFICATIONS}`
      );
      if (!res.ok) return;
      const json = await res.json();
      if (json.success && json.data) {
        const items: NotificationItemData[] = json.data.notifications.map(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (n: any) => ({
            ...n,
            createdAt: new Date(n.createdAt),
          })
        );
        setNotifications(items);
        setUnreadCount(json.data.unreadCount);
      }
    } catch {
      // Silently fail — polling will retry
    }
  }, []);

  const fetchUnreadCount = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/notifications?countOnly=true`);
      if (!res.ok) return;
      const json = await res.json();
      if (json.success && json.data) {
        setUnreadCount(json.data.unreadCount);
      }
    } catch {
      // Silently fail
    }
  }, []);

  // -------------------------------------------------------------------------
  // Polling
  // -------------------------------------------------------------------------

  useEffect(() => {
    fetchUnreadCount();
    intervalRef.current = setInterval(fetchUnreadCount, POLL_INTERVAL_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchUnreadCount]);

  // Fetch full list when popover opens
  useEffect(() => {
    if (open) {
      setLoading(true);
      fetchNotifications().finally(() => setLoading(false));
    }
  }, [open, fetchNotifications]);

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  const markAsRead = useCallback(
    async (notificationId: string) => {
      // Optimistic update
      setNotifications((prev) =>
        prev.map((n) => (n.id === notificationId ? { ...n, read: true } : n))
      );
      setUnreadCount((prev) => Math.max(0, prev - 1));

      try {
        await fetch(
          `/api/v1/notifications?action=mark-read&id=${notificationId}`,
          { method: "POST" }
        );
      } catch {
        // Revert would go here in production
      }
    },
    []
  );

  const markAllAsRead = useCallback(async () => {
    // Optimistic update
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    setUnreadCount(0);

    try {
      await fetch(`/api/v1/notifications?action=mark-all-read`, {
        method: "POST",
      });
    } catch {
      // Revert would go here in production
    }
  }, []);

  // -------------------------------------------------------------------------
  // Grouping
  // -------------------------------------------------------------------------

  const groupedNotifications: NotificationGroup[] = NOTIFICATION_GROUPS.map(
    (group) => ({
      label: group.label,
      types: group.types,
      notifications: notifications.filter((n) =>
        (group.types as NotificationType[]).includes(n.type)
      ),
    })
  ).filter((group) => group.notifications.length > 0);

  // -------------------------------------------------------------------------
  // Navigation URL builder
  // -------------------------------------------------------------------------

  const getNavigationUrl = useCallback(getNotificationNavigationUrl, []);

  return {
    notifications,
    unreadCount,
    open,
    setOpen,
    loading,
    groupedNotifications,
    markAsRead,
    markAllAsRead,
    getNavigationUrl,
  };
}
