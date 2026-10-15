"use client";

import { useEffect, useRef } from "react";
import { CheckCircle, Bell } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  NotificationItem,
  NotificationGroupHeader,
} from "@/features/notifications";
import { useNotificationCenter } from "./useNotificationCenter";
import type { NotificationItemData } from "./NotificationCenter.types";

export function NotificationCenter() {
  const {
    unreadCount,
    open,
    setOpen,
    loading,
    groupedNotifications,
    markAsRead,
    markAllAsRead,
    getNavigationUrl,
  } = useNotificationCenter();

  const router = useRouter();
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEsc);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEsc);
    };
  }, [open, setOpen]);

  const handleNotificationClick = async (
    notification: NotificationItemData
  ) => {
    const url = getNavigationUrl(notification);
    if (!url) return;
    if (!notification.read) {
      await markAsRead(notification.id);
    }
    setOpen(false);
    router.push(url);
  };

  const hasNotifications = groupedNotifications.length > 0;
  const displayCount = unreadCount > 9 ? "9+" : String(unreadCount);

  return (
    <div className="relative" ref={panelRef}>
      {/* Trigger button */}
      <button
        data-testid="notification-bell"
        className="relative p-1.5 rounded-lg hover:bg-accent transition-colors"
        onClick={() => setOpen(!open)}
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ""}`}
      >
        <Bell className="w-5 h-5 text-muted-foreground" />
        {unreadCount > 0 && (
          <span
            data-testid="notification-badge"
            className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] bg-destructive rounded-full flex items-center justify-center px-1"
          >
            <span className="text-[11px] text-destructive-foreground font-medium leading-none">
              {displayCount}
            </span>
          </span>
        )}
      </button>

      {/* Dropdown panel */}
      {open && (
        <div className="absolute right-0 top-full mt-2 z-50 w-80 max-h-[480px] flex flex-col rounded-xl border border-border/50 bg-popover/95 backdrop-blur-xl shadow-lg overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border/50">
            <h3 className="text-sm font-semibold text-foreground">
              Notifications
            </h3>
            {unreadCount > 0 && (
              <button
                data-testid="mark-all-read"
                onClick={markAllAsRead}
                className="text-xs text-primary hover:text-primary/80 transition-colors"
              >
                Mark all as read
              </button>
            )}
          </div>

          {/* Notification list */}
          <div
            data-testid="notification-list"
            className="flex-1 overflow-y-auto min-h-0"
          >
            {loading && (
              <div className="flex items-center justify-center py-8">
                <span className="text-xs text-muted-foreground">Loading...</span>
              </div>
            )}

            {!loading && !hasNotifications && (
              <div
                data-testid="empty-state"
                className="flex flex-col items-center justify-center py-12 gap-3"
              >
                <CheckCircle className="w-12 h-12 text-green-400" />
                <p className="text-sm text-muted-foreground">
                  All caught up — no pending actions
                </p>
              </div>
            )}

            {!loading &&
              hasNotifications &&
              groupedNotifications.map((group) => (
                <div key={group.label}>
                  <NotificationGroupHeader
                    label={group.label}
                    count={group.notifications.length}
                  />
                  {group.notifications.map((notification) => (
                    <NotificationItem
                      key={notification.id}
                      notification={notification}
                      // Only a notification that resolves to a real URL is clickable.
                      onClick={
                        getNavigationUrl(notification) ? handleNotificationClick : undefined
                      }
                    />
                  ))}
                </div>
              ))}
          </div>

          {/* Footer */}
          <div className="border-t border-border/50 px-4 py-2">
            <Link
              href="/notifications"
              onClick={() => setOpen(false)}
              className="text-xs text-primary hover:text-primary/80 transition-colors"
            >
              View All
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
