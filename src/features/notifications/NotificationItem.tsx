"use client";

import {
  Shield,
  CheckCircle,
  AtSign,
  AlertTriangle,
} from "lucide-react";
import type { NotificationItemData } from "@/components/custom/NotificationCenter/NotificationCenter.types";
import type { NotificationType } from "@/types/schemas/notification";

function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSeconds < 60) return "just now";
  if (diffMinutes < 60) return `${diffMinutes} min ago`;
  if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? "s" : ""} ago`;
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  return date.toLocaleDateString();
}

function getTypeIcon(type: NotificationType) {
  switch (type) {
    case "APPROVAL_REQUEST":
    case "APPROVAL_DECISION":
      return <Shield className="w-4 h-4 text-blue-400" />;
    case "CHANGE_COMPLETE":
      return <CheckCircle className="w-4 h-4 text-green-400" />;
    case "ANNOTATION_TAG":
    case "ANNOTATION_REPLY":
      return <AtSign className="w-4 h-4 text-purple-400" />;
    case "DRIFT_ALERT":
    case "COMPLIANCE_GAP":
      return <AlertTriangle className="w-4 h-4 text-amber-400" />;
  }
}

type NotificationItemProps = {
  notification: NotificationItemData;
  /** Omit for a notification with nowhere to navigate; it then renders non-interactive. */
  onClick?: (notification: NotificationItemData) => void;
};

export function NotificationItem({
  notification,
  onClick,
}: NotificationItemProps) {
  const className = "w-full flex items-start gap-2 px-3 py-2 text-left rounded-md";
  const content = (
    <>
      {/* Unread dot */}
      <div className="flex-shrink-0 mt-1.5 w-2">
        {!notification.read && (
          <span
            data-testid="unread-indicator"
            className="block w-2 h-2 rounded-full bg-primary"
          />
        )}
      </div>

      {/* Type icon */}
      <div className="flex-shrink-0 mt-0.5">
        {getTypeIcon(notification.type)}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground truncate">
          {notification.title}
        </p>
        <p className="text-xs text-muted-foreground line-clamp-2">
          {notification.body}
        </p>
      </div>

      {/* Timestamp */}
      <span className="flex-shrink-0 text-[10px] text-muted-foreground mt-0.5">
        {formatRelativeTime(notification.createdAt)}
      </span>
    </>
  );

  if (!onClick) {
    return (
      <div data-testid={`notification-item-${notification.id}`} className={className}>
        {content}
      </div>
    );
  }

  return (
    <button
      data-testid={`notification-item-${notification.id}`}
      className={`${className} hover:bg-accent/30 transition-colors`}
      onClick={() => onClick(notification)}
    >
      {content}
    </button>
  );
}
