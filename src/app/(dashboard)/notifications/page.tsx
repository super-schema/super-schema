"use client";

import { useEffect, useState, useCallback } from "react";
import {
  Shield,
  CheckCircle,
  AtSign,
  AlertTriangle,
} from "lucide-react";
import type { NotificationItemData } from "@/components/custom/NotificationCenter/NotificationCenter.types";
import type { NotificationType } from "@/types/schemas/notification";

function getTypeLabel(type: NotificationType): string {
  const labels: Record<NotificationType, string> = {
    APPROVAL_REQUEST: "Approval Request",
    APPROVAL_DECISION: "Approval Decision",
    CHANGE_COMPLETE: "Change Complete",
    DRIFT_ALERT: "Drift Alert",
    ANNOTATION_TAG: "Mention",
    ANNOTATION_REPLY: "Reply",
    COMPLIANCE_GAP: "Compliance Gap",
  };
  return labels[type];
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

export default function NotificationsPage() {
  const [notifications, setNotifications] = useState<NotificationItemData[]>(
    []
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterType, setFilterType] = useState<string>("");
  const [filterRead, setFilterRead] = useState<string>("");
  const [page, setPage] = useState(1);
  const pageSize = 25;

  const fetchNotifications = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("pageSize", String(pageSize));
      if (filterType) params.set("types", filterType);
      if (filterRead) params.set("read", filterRead);

      const res = await fetch(`/api/v1/notifications?${params.toString()}`);
      if (!res.ok) {
        setError(`Failed to load notifications (${res.status})`);
        setNotifications([]);
        return;
      }
      const json = await res.json();
      if (json.success && json.data) {
        setNotifications(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          json.data.notifications.map((n: any) => ({
            ...n,
            createdAt: new Date(n.createdAt),
          }))
        );
      } else {
        setError(json.error?.message ?? "Failed to load notifications");
        setNotifications([]);
      }
    } catch {
      setError("Network error — could not load notifications");
      setNotifications([]);
    } finally {
      setLoading(false);
    }
  }, [page, filterType, filterRead]);

  useEffect(() => {
    fetchNotifications();
  }, [fetchNotifications]);

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <h1 className="text-heading-2 font-semibold mb-6">
        Notification History
      </h1>

      {error && (
        <div
          role="alert"
          data-testid="notifications-error"
          className="mb-4 rounded-lg border border-destructive bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      )}

      {/* Filters */}
      <div className="flex gap-4 mb-4">
        <select
          data-testid="notification-filter-type"
          aria-label="Type"
          value={filterType}
          onChange={(e) => {
            setFilterType(e.target.value);
            setPage(1);
          }}
          className="bg-muted border border-border rounded-lg px-3 py-1.5 text-sm"
        >
          <option value="">All Types</option>
          <option value="APPROVAL_REQUEST">Approval Request</option>
          <option value="APPROVAL_DECISION">Approval Decision</option>
          <option value="CHANGE_COMPLETE">Change Complete</option>
          <option value="DRIFT_ALERT">Drift Alert</option>
          <option value="ANNOTATION_TAG">Mention</option>
          <option value="ANNOTATION_REPLY">Reply</option>
          <option value="COMPLIANCE_GAP">Compliance Gap</option>
        </select>

        <select
          data-testid="notification-filter-read"
          aria-label="Status"
          value={filterRead}
          onChange={(e) => {
            setFilterRead(e.target.value);
            setPage(1);
          }}
          className="bg-muted border border-border rounded-lg px-3 py-1.5 text-sm"
        >
          <option value="">All Status</option>
          <option value="false">Unread</option>
          <option value="true">Read</option>
        </select>
      </div>

      {/* Table */}
      <div className="border border-border rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/50">
              <th className="text-left px-4 py-3 font-medium">Type</th>
              <th className="text-left px-4 py-3 font-medium">Title</th>
              <th className="text-left px-4 py-3 font-medium">Body</th>
              <th className="text-left px-4 py-3 font-medium">Date</th>
              <th className="text-left px-4 py-3 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={5} className="text-center py-8 text-muted-foreground">
                  Loading...
                </td>
              </tr>
            )}
            {!loading && notifications.length === 0 && (
              <tr>
                <td colSpan={5} className="text-center py-8 text-muted-foreground">
                  No notifications found.
                </td>
              </tr>
            )}
            {!loading &&
              notifications.map((n) => (
                <tr
                  key={n.id}
                  data-testid="notification-row"
                  data-title={n.title}
                  data-read={n.read ? "true" : "false"}
                  className="border-t border-border/50 hover:bg-accent/20"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {getTypeIcon(n.type)}
                      <span>{getTypeLabel(n.type)}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 font-medium">{n.title}</td>
                  <td className="px-4 py-3 text-muted-foreground max-w-xs truncate">
                    {n.body}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                    {n.createdAt.toLocaleString()}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`inline-block px-2 py-0.5 rounded-full text-xs ${
                        n.read
                          ? "bg-muted text-muted-foreground"
                          : "bg-primary/20 text-primary"
                      }`}
                    >
                      {n.read ? "Read" : "Unread"}
                    </span>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex justify-between items-center mt-4">
        <button
          data-testid="notifications-previous"
          onClick={() => setPage((p) => Math.max(1, p - 1))}
          disabled={page === 1}
          className="px-3 py-1.5 text-sm border border-border rounded-lg disabled:opacity-50"
        >
          Previous
        </button>
        <span data-testid="notifications-page" className="text-sm text-muted-foreground">Page {page}</span>
        <button
          data-testid="notifications-next"
          onClick={() => setPage((p) => p + 1)}
          disabled={notifications.length < pageSize}
          className="px-3 py-1.5 text-sm border border-border rounded-lg disabled:opacity-50"
        >
          Next
        </button>
      </div>
    </div>
  );
}
