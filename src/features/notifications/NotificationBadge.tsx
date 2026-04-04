"use client";

import { Bell } from "lucide-react";

type NotificationBadgeProps = {
  count: number;
  onClick: () => void;
};

export function NotificationBadge({ count, onClick }: NotificationBadgeProps) {
  const displayCount = count > 9 ? "9+" : String(count);

  return (
    <div
      data-testid="notification-bell"
      className="relative p-1.5 rounded-lg hover:bg-accent animate-field-hover cursor-pointer"
      onClick={onClick}
      role="button"
      tabIndex={0}
      aria-label={`Notifications${count > 0 ? ` (${count} unread)` : ""}`}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onClick(); }}
    >
      <Bell className="w-5 h-5 text-muted-foreground" />
      {count > 0 && (
        <span
          data-testid="notification-badge"
          className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] bg-destructive rounded-full flex items-center justify-center px-1"
        >
          <span className="text-[11px] text-destructive-foreground font-medium leading-none">
            {displayCount}
          </span>
        </span>
      )}
    </div>
  );
}
