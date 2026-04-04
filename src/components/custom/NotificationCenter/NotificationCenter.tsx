"use client";

import { CheckCircle } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  NotificationBadge,
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

  const handleNotificationClick = async (
    notification: NotificationItemData
  ) => {
    if (!notification.read) {
      await markAsRead(notification.id);
    }
    const url = getNavigationUrl(notification);
    setOpen(false);
    router.push(url);
  };

  const hasNotifications = groupedNotifications.length > 0;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger>
        <NotificationBadge count={unreadCount} onClick={() => setOpen(!open)} />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-80 max-h-[480px] flex flex-col p-0 bg-popover/95 backdrop-blur-xl border border-border/50"
      >
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
                    onClick={handleNotificationClick}
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
      </PopoverContent>
    </Popover>
  );
}
